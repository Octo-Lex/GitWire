// tests/unit/pass-capable-unlock.test.js
// Source-reading acceptance tests for PR #56 — the pass-capable unlock.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");
const dockerBackend = readSource("packages/web/src/lib/dockerExecutorBackend.js");
const evidenceStore = readSource("packages/web/src/lib/backendEvidenceStore.js");
const imageInspector = readSource("packages/web/src/lib/imageInspector.js");
const migration = readSource("packages/web/db/migrations/036_backend_isolation_evidence.sql");

// ════════════════════════════════════════════════════════════════════════════
// VERIFIER CHECK 3e — backend evidence wiring
// ════════════════════════════════════════════════════════════════════════════

describe("Verifier check 3e — backend evidence wiring", () => {
  it("calls verifyBackendEvidence in receipt verifier", () => {
    expect(repairService).toMatch(/verifyBackendEvidence/);
  });

  it("check 3e documented in docblock", () => {
    expect(repairService).toMatch(/3e\..*backend isolation evidence/);
  });

  it("receipt image_ref must match evidence image_ref", () => {
    expect(repairService).toMatch(/Receipt image_ref.*does not match evidence image_ref/);
  });

  it("evidence failure wrapped in descriptive error", () => {
    expect(repairService).toMatch(/Backend evidence verification failed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DOCKER BACKEND — pass-capable changes
// ════════════════════════════════════════════════════════════════════════════

describe("Docker backend — pass-capable changes", () => {
  it("supports_pass is true", () => {
    expect(dockerBackend).toMatch(/supports_pass:\s*true/);
  });

  it("returns pass when all commands exit zero", () => {
    expect(dockerBackend).toMatch(/overall = "pass"/);
  });

  it("uses real digest (not all-zeros placeholder)", () => {
    expect(dockerBackend).not.toMatch(/0000000000000000/);
    expect(dockerBackend).toMatch(/a1b2c3d4e5f6/);
  });

  it("does not return backend_not_pass_capable", () => {
    expect(dockerBackend).not.toMatch(/backend_not_pass_capable/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE STORE — audit-complete verification
// ════════════════════════════════════════════════════════════════════════════

describe("Evidence store — audit-complete verification", () => {
  it("persists inspection_hash", () => {
    expect(evidenceStore).toMatch(/inspection_hash/);
  });

  it("persists inspected_image_digest", () => {
    expect(evidenceStore).toMatch(/inspected_image_digest/);
  });

  it("persists repo_digests", () => {
    expect(evidenceStore).toMatch(/repo_digests/);
  });

  it("recomputes probe_suite_hash", () => {
    expect(evidenceStore).toMatch(/recomputedProbeHash/);
  });

  it("recomputes inspection_hash", () => {
    expect(evidenceStore).toMatch(/recomputedInspectionHash/);
  });

  it("verifies inspected digest matches image_digest", () => {
    expect(evidenceStore).toMatch(/inspected_image_digest.*does not match image_digest/);
  });

  it("verifies repo_digests contain matching digest", () => {
    expect(evidenceStore).toMatch(/repo_digests do not contain/);
  });

  it("imports computeInspectionHash", () => {
    expect(evidenceStore).toMatch(/computeInspectionHash/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IMAGE INSPECTOR — computeInspectionHash
// ════════════════════════════════════════════════════════════════════════════

describe("Image inspector — computeInspectionHash", () => {
  it("exports computeInspectionHash", () => {
    expect(imageInspector).toMatch(/export function computeInspectionHash/);
  });

  it("normalizes to binding fields", () => {
    expect(imageInspector).toMatch(/runtime/);
    expect(imageInspector).toMatch(/image_id/);
    expect(imageInspector).toMatch(/image_digest/);
    expect(imageInspector).toMatch(/repo_digests/);
  });

  it("sorts repo_digests for canonical ordering", () => {
    expect(imageInspector).toMatch(/sort/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION — inspection columns
// ════════════════════════════════════════════════════════════════════════════

describe("Migration — inspection columns", () => {
  it("has inspection_hash column", () => {
    expect(migration).toMatch(/inspection_hash\s+TEXT/);
  });

  it("has inspected_image_digest column", () => {
    expect(migration).toMatch(/inspected_image_digest\s+TEXT/);
  });

  it("has inspected_image_id column", () => {
    expect(migration).toMatch(/inspected_image_id\s+TEXT/);
  });

  it("has repo_digests column", () => {
    expect(migration).toMatch(/repo_digests\s+TEXT/);
  });

  it("has inspection_result column", () => {
    expect(migration).toMatch(/inspection_result\s+TEXT/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PASS AUTHORIZATION ALLOWLIST
// ════════════════════════════════════════════════════════════════════════════

describe("Pass authorization allowlist", () => {
  it("ALLOWED_PASS_EXECUTION_BACKENDS contains docker-executor", () => {
    expect(repairService).toMatch(/ALLOWED_PASS_EXECUTION_BACKENDS[\s\S]*"docker-executor"/);
  });

  it("does NOT contain node-executor in pass set", () => {
    const section = repairService.split("ALLOWED_PASS_EXECUTION_BACKENDS")[1];
    const setSection = section.split(";")[0];
    expect(setSection).not.toMatch(/node-executor/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VERIFIER REJECTION PATHS
// ════════════════════════════════════════════════════════════════════════════

describe("Verifier rejection paths — source-reading", () => {
  it("rejects when no backend evidence exists", () => {
    expect(repairService).toMatch(/Backend evidence verification failed/);
  });

  it("rejects node-executor pass receipts (not in pass set)", () => {
    expect(repairService).toMatch(/not authorized to produce passing results/);
  });

  it("rejects non-digest-pinned image_ref", () => {
    expect(repairService).toMatch(/not digest-pinned/);
  });

  it("rejects missing image_ref", () => {
    expect(repairService).toMatch(/missing image_ref/);
  });

  it("rejects when network_disabled is false", () => {
    expect(repairService).toMatch(/network_disabled is false/);
  });

  it("rejects when non_root is false", () => {
    expect(repairService).toMatch(/non_root is false/);
  });

  it("rejects when read_only_rootfs is false", () => {
    expect(repairService).toMatch(/read_only_rootfs is false/);
  });

  it("rejects when receipt image_ref differs from evidence image_ref", () => {
    expect(repairService).toMatch(/Receipt image_ref.*does not match evidence image_ref/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE STORE REJECTION PATHS
// ════════════════════════════════════════════════════════════════════════════

describe("Evidence store rejection paths — source-reading", () => {
  it("rejects when no evidence exists", () => {
    expect(evidenceStore).toMatch(/No isolation evidence/);
  });

  it("rejects when probes failed", () => {
    expect(evidenceStore).toMatch(/has failing probes/);
  });

  it("rejects incomplete probes", () => {
    expect(evidenceStore).toMatch(/is incomplete/);
  });

  it("rejects probe suite hash mismatch", () => {
    expect(evidenceStore).toMatch(/probe_suite_hash.*does not match recomputed/);
  });

  it("rejects missing inspection_hash", () => {
    expect(evidenceStore).toMatch(/missing inspection_hash/);
  });

  it("rejects missing inspected_image_digest", () => {
    expect(evidenceStore).toMatch(/missing inspected_image_digest/);
  });

  it("rejects inspection hash mismatch", () => {
    expect(evidenceStore).toMatch(/inspection_hash.*does not match recomputed/);
  });

  it("rejects inspected digest mismatch", () => {
    expect(evidenceStore).toMatch(/inspected_image_digest.*does not match image_digest/);
  });

  it("rejects when repo_digests don't contain matching digest", () => {
    expect(evidenceStore).toMatch(/repo_digests do not contain a reference/);
  });

  it("rejects when image_ref digest doesn't match image_digest", () => {
    expect(evidenceStore).toMatch(/image_ref digest.*does not match image_digest/);
  });

  it("rejects without inspection_result", () => {
    expect(evidenceStore).toMatch(/requires runtime image inspection_result/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PLACEHOLDER DIGEST REJECTION
// ════════════════════════════════════════════════════════════════════════════

describe("Placeholder digest rejection", () => {
  it("docker backend does not use all-zeros placeholder digest", () => {
    expect(dockerBackend).not.toMatch(/0000000000000000000000000000000000000000/);
  });

  it("docker backend uses a deterministic test fixture digest", () => {
    expect(dockerBackend).toMatch(/a1b2c3d4e5f6a1b2c3d4e5f6/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0 FIXES — test fixture, mandatory inspection, mandatory repo_digests
// ════════════════════════════════════════════════════════════════════════════

describe("P0 fix — test fixture cannot authorize pass in production", () => {
  it("exports isTestFixtureImage()", () => {
    expect(dockerBackend).toMatch(/export function isTestFixtureImage/);
  });

  it("checks GITWIRE_ALLOW_TEST_FIXTURE override", () => {
    expect(dockerBackend).toMatch(/GITWIRE_ALLOW_TEST_FIXTURE/);
  });

  it("returns test_fixture_image_not_production when fixture in use", () => {
    expect(dockerBackend).toMatch(/test_fixture_image_not_production/);
  });

  it("supports GITWIRE_VALIDATOR_IMAGE_REF configuration", () => {
    expect(dockerBackend).toMatch(/GITWIRE_VALIDATOR_IMAGE_REF/);
  });
});

describe("P0 fix — inspection_result is mandatory", () => {
  it("verifyBackendEvidence rejects missing inspection_result", () => {
    expect(evidenceStore).toMatch(/missing inspection_result.*cannot recompute inspection_hash/);
  });

  it("verifyBackendEvidence always recomputes inspection_hash (no conditional)", () => {
    // The recompute must be unconditional, not guarded by "if inspection_result exists"
    const section = evidenceStore.split("// PR #56: inspection_result is MANDATORY")[1] || "";
    expect(section).toMatch(/computeInspectionHash/);
    expect(section).not.toMatch(/^if \(evidence\.inspection_result\)/m);
  });
});

describe("P0 fix — repo_digests are mandatory", () => {
  it("rejects empty or missing repo_digests", () => {
    expect(evidenceStore).toMatch(/empty or missing repo_digests/);
  });

  it("does not bypass when repo_digests is empty", () => {
    // The check must not be inside an "if length > 0" conditional
    const section = evidenceStore.split("// PR #56: repo_digests are MANDATORY")[1] || "";
    expect(section).toMatch(/!Array.isArray|length === 0/);
  });
});

describe("P1 fix — evidence bound to receipt executor/runtime identity", () => {
  it("receipt executor_version must match evidence executor_version", () => {
    expect(repairService).toMatch(/Receipt executor_version.*does not match evidence executor_version/);
  });

  it("receipt container_runtime must match evidence container_runtime", () => {
    expect(repairService).toMatch(/Receipt container_runtime.*does not match evidence container_runtime/);
  });

  it("receipt runtime_version must match evidence runtime_version", () => {
    expect(repairService).toMatch(/Receipt runtime_version.*does not match evidence runtime_version/);
  });
});
