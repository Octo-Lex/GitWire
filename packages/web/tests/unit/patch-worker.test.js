// tests/unit/patch-worker.test.js
// Source-reading tests for the patch worker service and contracts.
//
// Validates:
// - recordPatchProposal is the sole canonical path for patch_proposal writes
// - attachEvidence rejects patch_proposal unconditionally
// - proposed is in AUTHORITY_STATES (generic transition blocked)
// - patch_worker authority matrix (field, transition, create)
// - PatchInputBundle construction
// - Patch evidence binding validation
// - Worker contract (queue, concurrency, no GitHub imports)
// - Route contract (public API remains read-only)
// - Infrastructure (queue registered, worker registered)
// - Boundary enforcement (no repo writes, no mutations)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const service = readSource("packages/web/src/services/patchWorkerService.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");
const authorityService = readSource("packages/web/src/services/repairAuthorityService.js");
const worker = readSource("packages/web/src/workers/patchWorker.js");
const routes = readSource("packages/web/src/routes/repairs.js");
const queueCore = readSource("packages/core/src/index.js");
const runtimeCompat = readSource("packages/runtime/compat/queue.js");
const webQueue = readSource("packages/web/src/lib/queue.js");
const indexJs = readSource("packages/web/src/index.js");
const diagnosisWorker = readSource("packages/web/src/workers/diagnosisWorker.js");
const artifactStore = readSource("packages/web/src/lib/patchArtifactStore.js");

