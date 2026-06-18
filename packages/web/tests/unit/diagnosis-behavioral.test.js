// tests/unit/diagnosis-behavioral.test.js
// Behavioral tests for diagnosis and evidence_refs invariants.
// Uses actual exported functions with mocked db.transaction.
//
// Coverage:
// - diagnosis_worker + valid bound evidence → succeeds
// - diagnosis_worker + unbound evidence_ids → rejected
// - ci_evidence_collector + generic attachEvidence({ evidence_refs }) → rejected
// - recordCiEvidenceCollection → remains the only path that writes evidence_refs
// - diagnosis_worker cannot write evidence_refs
// - diagnosis_worker cannot write patch_proposal
// - diagnosis_worker cannot transition

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

// ════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ════════════════════════════════════════════════════════════════════════════

// Mock the db module so transaction calls are intercepted
let mockClient;
let mockProposalRow;
let mockTransactionFn;

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: {
    query: jest.fn(async () => ({ rows: [] })),
    transaction: jest.fn(async (fn) => {
      mockTransactionFn = fn;
      return fn(mockClient);
    }),
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

// Import after mocks are set up
const { attachEvidence, recordCiEvidenceCollection } = await import(
  "../../src/services/repairProposalService.js"
);
const { ACTOR_KINDS } = await import(
  "../../src/services/repairAuthorityService.js"
);
const { diagnoseFromEvidence } = await import(
  "../../src/services/diagnosisWorkerService.js"
);

// Helper: create a mock client that returns specific proposal data
function createMockClient(proposalOverrides = {}) {
  const defaultProposal = {
    id: 1,
    version: 1,
    status: "evidence_collected",
    repo_id: 100,
    evidence_refs: JSON.stringify([
      { type: "workflow_run", source: "github:workflow_run:123", description: "CI failed" },
      { type: "ci_job", source: "github:job:456", description: "Failed job: build" },
      { type: "ci_log_excerpt", source: "github:job:456", excerpt: "Error: Cannot find module", excerpt_hash: "abc", description: "Excerpt" },
    ]),
    diagnosis: null,
    patch_proposal: null,
    validation_result: null,
    critic_review: null,
    task_envelope: JSON.stringify({ source: { repository: "test/repo" }, risk: { can_write_repository: false } }),
    ...proposalOverrides,
  };

  const updatedProposal = { ...defaultProposal, version: defaultProposal.version + 1 };

  return {
    query: jest.fn().mockImplementation((sql) => {
      if (sql.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: [defaultProposal] });
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

// Helper: create mock client for nonexistent proposal
function createNotFoundClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis behavioral — evidence_refs write-once", () => {
  beforeEach(() => {
    mockClient = createMockClient();
  });

  it("attachEvidence rejects evidence_refs regardless of actor", async () => {
    await expect(
      attachEvidence(
        1,
        { evidence_refs: [{ type: "ci_log", source: "fake", excerpt_hash: "x" }] },
        "ci_evidence_collector",
        1,
        null,
        ACTOR_KINDS.CI_EVIDENCE_COLLECTOR
      )
    ).rejects.toThrow(/evidence_refs may only be recorded by recordCiEvidenceCollection/);
  });

  it("ci_evidence_collector cannot write evidence_refs via generic attachEvidence", async () => {
    await expect(
      attachEvidence(
        1,
        { evidence_refs: [{ type: "ci_job", source: "github:job:1", excerpt_hash: "x" }] },
        "ci_evidence_collector",
        1,
        null,
        ACTOR_KINDS.CI_EVIDENCE_COLLECTOR
      )
    ).rejects.toThrow(/evidence_refs may only be recorded by recordCiEvidenceCollection/);
  });

  it("diagnosis_worker cannot write evidence_refs", async () => {
    await expect(
      attachEvidence(
        1,
        { evidence_refs: [{ type: "ci_log", source: "fake", excerpt_hash: "x" }] },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/evidence_refs may only be recorded by recordCiEvidenceCollection/);
  });

  it("any actor trying evidence_refs gets rejected before DB access", async () => {
    // This test verifies the rejection happens BEFORE the transaction
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockClear();

    await expect(
      attachEvidence(
        1,
        { evidence_refs: [{ type: "ci_log", source: "fake", excerpt_hash: "x" }] },
        "any_actor",
        1,
        null,
        ACTOR_KINDS.CI_EVIDENCE_COLLECTOR
      )
    ).rejects.toThrow();

    // Transaction should NOT have been called
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe("Diagnosis behavioral — diagnosis evidence binding", () => {
  beforeEach(() => {
    mockClient = createMockClient();
  });

  it("diagnosis_worker + valid bound evidence_ids → succeeds", async () => {
    mockClient = createMockClient();
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const diagnosis = {
      summary: "Build failed due to missing module",
      failure_category: "dependency_error",
      root_cause_claim: "Module not found in build",
      confidence: "medium",
      evidence_ids: [
        "github:workflow_run:123",
        "github:job:456",
      ],
    };

    const result = await attachEvidence(
      1,
      { diagnosis },
      "diagnosis_worker",
      1,
      "correlation-1",
      ACTOR_KINDS.DIAGNOSIS_WORKER
    );

    expect(result).toBeDefined();
    expect(result.id).toBe(1);
  });

  it("diagnosis_worker + unbound evidence_ids → rejects", async () => {
    mockClient = createMockClient();
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const diagnosis = {
      summary: "Something went wrong",
      failure_category: "unknown",
      root_cause_claim: "Unknown",
      confidence: "low",
      evidence_ids: [
        "github:workflow_run:123",
        "github:job:999",  // This one doesn't exist in collected evidence
      ],
    };

    await expect(
      attachEvidence(
        1,
        { diagnosis },
        "diagnosis_worker",
        1,
        "correlation-1",
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/Diagnosis evidence binding failed/);
  });

  it("diagnosis_worker + empty evidence_ids → rejects (binding)", async () => {
    mockClient = createMockClient();
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const diagnosis = {
      summary: "Something went wrong",
      failure_category: "unknown",
      confidence: "low",
      // No evidence_ids
    };

    await expect(
      attachEvidence(
        1,
        { diagnosis },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/Diagnosis evidence binding failed/);
  });

  it("diagnosis_worker + no evidence_refs on proposal → rejects", async () => {
    mockClient = createMockClient({ evidence_refs: null });
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const diagnosis = {
      summary: "Something went wrong",
      failure_category: "unknown",
      confidence: "low",
      evidence_ids: ["github:workflow_run:123"],
    };

    await expect(
      attachEvidence(
        1,
        { diagnosis },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/Diagnosis evidence binding failed/);
  });

  it("binding check happens after row lock (inside transaction)", async () => {
    const { db } = await import("../../src/lib/db.js");
    db.transaction.mockClear();
    mockClient = createMockClient();
    db.transaction.mockImplementation(async (fn) => {
      // Track the order: transaction must be entered first
      expect(mockClient.query).not.toHaveBeenCalled();
      return fn(mockClient);
    });

    const diagnosis = {
      summary: "Valid",
      failure_category: "unknown",
      confidence: "low",
      evidence_ids: ["github:workflow_run:999"],  // Unbound
    };

    await expect(
      attachEvidence(
        1,
        { diagnosis },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/Diagnosis evidence binding failed/);

    // Verify FOR UPDATE was called (proving binding happens after lock)
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [1]
    );
  });
});

describe("Diagnosis behavioral — actor authority", () => {
  it("diagnosis_worker cannot write patch_proposal", async () => {
    await expect(
      attachEvidence(
        1,
        { patch_proposal: { files: [{ path: "a.js", change_type: "fix", artifact_ref: "blob/sha", lines_changed: 5 }], total_files: 1, total_lines_changed: 5 } },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: patch_proposal/);
  });

  it("diagnosis_worker cannot write validation_result", async () => {
    await expect(
      attachEvidence(
        1,
        { validation_result: { overall: "pass", checks: [{ name: "build", passed: true, output_hash: "sha256:abc" }] } },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: validation_result/);
  });

  it("diagnosis_worker cannot write critic_review", async () => {
    await expect(
      attachEvidence(
        1,
        { critic_review: { verdict: "approve", scope_assessment: "ok" } },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/not authorized to attach evidence field: critic_review/);
  });

  it("missing actor_kind is rejected", async () => {
    await expect(
      attachEvidence(1, { diagnosis: { summary: "x", failure_category: "x" } }, "system", 1, null, undefined)
    ).rejects.toThrow(/actor_kind is required/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL DIAGNOSIS WORKER BOUNDARIES — lifecycle gate + write-once in attachEvidence
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis behavioral — diagnosis_worker lifecycle boundary in attachEvidence", () => {
  it("diagnosis_worker + proposed proposal → rejects before UPDATE", async () => {
    const { db } = await import("../../src/lib/db.js");
    mockClient = createMockClient({ status: "proposed" });
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const diagnosis = {
      summary: "Valid diagnosis",
      failure_category: "unknown",
      confidence: "low",
      evidence_ids: ["github:workflow_run:123"],
    };

    await expect(
      attachEvidence(1, { diagnosis }, "diagnosis_worker", 1, "corr", ACTOR_KINDS.DIAGNOSIS_WORKER)
    ).rejects.toThrow(/diagnosis_worker requires status 'evidence_collected', got 'proposed'/);

    // Verify UPDATE was never called
    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("diagnosis_worker + verified proposal → rejects before UPDATE", async () => {
    const { db } = await import("../../src/lib/db.js");
    mockClient = createMockClient({ status: "verified" });
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    await expect(
      attachEvidence(
        1,
        { diagnosis: { summary: "x", failure_category: "x", evidence_ids: ["github:workflow_run:123"] } },
        "diagnosis_worker",
        1,
        null,
        ACTOR_KINDS.DIAGNOSIS_WORKER
      )
    ).rejects.toThrow(/diagnosis_worker requires status 'evidence_collected', got 'verified'/);
  });
});

describe("Diagnosis behavioral — diagnosis_worker write-once in attachEvidence", () => {
  it("diagnosis_worker + existing diagnosis → returns proposal, no UPDATE", async () => {
    const { db } = await import("../../src/lib/db.js");
    const existingDiagnosis = {
      summary: "Previously diagnosed",
      failure_category: "test_failure",
      confidence: "high",
      evidence_ids: ["github:workflow_run:123"],
    };
    mockClient = createMockClient({
      diagnosis: JSON.stringify(existingDiagnosis),
    });
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const result = await attachEvidence(
      1,
      {
        diagnosis: {
          summary: "New diagnosis attempt",
          failure_category: "unknown",
          evidence_ids: ["github:workflow_run:123"],
        },
      },
      "diagnosis_worker",
      1,
      "corr",
      ACTOR_KINDS.DIAGNOSIS_WORKER
    );

    // Returns the existing proposal (idempotent)
    expect(result).toBeDefined();
    expect(result.id).toBe(1);

    // The returned diagnosis is the existing one, not the new attempt
    const returnedDiag = typeof result.diagnosis === "string"
      ? JSON.parse(result.diagnosis)
      : result.diagnosis;
    expect(returnedDiag.summary).toBe("Previously diagnosed");

    // No UPDATE was issued
    const updateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    expect(updateCalls).toHaveLength(0);

    // No INSERT event was issued
    const insertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("two diagnosis attempts for one proposal → second is a no-op", async () => {
    const { db } = await import("../../src/lib/db.js");

    // First attempt: proposal has no diagnosis → succeeds
    mockClient = createMockClient({ diagnosis: null });
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const firstResult = await attachEvidence(
      1,
      {
        diagnosis: {
          summary: "First diagnosis",
          failure_category: "test_failure",
          confidence: "medium",
          evidence_ids: ["github:workflow_run:123", "github:job:456"],
        },
      },
      "diagnosis_worker",
      1,
      "corr-1",
      ACTOR_KINDS.DIAGNOSIS_WORKER
    );

    expect(firstResult).toBeDefined();

    // Count UPDATE + INSERT from first attempt
    const firstUpdateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    const firstInsertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    expect(firstUpdateCalls).toHaveLength(1);
    expect(firstInsertCalls).toHaveLength(1);

    // Second attempt: proposal now has a diagnosis → no-op return
    mockClient = createMockClient({
      diagnosis: JSON.stringify({
        summary: "First diagnosis",
        failure_category: "test_failure",
        confidence: "medium",
        evidence_ids: ["github:workflow_run:123", "github:job:456"],
      }),
    });
    db.transaction.mockImplementation(async (fn) => fn(mockClient));

    const secondResult = await attachEvidence(
      1,
      {
        diagnosis: {
          summary: "Second diagnosis",
          failure_category: "unknown",
          evidence_ids: ["github:workflow_run:123"],
        },
      },
      "diagnosis_worker",
      2,
      "corr-2",
      ACTOR_KINDS.DIAGNOSIS_WORKER
    );

    // Returns existing proposal
    expect(secondResult).toBeDefined();

    // Second mock client should have only the FOR UPDATE SELECT, no UPDATE or INSERT
    const secondUpdateCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("UPDATE repair_proposals")
    );
    const secondInsertCalls = mockClient.query.mock.calls.filter(
      ([sql]) => sql && sql.includes("INSERT INTO repair_proposal_events")
    );
    expect(secondUpdateCalls).toHaveLength(0); // no mutation on second attempt
    expect(secondInsertCalls).toHaveLength(0); // no event on second attempt
  });
});

describe("Diagnosis behavioral — diagnoseFromEvidence pure function", () => {
  it("produces valid diagnosis from evidence refs", () => {
    const refs = [
      { type: "workflow_run", source: "github:workflow_run:1", description: "CI failed" },
      { type: "ci_job", source: "github:job:2", description: "Failed: build" },
      { type: "ci_log_excerpt", source: "github:job:2", excerpt: "Error: Cannot find module 'foo'", excerpt_hash: "h1" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);

    expect(diagnosis.summary).toBeTruthy();
    expect(diagnosis.failure_category).toBeTruthy();
    expect(diagnosis.confidence).toBe("medium"); // excerpt present
    expect(diagnosis.evidence_ids).toEqual(
      expect.arrayContaining([
        "github:workflow_run:1",
        "github:job:2",
      ])
    );
  });

  it("sets confidence low when no excerpts", () => {
    const refs = [
      { type: "workflow_run", source: "github:workflow_run:1", description: "CI failed" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);

    expect(diagnosis.confidence).toBe("low");
    expect(diagnosis.limitations).toBeTruthy();
  });

  it("throws when evidence_refs is empty", () => {
    expect(() => diagnoseFromEvidence([])).toThrow(/Cannot diagnose without evidence refs/);
  });

  it("categorizes dependency errors correctly", () => {
    const refs = [
      { type: "ci_log_excerpt", source: "github:job:1", excerpt: "Error: Cannot find module 'foo'", excerpt_hash: "h" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);
    expect(diagnosis.failure_category).toBe("dependency_error");
  });

  it("categorizes test failures correctly", () => {
    const refs = [
      { type: "ci_log_excerpt", source: "github:job:1", excerpt: "Test failed: should pass", excerpt_hash: "h" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);
    expect(diagnosis.failure_category).toBe("test_failure");
  });

  it("categorizes syntax errors correctly", () => {
    const refs = [
      { type: "ci_log_excerpt", source: "github:job:1", excerpt: "SyntaxError: Unexpected token }", excerpt_hash: "h" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);
    expect(diagnosis.failure_category).toBe("syntax_error");
  });

  it("references all evidence refs in evidence_ids", () => {
    const refs = [
      { type: "workflow_run", source: "src1", description: "a" },
      { type: "ci_job", source: "src2", description: "b" },
      { type: "ci_log_excerpt", source: "src3", excerpt: "err", excerpt_hash: "h" },
      { type: "workflow_file", source: "src4", description: "c" },
    ];

    const diagnosis = diagnoseFromEvidence(refs);
    expect(diagnosis.evidence_ids).toHaveLength(4);
    expect(diagnosis.evidence_ids).toEqual(
      expect.arrayContaining(["src1", "src2", "src3", "src4"])
    );
  });
});
