// tests/unit/critic-behavioral.test.js
// Behavioral tests for the critic review recording pipeline.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

// ════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ════════════════════════════════════════════════════════════════════════════

let mockClient;

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: {
    query: jest.fn(async () => ({ rows: [] })),
    transaction: jest.fn(async (fn) => fn(mockClient)),
  },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: jest.fn(async () => ({
    ci_healing: { enabled: true, auto_patch: true, min_confidence_to_patch: "medium" },
  })),
}));

const {
  recordCriticReview,
  attachEvidence,
  transitionProposal,
  contentHash,
  buildCriticInputBundle,
  computeReviewFingerprint,
  VALID_FINDING_CODES,
  VALID_FINDING_SEVERITIES,
} = await import("../../src/services/repairProposalService.js");
const { ACTOR_KINDS } = await import("../../src/services/repairAuthorityService.js");
const { db } = await import("../../src/lib/db.js");
const {
  assessCriticInput,
} = await import("../../src/services/criticWorkerService.js");
const { buildExecutionReceipt, buildValidationPlan, SANDBOX_IMAGE_DIGEST } = await import("../../src/lib/sandboxRunner.js");

// Receipt table for testing receipt-backed approval
const receiptTable = new Map();

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const HEAD_SHA = "abc123def456";
const ARTIFACT_HASH = "sha256:patch1234567890abcdef";
const INPUT_BUNDLE_HASH = "sha256:bundle1234567890abcdef";
const VERIFICATION_FINGERPRINT = "sha256:fingerprint1234567890ab";

const DIAGNOSIS = { summary: "Failed", failure_category: "dependency_error", confidence: "medium", evidence_ids: ["a"] };
const EVIDENCE_REFS = [{ type: "ci_job", source: "github:job:1", description: "Failed" }];
const PATCH_PROPOSAL = {
  artifact_ref: `artifact:${ARTIFACT_HASH}`,
  artifact_hash: ARTIFACT_HASH,
  base_sha: HEAD_SHA,
  input_bundle_hash: INPUT_BUNDLE_HASH,
};

const VALIDATION_RESULT_PASS = {
  overall: "pass",
  verification_fingerprint: VERIFICATION_FINGERPRINT,
  patch_artifact_hash: ARTIFACT_HASH,
};

const TASK_ENVELOPE = {
  source: { repository: "test/repo" },
  risk: { can_write_repository: false, max_files: 5, max_changed_lines: 100 },
  required_validation: ["lint", "test"],
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function createMockProposal(overrides = {}) {
  return {
    id: 1,
    version: 1,
    status: "verified",
    repo_full_name: "test/repo",
    head_sha: HEAD_SHA,
    evidence_refs: JSON.stringify(EVIDENCE_REFS),
    diagnosis: JSON.stringify(DIAGNOSIS),
    patch_proposal: JSON.stringify(PATCH_PROPOSAL),
    validation_result: JSON.stringify(VALIDATION_RESULT_PASS),
    critic_review: null,
    task_envelope: JSON.stringify(TASK_ENVELOPE),
    ...overrides,
  };
}

function createMockClient(proposalOverrides = {}) {
  const baseProposal = createMockProposal(proposalOverrides);
  const updatedProposal = { ...baseProposal, version: baseProposal.version + 1 };

  return {
    query: jest.fn().mockImplementation((sql) => {
      if (sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [baseProposal] });
      if (sql.includes("UPDATE repair_proposals")) return Promise.resolve({ rows: [updatedProposal] });
      if (sql.includes("INSERT INTO repair_proposal_events")) return Promise.resolve({ rows: [{ id: 1 }] });
      return Promise.resolve({ rows: [] });
    }),
  };
}

/**
 * Build a VALID reject review input with canonical hashes.
 * Uses the same shared helpers as the worker so values match.
 */
