// tests/unit/repair-proposal.test.js
// Tests for the CI repair proposal model — state machine, envelope validation,
// evidence gates, race safety, redaction, and security properties.
//
// Round 2 hardening coverage:
// - CAS: id and version use SEPARATE placeholders (no collision)
// - expected_version is MANDATORY on all mutation endpoints
// - Semantic evidence gates (validation must pass, critic must approve)
// - Patch scope enforced against stored envelope limits
// - Idempotent creation uses ON CONFLICT DO NOTHING (no state heuristics)

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

// Import pure functions for direct testing
import {
  isValidTransition,
  isTerminalState,
  computeFingerprint,
  validateEnvelope,
  validateDiagnosis,
  validatePatchProposal,
  validateValidationResult,
  validateCriticReview,
  validateEvidenceRefs,
  checkRequiredEvidence,
  checkSemanticEvidence,
  checkPatchAgainstEnvelope,
  redactProposal,
  contentHash,
  buildEvidenceSnapshot,
  pathMatchesBlocked,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  AUTHORITY_STATES,
  REQUIRED_EVIDENCE,
  KNOWN_TOOLS,
  PROHIBITED_DIAGNOSIS_FIELDS,
  ALLOWED_DIAGNOSIS_FIELDS,
  VALID_CHANGE_TYPES,
  VALID_VALIDATION_OVERALL,
  VALID_CRITIC_VERDICTS,
  VALID_EVIDENCE_REF_TYPES,
} from "../../src/services/repairProposalService.js";

