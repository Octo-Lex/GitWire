// tests/unit/patch-behavioral.test.js
// Behavioral tests for the patch proposal recording pipeline.
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
let mockConfig = {
  ci_healing: {
    enabled: true,
    auto_patch: true,
    min_confidence_to_patch: "medium",
  },
};

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
  getConfigForRepo: jest.fn(async () => mockConfig),
}));

const {
  recordPatchProposal,
  attachEvidence,
  transitionProposal,
  validatePatchEvidenceBinding,
  contentHash,
  buildPatchInputBundle,
  checkPatchPolicy,
} = await import("../../src/services/repairProposalService.js");
const { ACTOR_KINDS } = await import("../../src/services/repairAuthorityService.js");
const {
  generateCandidatePatch,
  generatePatchForProposal,
} = await import("../../src/services/patchWorkerService.js");
const { storeArtifact } = await import("../../src/lib/patchArtifactStore.js");
const { getConfigForRepo } = await import("../../src/services/configService.js");
const { db } = await import("../../src/lib/db.js");

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const DIAGNOSIS = {
  summary: "Build failed due to missing module",
  failure_category: "dependency_error",
  root_cause_claim: "Module not found in build",
  confidence: "medium",
  evidence_ids: ["github:workflow_run:123", "github:job:456"],
};

const EVIDENCE_REFS = [
  { type: "workflow_run", source: "github:workflow_run:123", description: "CI failed" },
  { type: "ci_job", source: "github:job:456", description: "Failed job: build" },
  { type: "ci_log_excerpt", source: "github:job:456", excerpt: "Error: Cannot find module", excerpt_hash: "abc", description: "Excerpt" },
  { type: "workflow_file", source: ".github/workflows/ci.yml@abc123def456", excerpt_hash: "def", description: "Workflow file" },
];

const HEAD_SHA = "abc123def456";

// ════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ════════════════════════════════════════════════════════════════════════════

