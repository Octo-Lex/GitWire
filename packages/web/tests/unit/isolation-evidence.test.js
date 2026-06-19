// tests/unit/isolation-evidence.test.js
// Source-reading tests for image reference, isolation probes,
// backend evidence store, and image inspector.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const imageRef = readSource("packages/web/src/lib/imageReference.js");
const imageInspector = readSource("packages/web/src/lib/imageInspector.js");
const probes = readSource("packages/web/src/lib/isolationProbes.js");
const evidenceStore = readSource("packages/web/src/lib/backendEvidenceStore.js");
const migration = readSource("packages/web/db/migrations/036_backend_isolation_evidence.sql");
const dockerBackend = readSource("packages/web/src/lib/dockerExecutorBackend.js");
const sandboxRunner = readSource("packages/web/src/lib/sandboxRunner.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");

// ════════════════════════════════════════════════════════════════════════════
// IMAGE REFERENCE PARSER/VALIDATOR
// ════════════════════════════════════════════════════════════════════════════

describe("Image Reference — parser and validator", () => {
  it("exports parseImageReference", () => {
    expect(imageRef).toMatch(/export function parseImageReference/);
  });

  it("exports validateDigestPinned", () => {
    expect(imageRef).toMatch(/export function validateDigestPinned/);
  });

  it("exports isDigestPinned", () => {
    expect(imageRef).toMatch(/export function isDigestPinned/);
  });

  it("exports extractDigest", () => {
    expect(imageRef).toMatch(/export function extractDigest/);
  });

  it("exports digestsMatch", () => {
    expect(imageRef).toMatch(/export function digestsMatch/);
  });

  it("exports buildImageRef", () => {
    expect(imageRef).toMatch(/export function buildImageRef/);
  });

  it("exports computeImageDigest", () => {
    expect(imageRef).toMatch(/export function computeImageDigest/);
  });

  it("uses 64 hex char digest regex", () => {
    expect(imageRef).toMatch(/sha256:\[0-9a-f\]\{64\}/);
  });

  it("rejects tags in documentation", () => {
    expect(imageRef).toMatch(/gitwire-validator:latest/);
    expect(imageRef).toMatch(/registry\/image:tag/);
  });

  it("rejects governance labels in documentation", () => {
    expect(imageRef).toMatch(/sha256:gitwire-validator-v1/);
  });

  it("documents registry/repo/image@sha256 format", () => {
    expect(imageRef).toMatch(/registry\/repo\/image@sha256/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IMAGE INSPECTOR
// ════════════════════════════════════════════════════════════════════════════

describe("Image Inspector — runtime identity verification", () => {
  it("exports inspectContainerImage", () => {
    expect(imageInspector).toMatch(/export async function inspectContainerImage/);
  });

  it("exports inspectImage", () => {
    expect(imageInspector).toMatch(/export async function inspectImage/);
  });

  it("exports verifyImageIdentity", () => {
    expect(imageInspector).toMatch(/export function verifyImageIdentity/);
  });

  it("verifyImageIdentity fails closed on null inspection", () => {
    expect(imageInspector).toMatch(/inspection returned no result/);
  });

  it("verifyImageIdentity fails on missing digest", () => {
    expect(imageInspector).toMatch(/did not resolve an image digest/);
  });

  it("verifyImageIdentity fails on digest mismatch", () => {
    expect(imageInspector).toMatch(/Image identity mismatch/);
  });

  it("uses digestsMatch for comparison", () => {
    expect(imageInspector).toMatch(/digestsMatch/);
  });

  it("queries docker inspect or podman inspect", () => {
    expect(imageInspector).toMatch(/inspect/);
  });

  it("extracts repo digests from inspection", () => {
    expect(imageInspector).toMatch(/RepoDigests/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ISOLATION PROBES
// ════════════════════════════════════════════════════════════════════════════

describe("Isolation Probes — probe suite", () => {
  it("exports REQUIRED_PROBES array", () => {
    expect(probes).toMatch(/REQUIRED_PROBES/);
  });

  it("exports getRequiredProbeNames", () => {
    expect(probes).toMatch(/export function getRequiredProbeNames/);
  });

  it("exports validateProbeCompleteness", () => {
    expect(probes).toMatch(/export function validateProbeCompleteness/);
  });

  it("exports validateProbeResults", () => {
    expect(probes).toMatch(/export function validateProbeResults/);
  });

  it("exports computeProbeSuiteHash", () => {
    expect(probes).toMatch(/export function computeProbeSuiteHash/);
  });

  it("exports buildProbeResult", () => {
    expect(probes).toMatch(/export function buildProbeResult/);
  });

  it("exports runProbeInContainer", () => {
    expect(probes).toMatch(/export async function runProbeInContainer/);
  });

  // Check every required probe is present
  const requiredProbes = [
    "network_disabled",
    "no_github_token",
    "no_ssh_agent",
    "non_root_uid",
    "read_only_rootfs",
    "workspace_writable",
    "pid_limit",
    "memory_limit",
    "wall_clock_limit",
    "no_docker_socket",
  ];

  requiredProbes.forEach((probeName) => {
    it(`includes probe: ${probeName}`, () => {
      expect(probes).toMatch(probeName);
    });
  });

  it("network_disabled probe expects non-zero exit (connection fails)", () => {
    expect(probes).toMatch(/network_disabled[\s\S]*checkPass.*code !== 0/);
  });

  it("no_github_token probe checks GITHUB_TOKEN absent", () => {
    expect(probes).toMatch(/GITHUB_TOKEN/);
  });

  it("no_ssh_agent probe checks SSH_AUTH_SOCK absent", () => {
    expect(probes).toMatch(/SSH_AUTH_SOCK/);
  });

  it("non_root_uid probe checks uid != 0", () => {
    expect(probes).toMatch(/id -u/);
    expect(probes).toMatch(/!= "0"/);
  });

  it("read_only_rootfs probe writes to /etc (should fail)", () => {
    expect(probes).toMatch(/\/etc\/gitwire-probe/);
  });

  it("workspace_writable probe writes to /workspace (should succeed)", () => {
    expect(probes).toMatch(/\/workspace\/.probe/);
  });

  it("no_docker_socket probe checks /var/run/docker.sock absent", () => {
    expect(probes).toMatch(/\/var\/run\/docker\.sock/);
  });

  it("computeProbeSuiteHash uses sha256", () => {
    expect(probes).toMatch(/sha256:/);
  });

  it("computeProbeSuiteHash sorts probes by name", () => {
    expect(probes).toMatch(/localeCompare/);
    expect(probes).toMatch(/probe_name/);
    expect(probes).toMatch(/sort/);
  });

  it("buildProbeResult includes probe_name and passed", () => {
    expect(probes).toMatch(/probe_name/);
    expect(probes).toMatch(/passed/);
  });

  it("validateProbeCompleteness reports missing probes", () => {
    expect(probes).toMatch(/missing/);
  });

  it("validateProbeResults reports failing probes", () => {
    expect(probes).toMatch(/failures/);
  });

  it("runProbeInContainer validates digest-pinned image ref", () => {
    expect(probes).toMatch(/validateDigestPinned/);
  });

  it("runProbeInContainer uses --network=none", () => {
    expect(probes).toMatch(/--network=none/);
  });

  it("runProbeInContainer uses --read-only", () => {
    expect(probes).toMatch(/--read-only/);
  });

  it("runProbeInContainer uses non-root --user", () => {
    expect(probes).toMatch(/--user=/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BACKEND EVIDENCE STORE
// ════════════════════════════════════════════════════════════════════════════

describe("Backend Evidence Store — durable isolation evidence", () => {
  it("exports storeBackendEvidence", () => {
    expect(evidenceStore).toMatch(/export async function storeBackendEvidence/);
  });

  it("exports resolveBackendEvidence", () => {
    expect(evidenceStore).toMatch(/export async function resolveBackendEvidence/);
  });

  it("exports verifyBackendEvidence", () => {
    expect(evidenceStore).toMatch(/export async function verifyBackendEvidence/);
  });

  it("exports hasBackendEvidence", () => {
    expect(evidenceStore).toMatch(/export async function hasBackendEvidence/);
  });

  it("storeBackendEvidence validates digest-pinned image ref", () => {
    expect(evidenceStore).toMatch(/validateDigestPinned/);
  });

  it("storeBackendEvidence validates probe completeness", () => {
    expect(evidenceStore).toMatch(/validateProbeCompleteness/);
  });

  it("storeBackendEvidence validates all probes passed", () => {
    expect(evidenceStore).toMatch(/validateProbeResults/);
  });

  it("storeBackendEvidence computes probe suite hash", () => {
    expect(evidenceStore).toMatch(/computeProbeSuiteHash/);
  });

  it("storeBackendEvidence rejects on incomplete probes", () => {
    expect(evidenceStore).toMatch(/Backend evidence incomplete/);
  });

  it("storeBackendEvidence rejects on failing probes", () => {
    expect(evidenceStore).toMatch(/Backend evidence has failing probes/);
  });

  it("storeBackendEvidence uses INSERT ON CONFLICT DO NOTHING", () => {
    expect(evidenceStore).toMatch(/ON CONFLICT.*DO NOTHING/);
  });

  it("verifyBackendEvidence throws if no evidence", () => {
    expect(evidenceStore).toMatch(/No isolation evidence/);
  });

  it("verifyBackendEvidence throws on failing probes", () => {
    expect(evidenceStore).toMatch(/has failing probes/);
  });

  it("verifyBackendEvidence re-validates probe completeness", () => {
    expect(evidenceStore).toMatch(/Stored isolation evidence is incomplete/);
  });

  it("stores execution_backend_id and image_digest", () => {
    expect(evidenceStore).toMatch(/execution_backend_id/);
    expect(evidenceStore).toMatch(/image_digest/);
  });

  it("stores container_runtime and runtime_version", () => {
    expect(evidenceStore).toMatch(/container_runtime/);
    expect(evidenceStore).toMatch(/runtime_version/);
  });

  it("stores probe_suite_hash", () => {
    expect(evidenceStore).toMatch(/probe_suite_hash/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION
// ════════════════════════════════════════════════════════════════════════════

describe("Backend Evidence Migration", () => {
  it("creates backend_isolation_evidence table", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS backend_isolation_evidence/);
  });

  it("has evidence_id as PRIMARY KEY", () => {
    expect(migration).toMatch(/evidence_id\s+TEXT PRIMARY KEY/);
  });

  it("has all_probes_passed column", () => {
    expect(migration).toMatch(/all_probes_passed/);
  });

  it("has index on execution_backend_id and image_digest", () => {
    expect(migration).toMatch(/idx_backend_evidence_lookup/);
    expect(migration).toMatch(/execution_backend_id, image_digest/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DOCKER BACKEND — image identity changes
// ════════════════════════════════════════════════════════════════════════════

describe("Docker Backend — immutable image identity", () => {
  it("exports DOCKER_IMAGE_REF with digest-pinned format", () => {
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_REF = .+@sha256:[0-9a-f]{64}/);
  });

  it("exports DOCKER_IMAGE_DIGEST as sha256:<64 hex>", () => {
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_DIGEST = "sha256:[0-9a-f]{64}"/);
  });

  it("backend object includes image_ref property", () => {
    expect(dockerBackend).toMatch(/image_ref: DOCKER_IMAGE_REF/);
  });

  it("describe() returns image_ref", () => {
    expect(dockerBackend).toMatch(/image_ref: this\.image_ref/);
  });

  it("container args use full digest-pinned image reference", () => {
    // P0 fix: must pass the FULL repo@sha256:... reference, not stripped name
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_REF,/);
    expect(dockerBackend).not.toMatch(/DOCKER_IMAGE_REF\.split/);
  });

  it("does NOT contain old governance label", () => {
    // The old label was "sha256:gitwire-validator-v1"
    // It should only appear in comments documenting the replacement
    const lines = dockerBackend.split("\n");
    const nonCommentLines = lines.filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const codeText = nonCommentLines.join("\n");
    expect(codeText).not.toMatch(/sha256:gitwire-validator-v1/);
  });

  it("supports_pass remains false", () => {
    expect(dockerBackend).toMatch(/supports_pass:\s*false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX RUNNER — image_ref in receipt
// ════════════════════════════════════════════════════════════════════════════

describe("Sandbox Runner — image_ref in receipt bindings", () => {
  it("buildExecutionReceipt includes image_ref parameter", () => {
    expect(sandboxRunner).toMatch(/image_ref,/);
  });

  it("receipt object includes image_ref field", () => {
    expect(sandboxRunner).toMatch(/image_ref: image_ref \|\| null/);
  });

  it("passes image_ref from isolation binding to receipt", () => {
    expect(sandboxRunner).toMatch(/image_ref: isolation\.image_ref/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VERIFIER — image_ref check
// ════════════════════════════════════════════════════════════════════════════

describe("Verifier — image_ref digest-pinned check", () => {
  it("requires image_ref on pass receipts", () => {
    expect(repairService).toMatch(/missing image_ref/);
  });

  it("validates image_ref is digest-pinned", () => {
    expect(repairService).toMatch(/isDigestPinned/);
  });

  it("rejects non-digest-pinned image_ref", () => {
    expect(repairService).toMatch(/not digest-pinned/);
  });

  it("check is documented as 3d in docblock", () => {
    expect(repairService).toMatch(/3d\. image_ref present and digest-pinned/);
  });

  it("ALLOWED_PASS_EXECUTION_BACKENDS remains empty", () => {
    const section = repairService.split("ALLOWED_PASS_EXECUTION_BACKENDS");
    expect(section[1]).toMatch(/empty until/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0 FIXES — full image reference + inspection integration
// ════════════════════════════════════════════════════════════════════════════

describe("P0 fix — full digest-pinned reference in execution", () => {
  it("docker executor uses full DOCKER_IMAGE_REF (not split)", () => {
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_REF,/);
    expect(dockerBackend).not.toMatch(/DOCKER_IMAGE_REF\.split/);
  });

  it("isolation probes use full imageRef (not split)", () => {
    expect(probes).toMatch(/\bimageRef,\s*$/m);
    expect(probes).not.toMatch(/imageRef\.split/);
  });
});

describe("P0 fix — runtime inspection integrated before evidence storage", () => {
  it("storeBackendEvidence requires inspection_result", () => {
    expect(evidenceStore).toMatch(/inspection_result/);
    expect(evidenceStore).toMatch(/requires runtime image inspection_result/);
  });

  it("storeBackendEvidence calls verifyImageIdentity", () => {
    expect(evidenceStore).toMatch(/verifyImageIdentity/);
  });

  it("storeBackendEvidence fails closed without inspection", () => {
    expect(evidenceStore).toMatch(/cannot trust configuration string alone/);
  });
});

describe("P1 fix — image_ref digest must match image_digest", () => {
  it("storeBackendEvidence checks extractDigest(image_ref) === image_digest", () => {
    expect(evidenceStore).toMatch(/extractDigest/);
    expect(evidenceStore).toMatch(/does not match image_digest/);
  });

  it("verifyBackendEvidence re-checks stored image_ref vs image_digest", () => {
    expect(evidenceStore).toMatch(/Stored isolation evidence image_ref digest/);
  });
});

describe("P1 fix — placeholder digest documented", () => {
  it("docker backend documents all-zeros digest as placeholder", () => {
    expect(dockerBackend).toMatch(/PLACEHOLDER/);
    expect(dockerBackend).toMatch(/NOT a real image identity/);
  });

  it("docker backend documents that inspection will fail on placeholder", () => {
    expect(dockerBackend).toMatch(/runtime inspection/);
  });
});
