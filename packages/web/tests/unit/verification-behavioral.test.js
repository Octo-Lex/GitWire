// tests/unit/verification-behavioral.test.js
// Behavioral tests for the verification result recording pipeline.
// Uses actual exported functions with mocked db and durable artifact table simulation.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

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
  recordVerificationResult,
  attachEvidence,
  transitionProposal,
  contentHash,
} = await import("../../src/services/repairProposalService.js");
const { ACTOR_KINDS } = await import("../../src/services/repairAuthorityService.js");
const { storeArtifact } = await import("../../src/lib/patchArtifactStore.js");
const { db } = await import("../../src/lib/db.js");
const {
  buildValidationPlan,
  computeVerificationFingerprint,
  validateCommandSet,
  runSandboxVerification,
  buildExecutionReceipt,
  SANDBOX_IMAGE_DIGEST,
} = await import("../../src/lib/sandboxRunner.js");

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const HEAD_SHA = "abc123def456";
const ARTIFACT_HASH = "sha256:fakeartifact00000000000000000000000000000000000000000000000000";
const INPUT_BUNDLE_HASH = "sha256:fakebundle000000000000000000000000000000000000000000000000000";
const VALIDATION_PLAN_HASH = "sha256:fakeplan0000000000000000000000000000000000000000000000000000";

const DIAGNOSIS = {
  summary: "Build failed",
  failure_category: "dependency_error",
  confidence: "medium",
  evidence_ids: ["github:workflow_run:123"],
};

const PATCH_PROPOSAL_BASE = {
  base_sha: HEAD_SHA,
  input_bundle_hash: INPUT_BUNDLE_HASH,
  total_files: 1,
  total_changed_lines: 1,
};

const TASK_ENVELOPE = {
  source: { repository: "test/repo" },
  risk: { can_write_repository: false, max_files: 5, max_changed_lines: 100 },
  blocked_paths: ["secrets/**"],
  required_validation: ["lint", "test"],
};

// ════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ════════════════════════════════════════════════════════════════════════════

const artifactTable = new Map();
const receiptTable = new Map();

let realArtifactHash = null;
let realArtifactRef = null;

async function setupArtifact() {
  const content = JSON.stringify({
    base_sha: HEAD_SHA,
    files: [{ path: "src/example.js", change_type: "fix", edits: [{ line_start: 1, line_end: 1, new_content: "// fix" }] }],
  });
  // Compute real hash
  const crypto = await import("crypto");
  realArtifactHash = "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
  realArtifactRef = `artifact:${realArtifactHash}`;
  artifactTable.set(realArtifactHash, { ref: realArtifactRef, content });
  return { hash: realArtifactHash, ref: realArtifactRef };
}

function createMockProposal(overrides = {}) {
  const patchProposal = {
    ...PATCH_PROPOSAL_BASE,
    artifact_ref: realArtifactRef || `artifact:${ARTIFACT_HASH}`,
    artifact_hash: realArtifactHash || ARTIFACT_HASH,
  };
  return {
    id: 1,
    version: 1,
    status: "proposed",
    repo_full_name: "test/repo",
    head_sha: HEAD_SHA,
    diagnosis: JSON.stringify(DIAGNOSIS),
    patch_proposal: JSON.stringify(patchProposal),
    validation_result: null,
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
      if (sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: [baseProposal] });
      }
      if (sql.includes("UPDATE repair_proposals")) {
        return Promise.resolve({ rows: [updatedProposal] });
      }
      if (sql.includes("INSERT INTO repair_proposal_events")) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

function setupDbQueryMock(baseProposal) {
  db.query.mockImplementation(async (sql, params = []) => {
    // Artifact table: SELECT
    if (sql.includes("SELECT") && sql.includes("patch_artifacts")) {
      const ref = params[0];
      for (const [, entry] of artifactTable) {
        if (entry.ref === ref) {
          return { rows: [{ content: entry.content }] };
        }
      }
      return { rows: [] };
    }
    // Execution receipts table: SELECT
    if (sql.includes("SELECT") && sql.includes("execution_receipts")) {
      const ref = params[0];
      for (const [, entry] of receiptTable) {
        if (entry.ref === ref) {
          return { rows: [{ content: entry.content }] };
        }
      }
      return { rows: [] };
    }
    // Proposal lookup
    if (sql.includes("SELECT") && sql.includes("repair_proposals") && !sql.includes("repair_proposal_events")) {
      return { rows: [baseProposal] };
    }
    return { rows: [] };
  });
}