function createMockProposal(overrides = {}) {
  return {
    id: 1,
    version: 1,
    status: "evidence_collected",
    repo_id: 100,
    repo_full_name: "test/repo",
    head_sha: HEAD_SHA,
    evidence_refs: JSON.stringify(EVIDENCE_REFS),
    diagnosis: JSON.stringify(DIAGNOSIS),
    patch_proposal: null,
    validation_result: null,
    critic_review: null,
    task_envelope: JSON.stringify({
      source: { repository: "test/repo" },
      risk: { can_write_repository: false, max_files: 5, max_changed_lines: 100 },
      blocked_paths: ["secrets/**", ".env*"],
    }),
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

// Simulated durable artifact table
const artifactTable = new Map();

function setupDbQueryMock(baseProposal) {
  db.query.mockImplementation(async (sql, params = []) => {
    // Artifact table: INSERT (storeArtifact)
    if (sql.includes("INSERT INTO patch_artifacts")) {
      const [hash, ref, content] = params;
      if (!artifactTable.has(hash)) {
        artifactTable.set(hash, { ref, content });
      }
      return { rows: [] };
    }
    // Artifact table: SELECT (resolveArtifact / verifyArtifact)
    if (sql.includes("SELECT") && sql.includes("patch_artifacts")) {
      const ref = params[0];
      for (const [, entry] of artifactTable) {
        if (entry.ref === ref) {
          return { rows: [{ content: entry.content }] };
        }
      }
      return { rows: [] };
    }
    // Proposal lookup (getProposal)
    if (sql.includes("SELECT") && sql.includes("repair_proposals") && !sql.includes("repair_proposal_events")) {
      return { rows: [baseProposal] };
    }
    return { rows: [] };
  });
}

async function createAndStoreArtifact(overrides = {}) {
  const content = JSON.stringify({
    base_sha: HEAD_SHA,
    files: [
      {
        path: "src/example.js",
        change_type: "fix",
        edits: [
          { line_start: 1, line_end: 1, new_content: "// Fixed the issue" },
        ],
      },
    ],
    ...overrides,
  });

  return storeArtifact(content);
}

function getCorrectBundleHash(proposalOverrides = {}) {
  const proposal = createMockProposal(proposalOverrides);
  const bundle = buildPatchInputBundle(proposal, DIAGNOSIS, EVIDENCE_REFS);
  return contentHash(bundle);
}

function getDiagnosisHash() {
  return contentHash(DIAGNOSIS);
}

async function createValidPatchInput(overrides = {}) {
  const { ref, hash } = await createAndStoreArtifact();
  return {
    artifact_ref: ref,
    artifact_hash: hash,
    base_sha: HEAD_SHA,
    files: [
      { path: "src/example.js", change_type: "fix", artifact_ref: ref, lines_changed: 1 },
    ],
    total_files: 1,
    total_lines_changed: 1,
    evidence_ids: ["github:workflow_run:123", "github:job:456"],
    diagnosis_hash: getDiagnosisHash(),
    input_bundle_hash: getCorrectBundleHash(),
    rationale_summary: "Fix the missing module dependency",
    limitations: "Generated by deterministic engine",
    ...overrides,
  };
}

beforeEach(() => {
  artifactTable.clear();
  db.query.mockClear();
  mockClient = createMockClient();
  mockConfig = {
    ci_healing: {
      enabled: true,
      auto_patch: true,
      min_confidence_to_patch: "medium",
    },
  };
  getConfigForRepo.mockClear();
  getConfigForRepo.mockResolvedValue(mockConfig);
  setupDbQueryMock(createMockProposal());
});

// ════════════════════════════════════════════════════════════════════════════
// VALID PATCH RECORDING
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — valid patch recording", () => {
  it("recordPatchProposal succeeds with valid bounded patch", async () => {
    const result = await recordPatchProposal(1, await createValidPatchInput(), {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
      correlation_id: "corr-1",
    });

    expect(result).toBeDefined();
    expect(result.id).toBe(1);
  });

  it("emits one UPDATE and one INSERT event", async () => {
    await recordPatchProposal(1, await createValidPatchInput(), {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
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

  it("INSERT event is patch_proposal_recorded", async () => {
    await recordPatchProposal(1, await createValidPatchInput(), {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
    });

    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    const params = insertCalls[0][1];
    expect(params[1]).toBe("patch_proposal_recorded");
    expect(params[2]).toBe("evidence_collected");
    expect(params[3]).toBe("proposed");
  });

  it("verifies artifact from durable store during recording", async () => {
    const patchInput = await createValidPatchInput();

    await recordPatchProposal(1, patchInput, {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
    });

    // verifyArtifact should have queried patch_artifacts
    const artifactSelects = db.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("patch_artifacts")
    );
    expect(artifactSelects.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DURABLE ARTIFACT RESOLUTION (P0)
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — durable artifact resolution (P0)", () => {
  it("resolves artifact from durable store after storeArtifact", async () => {
    const { ref, hash } = await createAndStoreArtifact();

    // Simulate process restart: clear in-memory state but keep DB rows
    // The db.query mock already simulates durability (artifactTable persists)

    // recordPatchProposal should resolve from durable storage
    const result = await recordPatchProposal(1, await createValidPatchInput({
      artifact_ref: ref,
      artifact_hash: hash,
      files: [{ path: "src/example.js", change_type: "fix", artifact_ref: ref, lines_changed: 1 }],
    }), {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
    });

    expect(result).toBeDefined();
  });

  it("rejects when artifact_ref does not exist in durable store", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: "artifact:sha256:nonexistent",
        artifact_hash: "sha256:nonexistent",
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/artifact verification failed.*not found/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POLICY PRECHECK — fail before artifact generation (P1)
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — policy precheck before generation (P1)", () => {
  it("auto_patch disabled → storeArtifact is not called", async () => {
    mockConfig.ci_healing.auto_patch = false;

    await expect(
      generatePatchForProposal(1)
    ).rejects.toThrow(/auto_patch.*rejected/);

    // Verify no artifact was stored
    const artifactInserts = db.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO patch_artifacts")
    );
    expect(artifactInserts).toHaveLength(0);
  });

  it("confidence below threshold → storeArtifact is not called", async () => {
    mockConfig.ci_healing.min_confidence_to_patch = "high";

    await expect(
      generatePatchForProposal(1)
    ).rejects.toThrow(/confidence.*below min_confidence_to_patch.*rejected/);

    const artifactInserts = db.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO patch_artifacts")
    );
    expect(artifactInserts).toHaveLength(0);
  });

  it("ci_healing disabled → storeArtifact is not called", async () => {
    mockConfig.ci_healing.enabled = false;

    await expect(
      generatePatchForProposal(1)
    ).rejects.toThrow(/CI healing is disabled.*rejected/);

    const artifactInserts = db.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO patch_artifacts")
    );
    expect(artifactInserts).toHaveLength(0);
  });

  it("missing repo_full_name → generation rejects (fail closed)", async () => {
    const noRepoProposal = createMockProposal({ repo_full_name: null });
    setupDbQueryMock(noRepoProposal);

    await expect(
      generatePatchForProposal(1)
    ).rejects.toThrow(/no repo_full_name/);

    const artifactInserts = db.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO patch_artifacts")
    );
    expect(artifactInserts).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POLICY RECHECK UNDER LOCK — in recordPatchProposal (P1)
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — policy recheck under lock (P1)", () => {
  it("rejects when auto_patch is disabled under lock", async () => {
    mockConfig.ci_healing.auto_patch = false;

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/auto_patch.*rejected/);
  });

  it("rejects when ci_healing is disabled under lock", async () => {
    mockConfig.ci_healing.enabled = false;

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/CI healing is disabled.*rejected/);
  });

  it("rejects when confidence is below threshold under lock", async () => {
    mockConfig.ci_healing.min_confidence_to_patch = "high";

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/confidence.*below min_confidence_to_patch.*rejected/);
  });

  it("policy is resolved server-side at execution time", async () => {
    await recordPatchProposal(1, await createValidPatchInput(), {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
    });

    expect(getConfigForRepo).toHaveBeenCalledWith("test/repo");
  });

  it("missing repo_full_name → recording rejects (fail closed)", async () => {
    mockClient = createMockClient({ repo_full_name: null });

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/no repo_full_name.*policy cannot be verified/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INPUT BUNDLE HASH VERIFICATION (P1)
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — input_bundle_hash verification (P1)", () => {
  it("rejects mismatched input_bundle_hash", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        input_bundle_hash: "sha256:wrongbundlehash",
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/input_bundle_hash.*does not match.*canonical bundle hash/);
  });

  it("rejects before any UPDATE when bundle hash mismatches", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        input_bundle_hash: "sha256:wrongbundlehash",
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/input_bundle_hash/);

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REJECTION CASES
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — rejection cases", () => {
  it("rejects missing diagnosis", async () => {
    mockClient = createMockClient({ diagnosis: null });

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/diagnosis must exist before patch generation/);
  });

  // ── Edit validity: no-op artifacts must be rejected ──────────────────

  it("rejects artifact with edits omitted", async () => {
    const noEditsContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{ path: "src/example.js", change_type: "fix" }],
    });
    const { ref, hash } = await storeArtifact(noEditsContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/at least one edit/);
  });

  it("rejects artifact with edits: []", async () => {
    const emptyEditsContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{ path: "src/example.js", change_type: "fix", edits: [] }],
    });
    const { ref, hash } = await storeArtifact(emptyEditsContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/at least one edit/);
  });

  it("rejects artifact with line_end < line_start", async () => {
    const badRangeContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{
        path: "src/example.js",
        change_type: "fix",
        edits: [{ line_start: 5, line_end: 2, new_content: "x" }],
      }],
    });
    const { ref, hash } = await storeArtifact(badRangeContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Invalid edit range/);
  });

  it("rejects artifact with non-integer line positions", async () => {
    const nonIntContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{
        path: "src/example.js",
        change_type: "fix",
        edits: [{ line_start: 1.5, line_end: 3, new_content: "x" }],
      }],
    });
    const { ref, hash } = await storeArtifact(nonIntContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Invalid edit range/);
  });

  it("rejects artifact with non-positive line_start (zero)", async () => {
    const zeroLineContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [{
        path: "src/example.js",
        change_type: "fix",
        edits: [{ line_start: 0, line_end: 1, new_content: "x" }],
      }],
    });
    const { ref, hash } = await storeArtifact(zeroLineContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Invalid edit range/);
  });

  it("rejects wrong status (detected)", async () => {
    mockClient = createMockClient({ status: "detected" });

    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/requires status 'evidence_collected', got 'detected'/);
  });

  it("rejects stale base SHA", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({ base_sha: "wrongsha123456" }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/base_sha.*does not match proposal head_sha/);
  });

  it("rejects mismatched diagnosis hash", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({ diagnosis_hash: "sha256:wronghash" }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/diagnosis_hash.*does not match.*locked diagnosis/);
  });

  it("rejects unbound evidence IDs", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        evidence_ids: ["github:workflow_run:123", "github:fake:999"],
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/Patch evidence binding failed/);
  });

  it("rejects artifact hash mismatch", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput({ artifact_hash: "sha256:wronghash" }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/artifact.*failed/);
  });

  it("rejects blocked paths (verified from artifact)", async () => {
    const blockedContent = JSON.stringify({
      base_sha: HEAD_SHA,
      files: [
        {
          path: "secrets/api-key.json",
          change_type: "fix",
          edits: [{ line_start: 1, line_end: 1, new_content: "redacted" }],
        },
      ],
    });
    const { ref, hash } = await storeArtifact(blockedContent);

    await expect(
      recordPatchProposal(1, await createValidPatchInput({
        artifact_ref: ref,
        artifact_hash: hash,
        files: [{ path: "secrets/api-key.json", change_type: "fix", artifact_ref: ref, lines_changed: 1 }],
      }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/exceeds envelope scope.*blocked path/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — replay safety", () => {
  it("same artifact hash on already-proposed → no-op return", async () => {
    const patchInput = await createValidPatchInput();
    mockClient = createMockClient({
      status: "proposed",
      patch_proposal: JSON.stringify({ ...patchInput, changed_files: patchInput.files }),
    });

    const result = await recordPatchProposal(1, patchInput, {
      actor_kind: ACTOR_KINDS.PATCH_WORKER,
      expected_version: 1,
    });

    expect(result).toBeDefined();

    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  it("different artifact hash on already-proposed → rejects", async () => {
    mockClient = createMockClient({
      status: "proposed",
      patch_proposal: JSON.stringify({
        artifact_hash: "sha256:originalhash",
        changed_files: [],
      }),
    });

    await expect(
      recordPatchProposal(1, await createValidPatchInput({ artifact_hash: "sha256:different" }), {
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/different artifact hash.*supersession/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — authority enforcement", () => {
  it("patch_worker cannot attach diagnosis via attachEvidence", async () => {
    await expect(
      attachEvidence(
        1,
        { diagnosis: { summary: "x", failure_category: "x", evidence_ids: ["a"] } },
        "patch_worker",
        1,
        null,
        ACTOR_KINDS.PATCH_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: diagnosis/);
  });

  it("patch_worker cannot attach validation_result via attachEvidence", async () => {
    await expect(
      attachEvidence(
        1,
        { validation_result: { overall: "pass", checks: [{ name: "x", passed: true, output_hash: "sha256:x" }] } },
        "patch_worker",
        1,
        null,
        ACTOR_KINDS.PATCH_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: validation_result/);
  });

  it("patch_worker cannot attach critic_review via attachEvidence", async () => {
    await expect(
      attachEvidence(
        1,
        { critic_review: { verdict: "approve", scope_assessment: "ok" } },
        "patch_worker",
        1,
        null,
        ACTOR_KINDS.PATCH_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: critic_review/);
  });

  it("attachEvidence rejects patch_proposal regardless of actor", async () => {
    await expect(
      attachEvidence(
        1,
        { patch_proposal: { files: [{ path: "a.js", change_type: "fix", artifact_ref: "ref", lines_changed: 1 }], total_files: 1, total_lines_changed: 1 } },
        "patch_worker",
        1,
        null,
        ACTOR_KINDS.PATCH_WORKER
      )
    ).rejects.toThrow(/patch_proposal may only be recorded by recordPatchProposal/);
  });

  it("generic transition to proposed rejects", async () => {
    await expect(
      transitionProposal(1, {
        status: "proposed",
        actor_kind: ACTOR_KINDS.PATCH_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/requires a dedicated authority-bound endpoint/);
  });

  it("invalid actor_kind rejects in recordPatchProposal", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        expected_version: 1,
        actor_kind: "invalid_kind",
      })
    ).rejects.toThrow(/actor_kind is required/);
  });

  it("diagnosis_worker cannot call recordPatchProposal", async () => {
    await expect(
      recordPatchProposal(1, await createValidPatchInput(), {
        actor_kind: ACTOR_KINDS.DIAGNOSIS_WORKER,
        expected_version: 1,
      })
    ).rejects.toThrow(/not authorized to attach patch_proposal/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GENERATE CANDIDATE PATCH — produces real content-addressed artifact
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — generateCandidatePatch produces real artifact", () => {
  it("produces artifact with hash-verifyable content", async () => {
    const canonical = buildPatchInputBundle(
      { id: 1, repo_full_name: "test/repo", head_sha: HEAD_SHA },
      DIAGNOSIS,
      EVIDENCE_REFS
    );
    const bundle = { ...canonical, diagnosis: DIAGNOSIS, evidence_refs: EVIDENCE_REFS };

    const result = await generateCandidatePatch(bundle);

    expect(result.artifact_ref).toMatch(/^artifact:sha256:/);
    expect(result.artifact_hash).toMatch(/^sha256:/);
    expect(result.artifact_content).toBeTruthy();
    expect(result.derived.total_files).toBe(1);
    expect(result.derived.total_lines_changed).toBeGreaterThan(0);
  });

  it("artifact_content is valid JSON with base_sha and files", async () => {
    const canonical = buildPatchInputBundle(
      { id: 1, repo_full_name: "test/repo", head_sha: HEAD_SHA },
      DIAGNOSIS,
      EVIDENCE_REFS
    );
    const bundle = { ...canonical, diagnosis: DIAGNOSIS, evidence_refs: EVIDENCE_REFS };

    const result = await generateCandidatePatch(bundle);
    const parsed = JSON.parse(result.artifact_content);

    expect(parsed.base_sha).toBe(HEAD_SHA);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].edits).toBeDefined();
  });

  it("throws when bundle has no diagnosis", async () => {
    await expect(
      generateCandidatePatch({ evidence_refs: EVIDENCE_REFS })
    ).rejects.toThrow(/bundle missing diagnosis/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH EVIDENCE BINDING — pure function
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — validatePatchEvidenceBinding", () => {
  it("valid when all evidence_ids are in collected evidence", () => {
    const result = validatePatchEvidenceBinding(
      { evidence_ids: ["github:workflow_run:123"] },
      EVIDENCE_REFS,
      DIAGNOSIS
    );
    expect(result.valid).toBe(true);
  });

  it("invalid when evidence_ids reference unknown source", () => {
    const result = validatePatchEvidenceBinding(
      { evidence_ids: ["github:workflow_run:123", "github:fake:999"] },
      EVIDENCE_REFS,
      DIAGNOSIS
    );
    expect(result.valid).toBe(false);
  });

  it("invalid when evidence_ids is empty", () => {
    const result = validatePatchEvidenceBinding(
      { evidence_ids: [] },
      EVIDENCE_REFS,
      DIAGNOSIS
    );
    expect(result.valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CHECK PATCH POLICY — pure function
// ════════════════════════════════════════════════════════════════════════════

describe("Patch behavioral — checkPatchPolicy", () => {
  it("passes when auto_patch enabled and confidence meets threshold", () => {
    expect(() =>
      checkPatchPolicy({ enabled: true, auto_patch: true, min_confidence_to_patch: "medium" }, { confidence: "high" })
    ).not.toThrow();
  });

  it("rejects when ci_healing is disabled", () => {
    expect(() =>
      checkPatchPolicy({ enabled: false, auto_patch: true }, { confidence: "high" })
    ).toThrow(/CI healing is disabled.*rejected/);
  });

  it("rejects when auto_patch is disabled", () => {
    expect(() =>
      checkPatchPolicy({ enabled: true, auto_patch: false }, { confidence: "high" })
    ).toThrow(/auto_patch.*rejected/);
  });

  it("rejects when confidence is below threshold", () => {
    expect(() =>
      checkPatchPolicy({ enabled: true, auto_patch: true, min_confidence_to_patch: "high" }, { confidence: "low" })
    ).toThrow(/confidence.*below.*rejected/);
  });
});