function createValidRejectInput(proposalOverrides = {}) {
  const proposal = createMockProposal(proposalOverrides);
  const bundle = buildCriticInputBundle(proposal);
  const criticInputHash = contentHash(bundle);
  const findings = [
    {
      code: "VALIDATION_RECEIPT_BOUND",
      severity: "blocking",
      detail: "No execution receipt on validation_result",
      evidence_ref: VERIFICATION_FINGERPRINT,
    },
  ];
  const blockingFindings = ["VALIDATION_RECEIPT_BOUND"];
  const reviewFingerprint = computeReviewFingerprint(
    criticInputHash, "reject", findings, blockingFindings, null
  );

  return {
    verdict: "reject",
    review_fingerprint: reviewFingerprint,
    critic_input_hash: criticInputHash,
    patch_artifact_hash: ARTIFACT_HASH,
    verification_fingerprint: VERIFICATION_FINGERPRINT,
    findings,
    blocking_findings: blockingFindings,
    risk_summary: "Blocked",
    limitations: "Stub",
    policy_version: null,
  };
}

beforeEach(() => {
  mockClient = createMockClient();
  receiptTable.clear();
  db.query.mockClear();
  // Set up db.query to serve receipts from the mock table
  db.query.mockImplementation(async (sql, params = []) => {
    if (sql.includes("SELECT") && sql.includes("execution_receipts")) {
      const ref = params[0];
      for (const [, entry] of receiptTable) {
        if (entry.ref === ref) {
          return { rows: [{ content: entry.content }] };
        }
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0: APPROVE UNCONDITIONALLY REJECTED (no receipt backend exists)
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — approve requires receipt on validation_result", () => {
  const approveInput = {
    verdict: "approve",
    review_fingerprint: "sha256:placeholder",  // receipt check happens before hash check
    critic_input_hash: "sha256:placeholder",
    patch_artifact_hash: "sha256:placeholder",
    verification_fingerprint: "sha256:placeholder",
    findings: [{ code: "PATCH_SCOPE_WITHIN_ENVELOPE", severity: "info", detail: "within scope" }],
    blocking_findings: [],
  };

  it("rejects approve when validation_result has no receipt", async () => {
    // validation_result has no execution_receipt_ref/hash
    await expect(
      recordCriticReview(1, approveInput, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/validation_result has no execution_receipt_ref\/hash/);
  });

  it("rejects approve with fabricated receipt fields (unresolvable receipt)", async () => {
    // Fabricated receipt reference+hash on validation_result
    // The receipt cannot be resolved from durable storage
    mockClient = createMockClient({
      validation_result: JSON.stringify({
        ...VALIDATION_RESULT_PASS,
        execution_receipt_hash: "sha256:fabricated_receipt",
        execution_receipt_ref: "receipt:fake-ref",
      }),
    });

    await expect(
      recordCriticReview(1, approveInput, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/receipt verification failed|receipt not found/i);

    // No UPDATE or INSERT should have run
    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("UPDATE repair_proposals"));
    expect(updateCalls).toHaveLength(0);
    const insertCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events"));
    expect(insertCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VALID REJECT RECORDING
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — valid reject recording", () => {
  it("reject with blocking findings transitions to failed", async () => {
    const input = createValidRejectInput();
    await recordCriticReview(1, input, {
      actor_kind: ACTOR_KINDS.CRITIC_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    const params = insertCalls[0][1];
    expect(params[3]).toBe("failed");
  });

  it("emits one UPDATE and one INSERT event", async () => {
    await recordCriticReview(1, createValidRejectInput(), {
      actor_kind: ACTOR_KINDS.CRITIC_WORKER,
      expected_version: 1,
    });

    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("UPDATE repair_proposals"));
    const insertCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events"));
    expect(updateCalls).toHaveLength(1);
    expect(insertCalls).toHaveLength(1);
  });

  it("INSERT event is critic_review_recorded from verified to failed", async () => {
    await recordCriticReview(1, createValidRejectInput(), {
      actor_kind: ACTOR_KINDS.CRITIC_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events"));
    const params = insertCalls[0][1];
    expect(params[1]).toBe("critic_review_recorded");
    expect(params[2]).toBe("verified");
    expect(params[3]).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1a: CANONICAL HASH RECOMPUTATION (not caller assertions)
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — P1a: canonical hash recomputation", () => {
  it("rejects mismatched critic_input_hash (caller assertion)", async () => {
    const input = createValidRejectInput();
    input.critic_input_hash = "sha256:wrong_hash_from_caller";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/critic_input_hash does not match canonical hash/);
  });

  it("rejects mismatched critic_input_hash before UPDATE and INSERT", async () => {
    const input = createValidRejectInput();
    input.critic_input_hash = "wrong";

    try {
      await recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      });
    } catch (_e) {}

    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("UPDATE repair_proposals"));
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects mismatched review_fingerprint (caller assertion)", async () => {
    const input = createValidRejectInput();
    input.review_fingerprint = "sha256:wrong_fingerprint";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/review_fingerprint does not match canonical fingerprint/);
  });

  it("rejects mismatched review_fingerprint before UPDATE and INSERT", async () => {
    const input = createValidRejectInput();
    input.review_fingerprint = "wrong";

    try {
      await recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      });
    } catch (_e) {}

    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("UPDATE repair_proposals"));
    expect(updateCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1b: FINDING SCHEMA, BLOCKING SEMANTICS, EVIDENCE BINDING
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — P1b: finding validation", () => {
  it("rejects finding with invalid code", async () => {
    const input = createValidRejectInput();
    input.findings[0].code = "INVALID_CODE";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/invalid or missing code/);
  });

  it("rejects finding with invalid severity", async () => {
    const input = createValidRejectInput();
    input.findings[0].severity = "critical";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/invalid or missing severity/);
  });

  it("rejects finding with empty detail", async () => {
    const input = createValidRejectInput();
    input.findings[0].detail = "  ";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/missing or empty detail/);
  });

  it("rejects approve verdict with blocking findings (contradictory)", async () => {
    // Build input as approve with blocking findings — should be rejected by
    // finding validation. The P0 gate rejects approve first, but if we could
    // bypass it, this would also catch the contradiction.
    // Since P0 rejects approve before validation, we test the validateCriticFindings
    // logic indirectly by testing reject without blocking findings.
    const input = createValidRejectInput();
    input.blocking_findings = []; // reject with no blocking findings

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/reject verdict requires at least one blocking finding/);
  });

  it("rejects blocking finding without matching finding code", async () => {
    const input = createValidRejectInput();
    // Add a blocking finding code that has no matching finding with severity blocking
    input.blocking_findings.push("UNSUPPORTED_REMEDIATION");
    // The matching finding for UNSUPPORTED_REMEDIATION doesn't exist in findings

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/no matching finding with severity: blocking/);
  });

  it("rejects finding evidence_ref not bound to locked bundle", async () => {
    const input = createValidRejectInput();
    input.findings[0].evidence_ref = "sha256:unbound_reference";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/evidence_ref is not bound to locked proposal bundle/);
  });

  it("accepts finding evidence_ref bound to patch_artifact_hash", async () => {
    const input = createValidRejectInput();
    input.findings[0].evidence_ref = ARTIFACT_HASH;
    // Recompute fingerprint since findings changed
    const bundle = buildCriticInputBundle(createMockProposal());
    const canonicalInputHash = contentHash(bundle);
    input.critic_input_hash = canonicalInputHash;
    input.review_fingerprint = computeReviewFingerprint(
      canonicalInputHash, "reject", input.findings, input.blocking_findings, null
    );

    const result = await recordCriticReview(1, input, {
      actor_kind: ACTOR_KINDS.CRITIC_WORKER,
      expected_version: 1,
    });

    expect(result).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REJECTION CASES
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — rejection cases", () => {
  it("rejects wrong status (proposed)", async () => {
    mockClient = createMockClient({ status: "proposed" });

    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Critic review requires status 'verified', got 'proposed'/);
  });

  it("rejects missing patch_proposal", async () => {
    mockClient = createMockClient({ patch_proposal: null });

    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/patch_proposal must exist/);
  });

  it("rejects missing validation_result", async () => {
    mockClient = createMockClient({ validation_result: null });

    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/validation_result must exist/);
  });

  it("rejects non-pass validation_result", async () => {
    mockClient = createMockClient({
      validation_result: JSON.stringify({ overall: "fail", verification_fingerprint: VERIFICATION_FINGERPRINT }),
    });

    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/validation_result\.overall must be 'pass'/);
  });

  it("rejects mismatched patch_artifact_hash", async () => {
    const input = createValidRejectInput();
    input.patch_artifact_hash = "sha256:wrong";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/patch_artifact_hash does not match locked/);
  });

  it("rejects mismatched verification_fingerprint", async () => {
    const input = createValidRejectInput();
    input.verification_fingerprint = "sha256:wrong";

    await expect(
      recordCriticReview(1, input, {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/verification_fingerprint does not match locked/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — replay safety", () => {
  it("same fingerprint on already-reviewed → no-op", async () => {
    const input = createValidRejectInput();
    const existingReview = { ...input, review_fingerprint: input.review_fingerprint };
    mockClient = createMockClient({
      status: "failed",
      critic_review: JSON.stringify(existingReview),
    });

    const result = await recordCriticReview(1, input, {
      actor_kind: ACTOR_KINDS.CRITIC_WORKER,
      expected_version: 1,
    });

    expect(result).toBeDefined();
    const updateCalls = mockClient.query.mock.calls.filter(([sql]) => sql && sql.includes("UPDATE repair_proposals"));
    expect(updateCalls).toHaveLength(0);
  });

  it("different fingerprint on already-reviewed → rejects", async () => {
    mockClient = createMockClient({
      status: "failed",
      critic_review: JSON.stringify({ review_fingerprint: "sha256:different" }),
    });

    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/different fingerprint/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — authority enforcement", () => {
  it("attachEvidence rejects critic_review regardless of actor", async () => {
    await expect(
      attachEvidence(
        1,
        { critic_review: { verdict: "approve", scope_assessment: "ok" } },
        "critic_worker",
        1,
        null,
        ACTOR_KINDS.CRITIC_WORKER
      )
    ).rejects.toThrow(/critic_review may only be recorded by recordCriticReview/);
  });

  it("generic transition to review_ready rejects", async () => {
    await expect(
      transitionProposal(1, {
        status: "review_ready",
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/requires a dedicated authority-bound endpoint/);
  });

  it("invalid actor_kind rejects", async () => {
    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        expected_version: 1,
        actor_kind: "invalid_kind",
      })
    ).rejects.toThrow(/actor_kind is required/);
  });

  it("verification_worker cannot call recordCriticReview", async () => {
    await expect(
      recordCriticReview(1, createValidRejectInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/not authorized to attach critic_review/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS — shared canonical builders
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — canonical pure functions", () => {
  it("buildCriticInputBundle extracts immutable references", () => {
    const proposal = createMockProposal();
    const bundle = buildCriticInputBundle(proposal);

    expect(bundle.proposal_id).toBe(1);
    expect(bundle.head_sha).toBe(HEAD_SHA);
    expect(bundle.patch_artifact_hash).toBe(ARTIFACT_HASH);
    expect(bundle.input_bundle_hash).toBe(INPUT_BUNDLE_HASH);
    expect(bundle.verification_fingerprint).toBe(VERIFICATION_FINGERPRINT);
    expect(bundle.diagnosis_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computeReviewFingerprint is deterministic and depends on all canonical inputs", () => {
    const bundle = buildCriticInputBundle(createMockProposal());
    const inputHash = contentHash(bundle);
    const findings = [
      { code: "VALIDATION_RECEIPT_BOUND", severity: "blocking" },
    ];
    const blocking = ["VALIDATION_RECEIPT_BOUND"];

    const fp1 = computeReviewFingerprint(inputHash, "reject", findings, blocking, null);
    const fp2 = computeReviewFingerprint(inputHash, "reject", findings, blocking, null);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);

    // Different verdict → different fingerprint
    const fp3 = computeReviewFingerprint(inputHash, "approve", findings, blocking, null);
    expect(fp3).not.toBe(fp1);

    // Different findings → different fingerprint
    const fp4 = computeReviewFingerprint(inputHash, "reject", [{ code: "BLOCKED_PATH_VIOLATION", severity: "blocking" }], ["BLOCKED_PATH_VIOLATION"], null);
    expect(fp4).not.toBe(fp1);
  });

  it("assessCriticInput always returns reject (deterministic stub)", () => {
    const bundle = buildCriticInputBundle(createMockProposal());
    const result = assessCriticInput(bundle);

    expect(result.verdict).toBe("reject");
    expect(result.blocking_findings).toContain("VALIDATION_RECEIPT_BOUND");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("blocking");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECEIPT-BACKED APPROVE → REVIEW_READY
// ════════════════════════════════════════════════════════════════════════════

describe("Critic behavioral — node-executor pass receipts rejected (not isolated)", () => {
  function storeValidPassReceipt() {
    const plan = buildValidationPlan(TASK_ENVELOPE);
    const params = {
      execution_backend_id: "node-executor",
      executor_version: "1.0.0",
      source_snapshot_hash: "sha256:snap123",
      patch_artifact_hash: ARTIFACT_HASH,
      base_sha: HEAD_SHA,
      input_bundle_hash: INPUT_BUNDLE_HASH,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: plan.validation_plan_hash,
      commands_executed: ["lint", "test"],
      per_command_exit_statuses: [0, 0],
      aggregate_exit_status: 0,
      output_refs: ["output:sha256:out1", "output:sha256:out2"],
      output_hashes: ["sha256:out1", "sha256:out2"],
      limits_applied: { cpu_shares: 512 },
      result: "pass",
    };
    const receipt = buildExecutionReceipt(params);
    receiptTable.set(receipt.receipt_hash, {
      ref: receipt.receipt_ref,
      content: receipt.receipt_content,
    });
    return receipt;
  }

  function createMockVerifiedProposalWithReceipt(receipt) {
    return createMockProposal({
      validation_result: JSON.stringify({
        ...VALIDATION_RESULT_PASS,
        execution_receipt_ref: receipt.receipt_ref,
        execution_receipt_hash: receipt.receipt_hash,
      }),
    });
  }

  function createValidApproveInput(proposal) {
    const bundle = buildCriticInputBundle(proposal);
    const criticInputHash = contentHash(bundle);
    const findings = [
      { code: "PATCH_SCOPE_WITHIN_ENVELOPE", severity: "info", detail: "within scope" },
    ];
    const blockingFindings = [];
    const reviewFingerprint = computeReviewFingerprint(
      criticInputHash, "approve", findings, blockingFindings, null
    );
    return {
      verdict: "approve",
      review_fingerprint: reviewFingerprint,
      critic_input_hash: criticInputHash,
      patch_artifact_hash: ARTIFACT_HASH,
      verification_fingerprint: VERIFICATION_FINGERPRINT,
      findings,
      blocking_findings: blockingFindings,
      risk_summary: "All clear",
      limitations: "Stub",
      policy_version: null,
    };
  }

  it("rejects node-executor approve receipt (not pass-capable)", async () => {
    const receipt = storeValidPassReceipt();
    const proposal = createMockVerifiedProposalWithReceipt(receipt);
    mockClient = createMockClient({
      validation_result: proposal.validation_result,
    });

    await expect(
      recordCriticReview(1, createValidApproveInput(proposal), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/node-executor.*not authorized to produce passing results/);

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects approve with failing receipt (result=fail)", async () => {
    const plan = buildValidationPlan(TASK_ENVELOPE);
    const params = {
      execution_backend_id: "node-executor",
      executor_version: "1.0.0",
      source_snapshot_hash: "sha256:fake",
      patch_artifact_hash: ARTIFACT_HASH,
      base_sha: HEAD_SHA,
      input_bundle_hash: INPUT_BUNDLE_HASH,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: plan.validation_plan_hash,
      commands_executed: ["lint", "test"],
      per_command_exit_statuses: [1, 0],
      aggregate_exit_status: 1,
      output_refs: ["output:sha256:o1", "output:sha256:o2"], output_hashes: ["sha256:o1", "sha256:o2"], limits_applied: {},
      result: "fail",
    };
    const receipt = buildExecutionReceipt(params);
    receiptTable.set(receipt.receipt_hash, { ref: receipt.receipt_ref, content: receipt.receipt_content });

    const proposal = createMockVerifiedProposalWithReceipt(receipt);
    mockClient = createMockClient({ validation_result: proposal.validation_result });

    await expect(
      recordCriticReview(1, createValidApproveInput(proposal), {
        actor_kind: ACTOR_KINDS.CRITIC_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Execution receipt result is 'fail', must be 'pass'/);
  });
});