function computeValidFingerprint() {
  return computeVerificationFingerprint({
    patch_artifact_hash: ARTIFACT_HASH,
    base_sha: HEAD_SHA,
    input_bundle_hash: INPUT_BUNDLE_HASH,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: VALIDATION_PLAN_HASH,
  });
}

async function createValidVerificationInput(overrides = {}) {
  const { hash } = await setupArtifact();
  const plan = buildValidationPlan(TASK_ENVELOPE);
  return {
    overall: "pass",
    verification_fingerprint: computeVerificationFingerprint({
      patch_artifact_hash: hash,
      base_sha: HEAD_SHA,
      input_bundle_hash: INPUT_BUNDLE_HASH,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: plan.validation_plan_hash,
    }),
    patch_artifact_hash: hash,
    base_sha: HEAD_SHA,
    input_bundle_hash: INPUT_BUNDLE_HASH,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: plan.validation_plan_hash,
    commands: plan.commands.map((cmd) => ({
      command: cmd,
      exit_status: 0,
      output_ref: `sandbox-output:sha256:${cmd}`,
      output_hash: `sha256:${cmd}`,
    })),
    exit_status: 0,
    output_refs: plan.commands.map((c) => `sandbox-output:sha256:${c}`),
    output_hashes: plan.commands.map((c) => `sha256:${c}`),
    redacted_summary: "2 validation commands executed — all passed",
    limits_applied: { cpu_shares: 512, memory_mb: 512 },
    ...overrides,
  };
}

async function createInconclusiveVerificationInput(overrides = {}) {
  const { hash } = await setupArtifact();
  const plan = buildValidationPlan(TASK_ENVELOPE);
  return {
    overall: "inconclusive",
    verification_fingerprint: computeVerificationFingerprint({
      patch_artifact_hash: hash,
      base_sha: HEAD_SHA,
      input_bundle_hash: INPUT_BUNDLE_HASH,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: plan.validation_plan_hash,
    }),
    patch_artifact_hash: hash,
    base_sha: HEAD_SHA,
    input_bundle_hash: INPUT_BUNDLE_HASH,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: plan.validation_plan_hash,
    commands: plan.commands.map((cmd) => ({
      command: cmd,
      exit_status: null,
      output_ref: null,
      output_hash: null,
    })),
    exit_status: null,
    output_refs: [],
    output_hashes: [],
    redacted_summary: "executor returned inconclusive",
    inconclusive_reason: "executor_error",
    limits_applied: { cpu_shares: 512, memory_mb: 512 },
    ...overrides,
  };
}

async function createValidFailInput(overrides = {}) {
  const { hash } = await setupArtifact();
  const plan = buildValidationPlan(TASK_ENVELOPE);
  const commands = plan.commands.map((cmd) => ({
    command: cmd,
    exit_status: 0,
    output_ref: `sandbox-output:sha256:${cmd}`,
    output_hash: `sha256:${cmd}`,
  }));
  // Make first command fail so overall:fail is consistent
  commands[0] = { ...commands[0], exit_status: 1 };
  return {
    overall: "fail",
    verification_fingerprint: computeVerificationFingerprint({
      patch_artifact_hash: hash,
      base_sha: HEAD_SHA,
      input_bundle_hash: INPUT_BUNDLE_HASH,
      sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
      validation_plan_hash: plan.validation_plan_hash,
    }),
    patch_artifact_hash: hash,
    base_sha: HEAD_SHA,
    input_bundle_hash: INPUT_BUNDLE_HASH,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: plan.validation_plan_hash,
    commands,
    exit_status: 1,
    output_refs: commands.map((c) => c.output_ref),
    output_hashes: commands.map((c) => c.output_hash),
    redacted_summary: "1 command failed",
    limits_applied: { cpu_shares: 512, memory_mb: 512 },
    ...overrides,
  };
}