// ════════════════════════════════════════════════════════════════════════════
// STATE MACHINE — valid transitions
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — state machine", () => {
  describe("valid transitions", () => {
    it("detected → evidence_collected", () => {
      expect(isValidTransition("detected", "evidence_collected")).toBe(true);
    });
    it("evidence_collected → proposed", () => {
      expect(isValidTransition("evidence_collected", "proposed")).toBe(true);
    });
    it("proposed → verified", () => {
      expect(isValidTransition("proposed", "verified")).toBe(true);
    });
    it("verified → review_ready", () => {
      expect(isValidTransition("verified", "review_ready")).toBe(true);
    });
    it("review_ready → approved (valid in graph)", () => {
      expect(isValidTransition("review_ready", "approved")).toBe(true);
    });
    it("approved → applied (valid in graph)", () => {
      expect(isValidTransition("approved", "applied")).toBe(true);
    });
    it("applied → verified_after_apply (valid in graph)", () => {
      expect(isValidTransition("applied", "verified_after_apply")).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    it("detected → proposed (must collect evidence first)", () => {
      expect(isValidTransition("detected", "proposed")).toBe(false);
    });
    it("detected → approved (skips entire lifecycle)", () => {
      expect(isValidTransition("detected", "approved")).toBe(false);
    });
    it("evidence_collected → verified (must propose first)", () => {
      expect(isValidTransition("evidence_collected", "verified")).toBe(false);
    });
    it("proposed → review_ready (must verify first)", () => {
      expect(isValidTransition("proposed", "review_ready")).toBe(false);
    });
    it("verified → applied (must go through review_ready → approved)", () => {
      expect(isValidTransition("verified", "applied")).toBe(false);
    });
  });

  describe("terminal states reject all transitions", () => {
    const terminals = ["verified_after_apply", "rejected", "cancelled", "failed", "superseded"];
    for (const terminal of terminals) {
      it(`${terminal} → anything is invalid`, () => {
        expect(isValidTransition(terminal, "detected")).toBe(false);
        expect(isValidTransition(terminal, "approved")).toBe(false);
      });
      it(`${terminal} is terminal`, () => {
        expect(isTerminalState(terminal)).toBe(true);
      });
    }
  });

  describe("cancelled and failed paths", () => {
    it("detected → cancelled", () => {
      expect(isValidTransition("detected", "cancelled")).toBe(true);
    });
    it("proposed → rejected", () => {
      expect(isValidTransition("proposed", "rejected")).toBe(true);
    });
    it("applied → superseded", () => {
      expect(isValidTransition("applied", "superseded")).toBe(true);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY STATES
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — authority states", () => {
  it("approved/applied/verified_after_apply are authority states", () => {
    expect(AUTHORITY_STATES.has("approved")).toBe(true);
    expect(AUTHORITY_STATES.has("applied")).toBe(true);
    expect(AUTHORITY_STATES.has("verified_after_apply")).toBe(true);
  });
  it("detected/review_ready are NOT authority states", () => {
    expect(AUTHORITY_STATES.has("detected")).toBe(false);
    expect(AUTHORITY_STATES.has("review_ready")).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ENVELOPE VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — envelope validation", () => {
  function makeValidEnvelope(overrides = {}) {
    return {
      task_type: "ci_repair",
      source: {
        repository: "acme/webapp",
        workflow_run_id: 123,
        head_sha: "abc123def456",
      },
      risk: {
        can_write_repository: false,
        requires_approval: true,
        max_files: 3,
        max_changed_lines: 120,
      },
      allowed_tools: ["read_ci_logs", "read_repository_file"],
      blocked_paths: [".env*", "secrets/**"],
      required_validation: ["policy_scope_check"],
      ...overrides,
    };
  }

  it("accepts a valid envelope", () => {
    expect(validateEnvelope(makeValidEnvelope())).toEqual({ valid: true });
  });
  it("rejects can_write_repository: true", () => {
    const env = makeValidEnvelope({
      risk: { can_write_repository: true, requires_approval: true, max_files: 3, max_changed_lines: 120 },
    });
    expect(validateEnvelope(env).valid).toBe(false);
  });
  it("rejects max_files: 11", () => {
    const env = makeValidEnvelope({
      risk: { can_write_repository: false, requires_approval: true, max_files: 11, max_changed_lines: 120 },
    });
    expect(validateEnvelope(env).valid).toBe(false);
  });
  it("rejects unknown tools", () => {
    const env = makeValidEnvelope({ allowed_tools: ["delete_repository"] });
    expect(validateEnvelope(env).valid).toBe(false);
  });
  it("rejects absolute paths in blocked_paths", () => {
    const env = makeValidEnvelope({ blocked_paths: ["/etc/passwd"] });
    expect(validateEnvelope(env).valid).toBe(false);
  });
  it("rejects traversal paths in blocked_paths", () => {
    const env = makeValidEnvelope({ blocked_paths: ["../../../etc"] });
    expect(validateEnvelope(env).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS VALIDATION — strict allowlist
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — diagnosis validation", () => {
  function makeValidDiagnosis(overrides = {}) {
    return {
      summary: "Dependency lockfile is inconsistent.",
      failure_category: "dependency_resolution",
      confidence: "medium",
      ...overrides,
    };
  }

  it("accepts a valid diagnosis", () => {
    expect(validateDiagnosis(makeValidDiagnosis())).toEqual({ valid: true });
  });

  for (const field of PROHIBITED_DIAGNOSIS_FIELDS) {
    it(`rejects prohibited field: ${field}`, () => {
      expect(validateDiagnosis(makeValidDiagnosis({ [field]: "x" })).valid).toBe(false);
    });
  }

  it("rejects unknown field: raw_output", () => {
    expect(validateDiagnosis(makeValidDiagnosis({ raw_output: "x" })).valid).toBe(false);
  });
  it("rejects unknown field: secret_payload", () => {
    expect(validateDiagnosis(makeValidDiagnosis({ secret_payload: "x" })).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH PROPOSAL VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — patch_proposal validation", () => {
  function makeValidPatch(overrides = {}) {
    return {
      files: [
        { path: "src/index.js", change_type: "fix", artifact_ref: "sha256:abc", lines_changed: 10 },
      ],
      total_files: 1,
      total_lines_changed: 10,
      ...overrides,
    };
  }

  it("accepts a valid patch", () => {
    expect(validatePatchProposal(makeValidPatch())).toEqual({ valid: true });
  });
  it("rejects empty files", () => {
    expect(validatePatchProposal({ files: [], total_files: 0, total_lines_changed: 0 }).valid).toBe(false);
  });
  it("rejects traversal path", () => {
    expect(validatePatchProposal(makeValidPatch({
      files: [{ path: "../../etc", change_type: "fix", artifact_ref: "x", lines_changed: 1 }],
      total_files: 1, total_lines_changed: 1,
    })).valid).toBe(false);
  });
  it("rejects total_files mismatch", () => {
    expect(validatePatchProposal(makeValidPatch({ total_files: 99 })).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION RESULT VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — validation_result validation", () => {
  function makeValid(overrides = {}) {
    return {
      overall: "pass",
      checks: [{ name: "test", passed: true, output_hash: "sha256:abc" }],
      ...overrides,
    };
  }
  it("accepts valid pass", () => {
    expect(validateValidationResult(makeValid())).toEqual({ valid: true });
  });
  it("rejects overall=pass with failed check", () => {
    expect(validateValidationResult(makeValid({
      overall: "pass",
      checks: [{ name: "x", passed: false, output_hash: "y" }],
    })).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CRITIC REVIEW VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — critic_review validation", () => {
  it("accepts approve", () => {
    expect(validateCriticReview({ verdict: "approve" })).toEqual({ valid: true });
  });
  it("rejects reject without concerns", () => {
    expect(validateCriticReview({ verdict: "reject", concerns: [] }).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE REFS VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — evidence_refs validation", () => {
  it("accepts valid refs", () => {
    expect(validateEvidenceRefs([{ type: "ci_log", source: "x", excerpt_hash: "y" }])).toEqual({ valid: true });
  });
  it("rejects empty", () => {
    expect(validateEvidenceRefs([]).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STRUCTURAL EVIDENCE GATES
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — structural evidence gates", () => {
  it("evidence_collected requires evidence_refs", () => {
    expect(checkRequiredEvidence({}, "evidence_collected")).toContain("evidence_refs");
  });
  it("proposed requires diagnosis and patch_proposal", () => {
    const missing = checkRequiredEvidence({ diagnosis: { summary: "x" } }, "proposed");
    expect(missing).toContain("patch_proposal");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SEMANTIC EVIDENCE GATES (round 2 fix #3)
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — semantic evidence gates", () => {
  describe("verified transition", () => {
    it("blocks when validation_result.overall is 'fail'", () => {
      const proposal = { validation_result: { overall: "fail" } };
      const errors = checkSemanticEvidence(proposal, "verified");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/validation_result\.overall.*pass/);
    });

    it("blocks when validation_result is missing", () => {
      const proposal = { validation_result: null };
      const errors = checkSemanticEvidence(proposal, "verified");
      expect(errors.length).toBeGreaterThan(0);
    });

    it("allows when validation_result.overall is 'pass'", () => {
      const proposal = { validation_result: { overall: "pass" } };
      expect(checkSemanticEvidence(proposal, "verified")).toEqual([]);
    });

    it("handles JSONB string for validation_result", () => {
      const proposal = { validation_result: '{"overall":"fail"}' };
      const errors = checkSemanticEvidence(proposal, "verified");
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("review_ready transition", () => {
    it("blocks when critic_review.verdict is 'reject'", () => {
      const proposal = { critic_review: { verdict: "reject" } };
      const errors = checkSemanticEvidence(proposal, "review_ready");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/verdict.*approve/);
    });

    it("blocks when critic_review has unrelated_changes", () => {
      const proposal = {
        critic_review: { verdict: "approve", unrelated_changes: true },
      };
      const errors = checkSemanticEvidence(proposal, "review_ready");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/unrelated_changes/);
    });

    it("blocks when critic_review has scope_violations", () => {
      const proposal = {
        critic_review: { verdict: "approve", scope_violations: ["file X out of scope"] },
      };
      const errors = checkSemanticEvidence(proposal, "review_ready");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/scope_violations/);
    });

    it("allows clean approve", () => {
      const proposal = {
        critic_review: { verdict: "approve", unrelated_changes: false, scope_violations: [] },
      };
      expect(checkSemanticEvidence(proposal, "review_ready")).toEqual([]);
    });

    it("handles JSONB string for critic_review", () => {
      const proposal = { critic_review: '{"verdict":"reject"}' };
      const errors = checkSemanticEvidence(proposal, "review_ready");
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it("returns empty for states without semantic requirements", () => {
    expect(checkSemanticEvidence({}, "cancelled")).toEqual([]);
    expect(checkSemanticEvidence({}, "rejected")).toEqual([]);
    expect(checkSemanticEvidence({}, "evidence_collected")).toEqual([]);
    expect(checkSemanticEvidence({}, "proposed")).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH SCOPE ENFORCEMENT (round 2 fix #4)
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — patch scope vs envelope", () => {
  function makeEnvelope(overrides = {}) {
    return {
      risk: { max_files: 3, max_changed_lines: 100 },
      blocked_paths: [".env*", "secrets/**"],
      ...overrides,
    };
  }
  function makePatch(overrides = {}) {
    return {
      files: [
        { path: "src/index.js", change_type: "fix", artifact_ref: "x", lines_changed: 10 },
      ],
      total_files: 1,
      total_lines_changed: 10,
      ...overrides,
    };
  }

  it("allows patch within envelope limits", () => {
    expect(checkPatchAgainstEnvelope(makePatch(), makeEnvelope())).toEqual([]);
  });

  it("rejects patch exceeding max_files", () => {
    const errors = checkPatchAgainstEnvelope(
      makePatch({ total_files: 4, files: [
        { path: "a.js", change_type: "fix", artifact_ref: "x", lines_changed: 1 },
        { path: "b.js", change_type: "fix", artifact_ref: "x", lines_changed: 1 },
        { path: "c.js", change_type: "fix", artifact_ref: "x", lines_changed: 1 },
        { path: "d.js", change_type: "fix", artifact_ref: "x", lines_changed: 1 },
      ], total_lines_changed: 4 }),
      makeEnvelope()
    );
    expect(errors.join(" ")).toMatch(/total_files.*max_files/);
  });

  it("rejects patch exceeding max_changed_lines", () => {
    const errors = checkPatchAgainstEnvelope(
      makePatch({ total_lines_changed: 101, files: [
        { path: "a.js", change_type: "fix", artifact_ref: "x", lines_changed: 101 },
      ], total_files: 1 }),
      makeEnvelope()
    );
    expect(errors.join(" ")).toMatch(/total_lines_changed.*max_changed_lines/);
  });

  it("rejects file matching blocked_paths glob (.env*)", () => {
    const errors = checkPatchAgainstEnvelope(
      makePatch({
        files: [{ path: ".env.local", change_type: "fix", artifact_ref: "x", lines_changed: 1 }],
        total_files: 1, total_lines_changed: 1,
      }),
      makeEnvelope()
    );
    expect(errors.join(" ")).toMatch(/blocked path/);
  });

  it("rejects file matching blocked_paths glob (secrets/**)", () => {
    const errors = checkPatchAgainstEnvelope(
      makePatch({
        files: [{ path: "secrets/api-key.pem", change_type: "fix", artifact_ref: "x", lines_changed: 1 }],
        total_files: 1, total_lines_changed: 1,
      }),
      makeEnvelope()
    );
    expect(errors.join(" ")).toMatch(/blocked path/);
  });

  it("allows file that does NOT match any blocked pattern", () => {
    const errors = checkPatchAgainstEnvelope(makePatch(), makeEnvelope());
    expect(errors).toEqual([]);
  });

  it("handles missing envelope gracefully", () => {
    expect(checkPatchAgainstEnvelope(makePatch(), null)).toEqual([]);
  });

  it("handles missing risk gracefully", () => {
    expect(checkPatchAgainstEnvelope(makePatch(), { blocked_paths: [] })).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GLOB MATCHING
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — glob matching (pathMatchesBlocked)", () => {
  it("matches .env* pattern", () => {
    expect(pathMatchesBlocked(".env", [".env*"])).toBe(true);
    expect(pathMatchesBlocked(".env.local", [".env*"])).toBe(true);
    expect(pathMatchesBlocked(".env.production", [".env*"])).toBe(true);
  });

  it("matches secrets/** pattern", () => {
    expect(pathMatchesBlocked("secrets/key.pem", ["secrets/**"])).toBe(true);
    expect(pathMatchesBlocked("secrets/sub/deep.pem", ["secrets/**"])).toBe(true);
  });

  it("does NOT match unrelated paths", () => {
    expect(pathMatchesBlocked("src/index.js", [".env*"])).toBe(false);
    expect(pathMatchesBlocked("src/index.js", ["secrets/**"])).toBe(false);
  });

  it("handles multiple patterns", () => {
    expect(pathMatchesBlocked(".env", [".env*", "secrets/**"])).toBe(true);
    expect(pathMatchesBlocked("secrets/x", [".env*", "secrets/**"])).toBe(true);
    expect(pathMatchesBlocked("src/x", [".env*", "secrets/**"])).toBe(false);
  });

  it("handles empty patterns array", () => {
    expect(pathMatchesBlocked("anything", [])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CONTENT HASH & EVIDENCE SNAPSHOT
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — content hash & evidence snapshot", () => {
  it("contentHash is deterministic", () => {
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }));
  });
  it("contentHash returns 64-char hex", () => {
    expect(contentHash("test")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("buildEvidenceSnapshot includes value + hash", () => {
    const snap = buildEvidenceSnapshot({ diagnosis: { summary: "x" } });
    expect(snap.diagnosis.value).toEqual({ summary: "x" });
    expect(snap.diagnosis.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REDACTION
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — redaction", () => {
  it("forces can_write_repository to false", () => {
    const r = redactProposal({ task_envelope: { risk: { can_write_repository: true } } });
    expect(r.task_envelope.risk.can_write_repository).toBe(false);
  });
  it("handles null", () => {
    expect(redactProposal(null)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE FINGERPRINT
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — source fingerprint", () => {
  it("is deterministic for same source", () => {
    const s = { repository: "a", workflow_run_id: 1, head_sha: "x" };
    expect(computeFingerprint(s)).toBe(computeFingerprint(s));
  });
  it("differs for different repo", () => {
    expect(computeFingerprint({ repository: "a", workflow_run_id: 1, head_sha: "x" }))
      .not.toBe(computeFingerprint({ repository: "b", workflow_run_id: 1, head_sha: "x" }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — migration contract", () => {
  const migration = readSource("packages/web/db/migrations/031_repair_proposals.sql");

  it("creates repair_proposals table", () => {
    expect(migration).toMatch(/CREATE TABLE.*repair_proposals/);
  });
  it("has repo_id FK", () => {
    expect(migration).toMatch(/repo_id.*REFERENCES repositories/);
  });
  it("has all 12 status states", () => {
    for (const s of ["detected", "evidence_collected", "proposed", "verified", "review_ready", "approved", "applied", "verified_after_apply", "rejected", "cancelled", "failed", "superseded"]) {
      expect(migration).toContain(s);
    }
  });
  it("has UNIQUE constraint on fingerprint", () => {
    expect(migration).toMatch(/UNIQUE.*idx_repair_fingerprint_unique/);
  });
  it("has evidence_snapshot column in events", () => {
    expect(migration).toMatch(/evidence_snapshot.*JSONB/);
  });
  it("has append-only triggers on events", () => {
    expect(migration).toMatch(/trg_prevent_event_update/);
    expect(migration).toMatch(/trg_prevent_event_delete/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CONTRACT — CAS correctness (round 2 fix #1, #2)
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — service CAS contract", () => {
  const service = readSource("packages/web/src/services/repairProposalService.js");

  it("exports pure functions", () => {
    expect(service).toMatch(/export function checkSemanticEvidence/);
    expect(service).toMatch(/export function checkPatchAgainstEnvelope/);
    expect(service).toMatch(/export function pathMatchesBlocked/);
  });

  // FIX 1: CAS uses SEPARATE placeholders — no collision
  it("attachEvidence allocates separate placeholders for id and version", () => {
    // Find the WHERE clause in attachEvidence — should have id and version
    // on different placeholders, NOT the same paramIdx
    expect(service).not.toMatch(/WHERE id = \$\$\{paramIdx\}\$\{versionClause\}/);
    expect(service).not.toMatch(/WHERE id = \$\$\{paramIdx\} AND version = \$\$\{paramIdx\}/);
  });

  it("attachEvidence uses whereClauses array with separate paramIdx++", () => {
    // The pattern whereClauses.push(`id = $${paramIdx++}`) followed by
    // whereClauses.push(`version = $${paramIdx++}`) ensures separate placeholders
    expect(service).toMatch(/whereClauses\.push\(`id = \$\$\{paramIdx\+\+\}`\)/);
    expect(service).toMatch(/whereClauses\.push\(`version = \$\$\{paramIdx\+\+\}`\)/);
  });

  it("transitionProposal uses whereClauses array with separate paramIdx++", () => {
    // Same pattern in transitionProposal
    // Count occurrences — should be at least 2 (one per function)
    const matches = service.match(/whereClauses\.push\(`id = \$\$\{paramIdx\+\+\}`\)/g);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const versionMatches = service.match(/whereClauses\.push\(`version = \$\$\{paramIdx\+\+\}`\)/g);
    expect(versionMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT have the old versionClause/versionCondition pattern", () => {
    expect(service).not.toMatch(/versionClause/);
    expect(service).not.toMatch(/versionCondition/);
  });

  // FIX 2: expected_version is mandatory
  it("attachEvidence requires expected_version", () => {
    expect(service).toMatch(/Number\.isInteger\(expected_version\)/);
  });

  it("transitionProposal requires expected_version", () => {
    expect(service).toMatch(/Number\.isInteger\(expected_version\)/);
    expect(service).toMatch(/positive integer/);
  });

  // FIX 3: Semantic evidence gates
  it("calls checkSemanticEvidence in transitionProposal", () => {
    expect(service).toMatch(/checkSemanticEvidence\(proposal, targetStatus\)/);
  });

  // FIX 4: Patch scope enforcement
  it("calls checkPatchAgainstEnvelope in attachEvidence", () => {
    expect(service).toMatch(/checkPatchAgainstEnvelope\(evidence\.patch_proposal, envelope\)/);
  });

  // FIX 5: Idempotent creation uses ON CONFLICT DO NOTHING
  it("uses ON CONFLICT DO NOTHING (not DO UPDATE)", () => {
    expect(service).toMatch(/ON CONFLICT.*DO NOTHING/);
    expect(service).not.toMatch(/ON CONFLICT.*DO UPDATE.*updated_at/);
  });

  it("checks inserted.length to distinguish new from existing", () => {
    expect(service).toMatch(/inserted\.length > 0/);
  });

  // Existing contracts from round 1
  it("uses db.transaction", () => {
    expect(service).toMatch(/db\.transaction\(async \(client\)/);
  });
  it("uses FOR UPDATE", () => {
    expect(service).toMatch(/FOR UPDATE/);
  });
  it("checks for zero rows after CAS UPDATE", () => {
    expect(service).toMatch(/rows\.length === 0/);
  });
  it("records events inside transaction", () => {
    expect(service).toMatch(/client\.query/);
    expect(service).toMatch(/repair_proposal_events/);
  });
  it("forces can_write_repository to false in redactProposal", () => {
    expect(service).toMatch(/can_write_repository.*false/);
  });
  it("checks repo === envelope.source.repository", () => {
    expect(service).toMatch(/envelope\.source\.repository.*!==.*repo/);
  });
  it("has strict diagnosis allowlist", () => {
    expect(service).toMatch(/unknown field/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE CONTRACT (round 3 — read-only public API)
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal — route contract", () => {
  const route = readSource("packages/web/src/routes/repairs.js");
  const app = readSource("packages/web/src/app.js");

  it("has GET routes (read-only access)", () => {
    expect(route).toMatch(/router\.get\("\/"/);
    expect(route).toMatch(/router\.get\("\/:id"/);
    expect(route).toMatch(/router\.get\("\/:id\/events"/);
  });

  it("mutation routes exist but return 403", () => {
    expect(route).toMatch(/router\.post\("\/"/);
    expect(route).toMatch(/router\.patch\("\/:id\/evidence"/);
    expect(route).toMatch(/router\.post\("\/:id\/transition"/);
  });

  // Round 3: public API is read-only
  it("POST / returns 403", () => {
    expect(route).toMatch(/router\.post\("\/".*403/s);
  });

  it("PATCH /:id/evidence returns 403", () => {
    expect(route).toMatch(/router\.patch\("\/:id\/evidence".*403/s);
  });

  it("POST /:id/transition returns 403", () => {
    expect(route).toMatch(/router\.post\("\/:id\/transition".*403/s);
  });

  it("does not import createProposal in routes", () => {
    expect(route).not.toMatch(/createProposal/);
  });

  it("does not import attachEvidence in routes", () => {
    expect(route).not.toMatch(/attachEvidence/);
  });

  it("does not import transitionProposal in routes", () => {
    expect(route).not.toMatch(/transitionProposal/);
  });

  it("mounted at /api/repairs", () => {
    expect(app).toMatch(/\/api\/repairs/);
  });
});