// ════════════════════════════════════════════════════════════════════════════
// RECORD PATCH PROPOSAL — canonical transactional method
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — recordPatchProposal canonical method", () => {
  it("exports recordPatchProposal from repairProposalService", () => {
    expect(repairService).toMatch(/export async function recordPatchProposal/);
  });

  it("requires actor_kind: patch_worker", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
    expect(section[1]).toMatch(/canAttachField\(actor_kind, "patch_proposal"\)/);
    expect(section[1]).toMatch(/canTransitionTo\(actor_kind, "proposed"\)/);
  });

  it("enforces evidence_collected status after row lock", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/Patch proposal requires status 'evidence_collected'/);
  });

  it("requires diagnosis to exist", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/diagnosis must exist before patch generation/);
  });

  it("pins patch to proposal head_sha", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/base_sha.*does not match proposal head_sha/);
    expect(section[1]).toMatch(/patch must be pinned to the proposal's base snapshot/);
  });

  it("checks envelope scope (blocked_paths, max_files, max_changed_lines)", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/checkPatchAgainstEnvelope/);
    expect(section[1]).toMatch(/Patch exceeds envelope scope/);
  });

  it("validates patch evidence binding", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/validatePatchEvidenceBinding/);
    expect(section[1]).toMatch(/Patch evidence binding failed/);
  });

  it("transitions to proposed in the same transaction", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/"proposed"/);
    expect(section[1]).toMatch(/version = version \+ 1/);
  });

  it("records one patch_proposal_recorded event", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/patch_proposal_recorded/);
  });

  it("persists source_delivery_id and correlation_id in event", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/source_delivery_id/);
    expect(section[1]).toMatch(/correlation_id/);
  });

  // P1: input_bundle_hash binding to canonical bundle
  it("requires input_bundle_hash at top level", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/input_bundle_hash is required/);
  });

  it("verifies input_bundle_hash against recomputed canonical bundle", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/recomputed canonical bundle hash/);
    expect(section[1]).toMatch(/does not match/);
  });

  it("uses buildPatchInputBundle for canonical bundle reconstruction", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/buildPatchInputBundle/);
  });

  // P0: Durable artifact verification
  it("calls verifyArtifact asynchronously", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/await verifyArtifact/);
  });

  // P1: Fail closed on missing repo_full_name
  it("rejects when repo_full_name is missing (fail closed)", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/no repo_full_name.*policy cannot be verified/);
  });

  // P1: Policy recheck under lock using checkPatchPolicy
  it("calls checkPatchPolicy under lock", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/checkPatchPolicy/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY — same artifact hash = no-op, different = reject
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — replay safety in recordPatchProposal", () => {
  it("same artifact hash returns unchanged (no-op)", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/same artifact hash — replay no-op/);
    expect(section[1]).toMatch(/return redactProposal\(proposal\)/);
  });

  it("different artifact hash rejects with supersession message", () => {
    const section = repairService.split("export async function recordPatchProposal");
    expect(section[1]).toMatch(/different artifact hash/);
    expect(section[1]).toMatch(/revisions require an explicit supersession contract/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH_PROPOSAL RESERVED — blocked in attachEvidence
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — patch_proposal reserved for recordPatchProposal", () => {
  it("attachEvidence rejects patch_proposal unconditionally", () => {
    expect(repairService).toMatch(/patch_proposal may only be recorded by recordPatchProposal/);
  });

  it("attachEvidence does NOT include patch_proposal in fields array", () => {
    const section = repairService.split("export async function attachEvidence");
    const fieldsMatch = section[1].match(/const fields = \[([\s\S]*?)\];/);
    expect(fieldsMatch).toBeTruthy();
    expect(fieldsMatch[1]).not.toMatch(/patch_proposal/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY STATES — proposed blocked from generic transition
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — proposed in AUTHORITY_STATES", () => {
  it("AUTHORITY_STATES includes proposed", () => {
    expect(repairService).toMatch(/AUTHORITY_STATES.*"proposed"/s);
  });

  it("generic transitionProposal rejects proposed", () => {
    const section = repairService.split("export async function transitionProposal");
    expect(section[1]).toMatch(/requires a dedicated authority-bound endpoint/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY MATRIX — patch_worker permissions
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — authority matrix", () => {
  it("patch_worker can only write 'patch_proposal' field", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.PATCH_WORKER\]:\s*new Set\(\["patch_proposal"\]\)/);
  });

  it("patch_worker can transition to proposed and failed", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.PATCH_WORKER\]:\s*new Set\(\["proposed", "failed"\]\)/);
  });

  it("patch_worker cannot create proposals", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.PATCH_WORKER\]:\s*false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH INPUT BUNDLE — bounded, pinned input
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — PatchInputBundle construction", () => {
  it("exports buildPatchInputBundle", () => {
    expect(repairService).toMatch(/export function buildPatchInputBundle/);
  });

  it("bundle includes proposal_id, repository, head_sha", () => {
    const fnBody = repairService.split("function buildPatchInputBundle")[1].split("function")[0];
    expect(fnBody).toMatch(/proposal_id/);
    expect(fnBody).toMatch(/repository/);
    expect(fnBody).toMatch(/head_sha/);
  });

  it("bundle includes diagnosis_hash and evidence_hash", () => {
    const fnBody = repairService.split("function buildPatchInputBundle")[1].split("function")[0];
    expect(fnBody).toMatch(/diagnosis_hash/);
    expect(fnBody).toMatch(/evidence_hash/);
  });

  it("bundle includes source_files descriptors", () => {
    const fnBody = repairService.split("function buildPatchInputBundle")[1].split("function")[0];
    expect(fnBody).toMatch(/source_files/);
    expect(fnBody).toMatch(/content_ref/);
    expect(fnBody).toMatch(/content_hash/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CHECK PATCH POLICY — shared policy enforcement
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — checkPatchPolicy", () => {
  it("exports checkPatchPolicy", () => {
    expect(repairService).toMatch(/export function checkPatchPolicy/);
  });

  it("checks enabled flag", () => {
    const fnBody = repairService.split("function checkPatchPolicy")[1].split("function")[0];
    expect(fnBody).toMatch(/enabled/);
  });

  it("checks auto_patch flag", () => {
    const fnBody = repairService.split("function checkPatchPolicy")[1].split("function")[0];
    expect(fnBody).toMatch(/auto_patch/);
  });

  it("checks min_confidence_to_patch threshold", () => {
    const fnBody = repairService.split("function checkPatchPolicy")[1].split("function")[0];
    expect(fnBody).toMatch(/min_confidence_to_patch/);
    expect(fnBody).toMatch(/confidence/);
  });

  it("error messages contain 'rejected'", () => {
    const fnBody = repairService.split("function checkPatchPolicy")[1].split("function")[0];
    expect(fnBody).toMatch(/rejected/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH EVIDENCE BINDING
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — patch evidence binding", () => {
  it("exports validatePatchEvidenceBinding", () => {
    expect(repairService).toMatch(/export function validatePatchEvidenceBinding/);
  });

  it("requires at least one evidence reference", () => {
    expect(repairService).toMatch(/Patch proposal must reference at least one evidence item/);
  });

  it("rejects evidence not in proposal or diagnosis", () => {
    expect(repairService).toMatch(/Patch references evidence not in proposal/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — service contract", () => {
  it("exports generatePatchForProposal", () => {
    expect(service).toMatch(/export async function generatePatchForProposal/);
  });

  it("exports generateCandidatePatch (async)", () => {
    expect(service).toMatch(/export async function generateCandidatePatch/);
  });

  it("imports recordPatchProposal from repairProposalService", () => {
    expect(service).toMatch(/recordPatchProposal/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("uses ACTOR_KINDS.PATCH_WORKER as actor", () => {
    expect(service).toMatch(/ACTOR_KINDS\.PATCH_WORKER/);
  });

  it("passes actor_kind to recordPatchProposal", () => {
    expect(service).toMatch(/actor_kind:\s*ACTOR/);
  });

  it("does NOT import GitHub client", () => {
    expect(service).not.toMatch(/getInstallationClient|wrapOctokit/);
  });

  it("does NOT create branches or PRs", () => {
    expect(service).not.toMatch(/createBranch|createPullRequest|createCommit/);
  });

  // P1: Policy precheck before artifact generation
  it("imports checkPatchPolicy from repairProposalService", () => {
    expect(service).toMatch(/checkPatchPolicy/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("calls checkPatchPolicy BEFORE buildPatchInputBundle in generatePatchForProposal", () => {
    const fnSection = service.split("export async function generatePatchForProposal")[1];
    const policyIdx = fnSection.indexOf("checkPatchPolicy(");
    const bundleIdx = fnSection.indexOf("buildPatchInputBundle(");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(policyIdx).toBeLessThan(bundleIdx);
  });

  it("calls checkPatchPolicy BEFORE generateCandidatePatch", () => {
    const fnSection = service.split("export async function generatePatchForProposal")[1];
    const policyIdx = fnSection.indexOf("checkPatchPolicy(");
    const genIdx = fnSection.indexOf("generateCandidatePatch(");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(-1);
    expect(policyIdx).toBeLessThan(genIdx);
  });

  it("imports getConfigForRepo", () => {
    expect(service).toMatch(/getConfigForRepo/);
  });

  it("rejects when repo_full_name is missing (precheck)", () => {
    expect(service).toMatch(/no repo_full_name/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — worker contract", () => {
  it("exports startPatchWorker", () => {
    expect(worker).toMatch(/export function startPatchWorker/);
  });

  it("processes 'patch' queue", () => {
    expect(worker).toMatch(/"patch"/);
  });

  it("uses concurrency 1", () => {
    expect(worker).toMatch(/concurrency:\s*1/);
  });

  it("imports generatePatchForProposal from patchWorkerService", () => {
    expect(worker).toMatch(/import.*generatePatchForProposal.*patchWorkerService/);
  });

  it("does NOT import GitHub client", () => {
    expect(worker).not.toMatch(/getInstallationClient|wrapOctokit/);
  });

  it("passes correlationId to generatePatchForProposal", () => {
    expect(worker).toMatch(/correlationId/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POLICY-GATED ENQUEUE — diagnosis worker integration
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — policy-gated enqueue from diagnosis worker", () => {
  it("diagnosis worker imports patchQueue", () => {
    expect(diagnosisWorker).toMatch(/patchQueue/);
  });

  it("checks ci_healing.auto_patch policy", () => {
    expect(diagnosisWorker).toMatch(/auto_patch/);
  });

  it("checks min_confidence_to_patch threshold", () => {
    expect(diagnosisWorker).toMatch(/min_confidence_to_patch/);
  });

  it("enqueues patch job only when policy allows", () => {
    expect(diagnosisWorker).toMatch(/patchQueue\.add/);
    // BullMQ forbids ":" in jobId strings — must use a hyphen separator.
    expect(diagnosisWorker).toMatch(/patch-\$\{proposalId\}/);
  });

  it("policy failure does not block diagnosis completion", () => {
    expect(diagnosisWorker).toMatch(/Policy check failure should not block/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE CONTRACT — public API remains read-only
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — route contract", () => {
  it("mutation routes still return 403", () => {
    expect(routes).toMatch(/router\.post\("\/"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.patch\("\/:id\/evidence"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.post\("\/:id\/transition"[\s\S]*?403/s);
  });

  it("routes do not import patchWorkerService", () => {
    expect(routes).not.toMatch(/patchWorkerService/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — infrastructure", () => {
  it("QUEUES includes PATCH in core", () => {
    expect(queueCore).toMatch(/PATCH.*"patch"/);
  });

  it("patchQueue singleton in runtime compat", () => {
    expect(runtimeCompat).toMatch(/patchQueue.*PATCH/);
  });

  it("patchQueue exported from runtime compat", () => {
    expect(runtimeCompat).toMatch(/export const patchQueue/);
  });

  it("patchQueue re-exported from web lib/queue.js", () => {
    expect(webQueue).toMatch(/patchQueue/);
  });

  it("startPatchWorker imported in index.js", () => {
    expect(indexJs).toMatch(/import.*startPatchWorker/);
  });

  it("startPatchWorker called in workers array", () => {
    expect(indexJs).toMatch(/startPatchWorker\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DURABLE ARTIFACT STORE (P0)
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — durable artifact store (P0)", () => {
  it("imports db from db.js", () => {
    expect(artifactStore).toMatch(/import.*\{.*db.*\}.*from.*\.\/db\.js/);
  });

  it("storeArtifact uses db.query with INSERT", () => {
    expect(artifactStore).toMatch(/db\.query/);
    expect(artifactStore).toMatch(/INSERT INTO patch_artifacts/);
    expect(artifactStore).toMatch(/ON CONFLICT.*DO NOTHING/);
  });

  it("storeArtifact is async", () => {
    expect(artifactStore).toMatch(/export async function storeArtifact/);
  });

  it("resolveArtifact uses db.query with SELECT", () => {
    expect(artifactStore).toMatch(/SELECT content FROM patch_artifacts/);
    expect(artifactStore).toMatch(/WHERE artifact_ref/);
  });

  it("resolveArtifact is async", () => {
    expect(artifactStore).toMatch(/export async function resolveArtifact/);
  });

  it("verifyArtifact is async", () => {
    expect(artifactStore).toMatch(/export async function verifyArtifact/);
  });

  it("does NOT use in-process Map", () => {
    expect(artifactStore).not.toMatch(/new Map\(\)/);
  });

  it("requires at least one edit per file", () => {
    expect(artifactStore).toMatch(/at least one edit/);
  });

  it("validates edit range (line_start >= 1, line_end >= line_start)", () => {
    expect(artifactStore).toMatch(/Invalid edit range/);
    expect(artifactStore).toMatch(/line_start < 1/);
    expect(artifactStore).toMatch(/line_end < edit.line_start/);
  });

  it("requires at least one changed line across all files", () => {
    expect(artifactStore).toMatch(/at least one changed line/);
  });

  it("does NOT export _clearForTesting", () => {
    expect(artifactStore).not.toMatch(/_clearForTesting/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOUNDARY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Patch Worker — boundary enforcement", () => {
  it("service does NOT import github.js", () => {
    expect(service).not.toMatch(/from.*github\.js/);
  });

  it("service does NOT make HTTP requests", () => {
    expect(service).not.toMatch(/fetch\(|axios|octokit\.request/);
  });

  it("service does NOT write to repository", () => {
    expect(service).not.toMatch(/createCommit|createBranch|createPullRequest|gitPush/);
  });

  it("service header documents boundaries", () => {
    expect(service).toMatch(/No repository writes/);
    expect(service).toMatch(/No GitHub API calls for mutation/);
  });
});