beforeEach(async () => {
  artifactTable.clear();
  receiptTable.clear();
  realArtifactHash = null;
  realArtifactRef = null;
  await setupArtifact();
  mockClient = createMockClient();
  db.query.mockClear();
  setupDbQueryMock(createMockProposal());
});

// ════════════════════════════════════════════════════════════════════════════
// PASS RESULTS REJECTED (P0 — no execution backend)
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — pass results require execution receipt", () => {
  it("rejects overall:pass without execution_receipt_ref/hash", async () => {
    await expect(
      recordVerificationResult(1, await createValidVerificationInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
        correlation_id: "corr-1",
      })
    ).rejects.toThrow(/execution_receipt_ref and execution_receipt_hash are required/);
  });

  it("rejects pass before any UPDATE or event INSERT", async () => {
    try {
      await recordVerificationResult(1, await createValidVerificationInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      });
    } catch (_e) {
      // expected
    }

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VALID FAIL/INCONCLUSIVE RECORDING
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — valid fail/inconclusive recording", () => {
  it("emits one UPDATE and one INSERT event for fail", async () => {
    const input = await createValidVerificationInput({ overall: "fail", exit_status: 1 });
    input.commands[0] = { ...input.commands[0], exit_status: 1 };

    await recordVerificationResult(1, input, {
      actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
      expected_version: 1,
    });

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );

    expect(updateCalls).toHaveLength(1);
    expect(insertCalls).toHaveLength(1);
  });

  it("fail INSERT event is verification_result_recorded with proposed → failed", async () => {
    const input = await createValidVerificationInput({ overall: "fail", exit_status: 1 });
    input.commands[0] = { ...input.commands[0], exit_status: 1 };

    await recordVerificationResult(1, input, {
      actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    const params = insertCalls[0][1];
    expect(params[1]).toBe("verification_result_recorded");
    expect(params[2]).toBe("proposed");
    expect(params[3]).toBe("failed");
  });

  it("inconclusive result transitions to failed", async () => {
    const input = await createInconclusiveVerificationInput();

    await recordVerificationResult(1, input, {
      actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    const params = insertCalls[0][1];
    expect(params[3]).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REJECTION CASES
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — rejection cases", () => {
  it("rejects missing patch_proposal", async () => {
    mockClient = createMockClient({ patch_proposal: null });

    await expect(
      recordVerificationResult(1, await createValidFailInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/patch_proposal must exist before verification/);
  });

  it("rejects wrong status (evidence_collected)", async () => {
    mockClient = createMockClient({ status: "evidence_collected" });

    await expect(
      recordVerificationResult(1, await createValidFailInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Verification requires status 'proposed', got 'evidence_collected'/);
  });

  it("rejects mismatched patch_artifact_hash", async () => {
    await expect(
      recordVerificationResult(1, await createValidFailInput({
        patch_artifact_hash: "sha256:wrong",
      }), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/patch_artifact_hash does not match locked/);
  });

  it("rejects mismatched base_sha", async () => {
    await expect(
      recordVerificationResult(1, await createValidFailInput({
        base_sha: "wrongsha",
      }), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/base_sha.*does not match proposal head_sha/);
  });

  it("rejects mismatched input_bundle_hash", async () => {
    await expect(
      recordVerificationResult(1, await createValidFailInput({
        input_bundle_hash: "sha256:wrong",
      }), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/input_bundle_hash does not match locked/);
  });

  it("rejects unresolvable artifact", async () => {
    artifactTable.clear(); // Clear all artifacts
    const input = await createValidFailInput();
    artifactTable.clear(); // Clear again after input creation stores it

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/artifact.*failed/);
  });

  it("rejects mismatched fingerprint", async () => {
    await expect(
      recordVerificationResult(1, await createValidFailInput({
        verification_fingerprint: "sha256:wrongfingerprint",
      }), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/fingerprint mismatch/);
  });

  it("rejects missing required command", async () => {
    const input = await createValidFailInput();
    // Remove one command from the executed set
    input.commands = input.commands.slice(0, 1);

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Missing required validation command/);
  });

  it("rejects disallowed command", async () => {
    const input = await createValidFailInput();
    input.commands = [...input.commands, { command: "rm -rf /", exit_status: 0, output_ref: "x", output_hash: "sha256:x" }];

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Disallowed validation command/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0: CONTRADICTORY RESULT PAYLOADS
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — contradictory result payloads (P0)", () => {
  // pass results without a receipt are rejected before consistency checks.
  it("rejects overall:pass with failing command exit_status (missing receipt)", async () => {
    const input = await createValidVerificationInput();
    input.commands[0] = { ...input.commands[0], exit_status: 1 };

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/execution_receipt_ref and execution_receipt_hash are required/);
  });

  it("rejects overall:pass with non-zero aggregate exit_status (missing receipt)", async () => {
    const input = await createValidVerificationInput({ exit_status: 1 });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/execution_receipt_ref and execution_receipt_hash are required/);
  });

  it("rejects overall:fail with all commands passing", async () => {
    const input = await createValidVerificationInput({
      overall: "fail",
      // commands still have exit_status: 0 and aggregate 0
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Failed verification requires at least one failing command/);
  });

  it("rejects inconclusive without inconclusive_reason", async () => {
    const input = await createInconclusiveVerificationInput();
    delete input.inconclusive_reason;

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Inconclusive verification requires a structured inconclusive_reason/);
  });

  it("inconclusive with reason transitions to failed", async () => {
    const input = await createInconclusiveVerificationInput();

    const result = await recordVerificationResult(1, input, {
      actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    const params = insertCalls[0][1];
    expect(params[3]).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1: CANONICAL PLAN HASH AND IMAGE DIGEST
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — canonical plan hash and image digest (P1)", () => {
  it("rejects wrong validation_plan_hash", async () => {
    const input = await createValidFailInput({
      validation_plan_hash: "sha256:wrongplanhash",
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/validation_plan_hash does not match canonical plan/);
  });

  it("rejects wrong sandbox_image_digest", async () => {
    const input = await createValidFailInput({
      sandbox_image_digest: "sha256:wrongimage",
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/sandbox_image_digest does not match.*approved pinned/);
  });

  it("rejects correct commands but altered image digest", async () => {
    const input = await createValidFailInput({
      sandbox_image_digest: "sha256:evil-image",
      verification_fingerprint: computeVerificationFingerprint({
        patch_artifact_hash: input_hash(),
        base_sha: HEAD_SHA,
        input_bundle_hash: INPUT_BUNDLE_HASH,
        sandbox_image_digest: "sha256:evil-image",
        validation_plan_hash: buildValidationPlan(TASK_ENVELOPE).validation_plan_hash,
      }),
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/sandbox_image_digest does not match.*approved pinned/);
  });
});

// Helper for the test above
function input_hash() {
  return realArtifactHash;
}

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — replay safety", () => {
  it("same fingerprint on already-verified → no-op return", async () => {
    const input = await createValidFailInput();
    const existingResult = { ...input, verification_fingerprint: input.verification_fingerprint };
    mockClient = createMockClient({
      status: "verified",
      validation_result: JSON.stringify(existingResult),
    });

    const result = await recordVerificationResult(1, input, {
      actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
      expected_version: 1,
    });

    expect(result).toBeDefined();

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("different fingerprint on already-verified → rejects", async () => {
    mockClient = createMockClient({
      status: "verified",
      validation_result: JSON.stringify({ verification_fingerprint: "sha256:different" }),
    });

    await expect(
      recordVerificationResult(1, await createValidFailInput(), {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/different fingerprint.*revision contract/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — authority enforcement", () => {
  it("verification_worker cannot attach diagnosis via attachEvidence", async () => {
    await expect(
      attachEvidence(
        1,
        { diagnosis: { summary: "x", failure_category: "x", evidence_ids: ["a"] } },
        "verification_worker",
        1,
        null,
        ACTOR_KINDS.VERIFICATION_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: diagnosis/);
  });

  it("attachEvidence rejects validation_result regardless of actor", async () => {
    await expect(
      attachEvidence(
        1,
        { validation_result: { overall: "pass", checks: [{ name: "x", passed: true, output_hash: "sha256:x" }] } },
        "verification_worker",
        1,
        null,
        ACTOR_KINDS.VERIFICATION_WORKER
      )
    ).rejects.toThrow(/validation_result may only be recorded by recordVerificationResult/);
  });

  it("generic transition to verified rejects", async () => {
    await expect(
      transitionProposal(1, {
        status: "verified",
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/requires a dedicated authority-bound endpoint/);
  });

  it("invalid actor_kind rejects", async () => {
    await expect(
      recordVerificationResult(1, await createValidVerificationInput(), {
        expected_version: 1,
        actor_kind: "invalid_kind",
      })
    ).rejects.toThrow(/actor_kind is required/);
  });

  it("diagnosis_worker cannot call recordVerificationResult", async () => {
    await expect(
      recordVerificationResult(1, await createValidVerificationInput(), {
        actor_kind: ACTOR_KINDS.DIAGNOSIS_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/not authorized to attach validation_result/);
  });

  it("patch_worker cannot call recordVerificationResult", async () => {
    await expect(
      recordVerificationResult(1, await createValidVerificationInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/not authorized to attach validation_result/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX RUNNER — pure functions
// ════════════════════════════════════════════════════════════════════════════

describe("Verification behavioral — sandbox runner", () => {
  it("buildValidationPlan derives commands from required_validation", () => {
    const plan = buildValidationPlan({ required_validation: ["test", "lint"] });
    expect(plan.commands).toEqual(["lint", "test"]); // sorted
    expect(plan.validation_plan_hash).toMatch(/^sha256:/);
  });

  it("buildValidationPlan rejects shell metacharacters", () => {
    expect(() =>
      buildValidationPlan({ required_validation: ["test; rm -rf /"] })
    ).toThrow(/shell metacharacters/);
  });

  it("validateCommandSet passes when all required commands present", () => {
    const result = validateCommandSet(["lint", "test"], ["lint", "test"]);
    expect(result.valid).toBe(true);
  });

  it("validateCommandSet fails when required command missing", () => {
    const result = validateCommandSet(["lint"], ["lint", "test"]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Missing required.*test/);
  });

  it("validateCommandSet fails when disallowed command present", () => {
    const result = validateCommandSet(["lint", "test", "evil"], ["lint", "test"]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Disallowed.*evil/);
  });

  it("computeVerificationFingerprint is deterministic", () => {
    const params = {
      patch_artifact_hash: "sha256:abc",
      base_sha: "def",
      input_bundle_hash: "sha256:ghi",
      sandbox_image_digest: "sha256:jkl",
      validation_plan_hash: "sha256:mno",
    };
    const fp1 = computeVerificationFingerprint(params);
    const fp2 = computeVerificationFingerprint(params);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^sha256:/);
  });

  it("runSandboxVerification requires sourceFiles", async () => {
    const content = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{ path: "src/x.js", change_type: "fix", edits: [{ line_start: 1, line_end: 1, new_content: "// fix" }] }],
    });

    await expect(
      runSandboxVerification({
        artifactContent: content,
        base_sha: HEAD_SHA,
        taskEnvelope: TASK_ENVELOPE,
      })
    ).rejects.toThrow(/sourceFiles is required/);
  });

  it("runSandboxVerification rejects artifact with mismatched base_sha", async () => {
    const content = JSON.stringify({
      base_sha: "wrong",
      files: [{ path: "src/x.js", change_type: "fix", edits: [{ line_start: 1, line_end: 1, new_content: "// fix" }] }],
    });

    await expect(
      runSandboxVerification({
        artifactContent: content,
        base_sha: HEAD_SHA,
        taskEnvelope: TASK_ENVELOPE,
        sourceFiles: [{ path: "src/x.js", content: "original" }],
        source_snapshot_hash: "sha256:snapshot",
      })
    ).rejects.toThrow(/artifact base_sha.*does not match pinned base/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECEIPT-BACKED PASS → VERIFIED
// ════════════════════════════════════════════════════════════════════════════

/**
 * Store a pass receipt from node-executor in the mock receipt table.
 * These receipts are structurally valid but node-executor is NOT
 * pass-capable (ALLOWED_PASS_EXECUTION_BACKENDS is empty), so they
 * will be rejected at the pass-backend check.
 */
async function storeNodeExecutorPassReceipt(artifactHash, planHash, overrides = {}) {
  const params = {
    execution_backend_id: "node-executor",
    executor_version: "1.0.0",
    source_snapshot_hash: "sha256:snapshot123",
    patch_artifact_hash: artifactHash,
    base_sha: HEAD_SHA,
    input_bundle_hash: INPUT_BUNDLE_HASH,
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: planHash,
    commands_executed: ["lint", "test"],
    per_command_exit_statuses: [0, 0],
    aggregate_exit_status: 0,
    output_refs: ["output:sha256:out1", "output:sha256:out2"],
    output_hashes: ["sha256:out1", "sha256:out2"],
    limits_applied: { cpu_shares: 512, memory_mb: 512 },
    result: "pass",
    ...overrides,
  };

  const receipt = buildExecutionReceipt(params);
  receiptTable.set(receipt.receipt_hash, {
    ref: receipt.receipt_ref,
    content: receipt.receipt_content,
  });

  return receipt;
}

// Keep backward-compatible alias
async function storeValidPassReceipt(artifactHash, planHash) {
  return storeNodeExecutorPassReceipt(artifactHash, planHash);
}

describe("Verification behavioral — node-executor pass receipts rejected (not isolated)", () => {
  it("rejects node-executor pass receipt (not pass-capable backend)", async () => {
    const { hash } = await setupArtifact();
    const plan = buildValidationPlan(TASK_ENVELOPE);
    const receipt = await storeNodeExecutorPassReceipt(hash, plan.validation_plan_hash);

    const input = await createValidVerificationInput({
      execution_receipt_ref: receipt.receipt_ref,
      execution_receipt_hash: receipt.receipt_hash,
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/node-executor.*not authorized to produce passing results/);
  });

  it("rejects node-executor pass before any UPDATE", async () => {
    const { hash } = await setupArtifact();
    const plan = buildValidationPlan(TASK_ENVELOPE);
    const receipt = await storeNodeExecutorPassReceipt(hash, plan.validation_plan_hash);

    const input = await createValidVerificationInput({
      execution_receipt_ref: receipt.receipt_ref,
      execution_receipt_hash: receipt.receipt_hash,
    });

    try {
      await recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      });
    } catch (_e) {}

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects pass with unresolvable receipt", async () => {
    const input = await createValidVerificationInput({
      execution_receipt_ref: "receipt:sha256:nonexistent",
      execution_receipt_hash: "sha256:nonexistent",
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/receipt.*not found|receipt resolution failed/i);
  });

  it("rejects pass receipt with result=fail", async () => {
    const { hash } = await setupArtifact();
    const plan = buildValidationPlan(TASK_ENVELOPE);
    const receipt = await storeNodeExecutorPassReceipt(hash, plan.validation_plan_hash, {
      per_command_exit_statuses: [1, 0],
      aggregate_exit_status: 1,
      result: "fail",
    });

    const input = await createValidVerificationInput({
      execution_receipt_ref: receipt.receipt_ref,
      execution_receipt_hash: receipt.receipt_hash,
    });

    await expect(
      recordVerificationResult(1, input, {
        actor_kind: ACTOR_KINDS.VERIFICATION_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/receipt result is 'fail', must be 'pass'/);
  });
});
