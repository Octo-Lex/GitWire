// tests/unit/verification-worker.test.js
// Source-reading tests for the verification worker service and contracts.
//
// Validates:
// - recordVerificationResult is the sole canonical path for validation_result writes
// - attachEvidence rejects validation_result unconditionally
// - verified is in AUTHORITY_STATES (generic transition blocked)
// - verification_worker authority matrix (field, transition, create)
// - Sandbox runner contracts (validation plan, fingerprint, allowlist)
// - Worker contract (queue, concurrency, no GitHub imports)
// - Route contract (public API remains read-only)
// - Infrastructure (queue registered, worker registered)
// - Boundary enforcement (no repo writes, no mutations, no network)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const service = readSource("packages/web/src/services/verificationWorkerService.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");
const authorityService = readSource("packages/web/src/services/repairAuthorityService.js");
const sandboxRunner = readSource("packages/web/src/lib/sandboxRunner.js");
const worker = readSource("packages/web/src/workers/verificationWorker.js");
const patchWorker = readSource("packages/web/src/workers/patchWorker.js");
const routes = readSource("packages/web/src/routes/repairs.js");
const queueCore = readSource("packages/core/src/index.js");
const runtimeCompat = readSource("packages/runtime/compat/queue.js");
const webQueue = readSource("packages/web/src/lib/queue.js");
const indexJs = readSource("packages/web/src/index.js");

// ════════════════════════════════════════════════════════════════════════════
// RECORD VERIFICATION RESULT — canonical transactional method
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — recordVerificationResult canonical method", () => {
  it("exports recordVerificationResult from repairProposalService", () => {
    expect(repairService).toMatch(/export async function recordVerificationResult/);
  });

  it("requires actor_kind: verification_worker", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
    expect(section[1]).toMatch(/canAttachField\(actor_kind, "validation_result"\)/);
  });

  it("enforces proposed status after row lock", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/Verification requires status 'proposed'/);
  });

  it("requires patch_proposal to exist", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/patch_proposal must exist before verification/);
  });

  it("verifies patch_artifact_hash against locked patch_proposal", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/patch_artifact_hash does not match locked patch_proposal/);
  });

  it("verifies base_sha against proposal head_sha", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/base_sha.*does not match proposal head_sha/);
  });

  it("verifies input_bundle_hash against locked patch_proposal", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/input_bundle_hash does not match locked patch_proposal/);
  });

  it("resolves and verifies durable artifact", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/await verifyArtifact/);
  });

  it("validates executed commands against required plan", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/validateCommandSet/);
    expect(section[1]).toMatch(/Missing required validation command/);
    expect(section[1]).toMatch(/Disallowed validation command/);
  });

  // P0: Consistency between overall and exit statuses
  it("derives aggregate result from command exit statuses", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/allCommandsPassed/);
    expect(section[1]).toMatch(/Passing verification requires zero aggregate and per-command/);
    expect(section[1]).toMatch(/Failed verification requires at least one failing/);
  });

  it("requires inconclusive_reason for inconclusive result", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/inconclusive_reason/);
    expect(section[1]).toMatch(/structured inconclusive_reason/);
  });

  // P1: Canonical plan hash and image digest
  it("recomputes validation_plan_hash from locked envelope", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/buildValidationPlanForRecorder/);
    expect(section[1]).toMatch(/validation_plan_hash does not match canonical plan/);
  });

  it("verifies sandbox_image_digest against approved pinned digest", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/sandbox_image_digest does not match approved pinned/);
  });

  it("verifies fingerprint against locked inputs", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/verification fingerprint mismatch/i);
  });

  it("transitions to verified when overall is pass", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/result === "pass" \? "verified"/);
  });

  // P0: pass requires execution receipt
  it("requires execution receipt for pass results", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/execution_receipt_ref and execution_receipt_hash are required/);
  });

  it("transitions to failed when overall is fail or inconclusive", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/: "failed"/);
  });

  it("records one verification_result_recorded event", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/verification_result_recorded/);
  });

  it("persists source_delivery_id and correlation_id in event", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/source_delivery_id/);
    expect(section[1]).toMatch(/correlation_id/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY — same fingerprint = no-op, different = reject
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — replay safety in recordVerificationResult", () => {
  it("same fingerprint returns unchanged (no-op)", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/same fingerprint — replay no-op/);
    expect(section[1]).toMatch(/return redactProposal\(proposal\)/);
  });

  it("different fingerprint rejects with revision message", () => {
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/different fingerprint/);
    expect(section[1]).toMatch(/retries require an explicit revision contract/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION_RESULT RESERVED — blocked in attachEvidence
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — validation_result reserved for recordVerificationResult", () => {
  it("attachEvidence rejects validation_result unconditionally", () => {
    expect(repairService).toMatch(/validation_result may only be recorded by recordVerificationResult/);
  });

  it("attachEvidence does NOT include validation_result in fields array", () => {
    const section = repairService.split("export async function attachEvidence");
    const fieldsMatch = section[1].match(/const fields = \[([\s\S]*?)\];/);
    expect(fieldsMatch).toBeTruthy();
    expect(fieldsMatch[1]).not.toMatch(/validation_result/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY STATES — verified blocked from generic transition
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — verified in AUTHORITY_STATES", () => {
  it("AUTHORITY_STATES includes verified", () => {
    expect(repairService).toMatch(/AUTHORITY_STATES.*"verified"/s);
  });

  it("generic transitionProposal rejects verified", () => {
    const section = repairService.split("export async function transitionProposal");
    expect(section[1]).toMatch(/requires a dedicated authority-bound endpoint/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY MATRIX — verification_worker permissions
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — authority matrix", () => {
  it("verification_worker can only write 'validation_result' field", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.VERIFICATION_WORKER\]:\s*new Set\(\["validation_result"\]\)/);
  });

  it("verification_worker can transition to verified and failed", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.VERIFICATION_WORKER\]:\s*new Set\(\["verified", "failed"\]\)/);
  });

  it("verification_worker cannot create proposals", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.VERIFICATION_WORKER\]:\s*false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX RUNNER CONTRACTS
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — sandbox runner contracts", () => {
  it("exports SANDBOX_IMAGE_DIGEST", () => {
    expect(sandboxRunner).toMatch(/export const SANDBOX_IMAGE_DIGEST/);
  });

  it("exports buildValidationPlan", () => {
    expect(sandboxRunner).toMatch(/export function buildValidationPlan/);
  });

  it("exports runSandboxVerification", () => {
    expect(sandboxRunner).toMatch(/export async function runSandboxVerification/);
  });

  it("exports computeVerificationFingerprint", () => {
    expect(sandboxRunner).toMatch(/export function computeVerificationFingerprint/);
  });

  it("exports validateCommandSet", () => {
    expect(sandboxRunner).toMatch(/export function validateCommandSet/);
  });

  it("buildValidationPlan derives from required_validation only", () => {
    expect(sandboxRunner).toMatch(/required_validation/);
  });

  it("validation plan uses the validation-plan adapter for command compilation", () => {
    // v0.23.0 Task 9: buildValidationPlan now uses compileValidationPlan()
    // from validationPlanAdapter.js instead of raw .sort() on required_validation.
    // The adapter handles semantic→executable translation + deduplication + sorting.
    expect(sandboxRunner).toMatch(/compileValidationPlan/);
  });

  it("rejects shell metacharacters in commands", () => {
    expect(sandboxRunner).toMatch(/shell metacharacters/);
  });

  it("validateCommandSet checks for missing required commands", () => {
    expect(sandboxRunner).toMatch(/Missing required validation command/);
  });

  it("validateCommandSet checks for disallowed commands", () => {
    expect(sandboxRunner).toMatch(/Disallowed validation command/);
  });

  it("fingerprint binds artifact, base, input bundle, image, plan", () => {
    expect(sandboxRunner).toMatch(/patch_artifact_hash/);
    expect(sandboxRunner).toMatch(/base_sha/);
    expect(sandboxRunner).toMatch(/input_bundle_hash/);
    expect(sandboxRunner).toMatch(/sandbox_image_digest/);
    expect(sandboxRunner).toMatch(/validation_plan_hash/);
  });

  it("exports DEFAULT_LIMITS with CPU, memory, process, time, output", () => {
    expect(sandboxRunner).toMatch(/cpu_shares/);
    expect(sandboxRunner).toMatch(/memory_mb/);
    expect(sandboxRunner).toMatch(/processes/);
    expect(sandboxRunner).toMatch(/wall_clock_ms/);
    expect(sandboxRunner).toMatch(/output_bytes/);
  });

  it("does NOT use child_process or exec", () => {
    expect(sandboxRunner).not.toMatch(/child_process|exec\(|spawn\(/);
  });

  // P0: Stub returns inconclusive, cannot produce pass
  it("sandbox runner produces execution receipts", () => {
    expect(sandboxRunner).toMatch(/buildExecutionReceipt/);
  });

  it("does NOT synthesize pass without real execution", () => {
    expect(sandboxRunner).not.toMatch(/allPassed \? "pass"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — service contract", () => {
  it("exports verifyProposal", () => {
    expect(service).toMatch(/export async function verifyProposal/);
  });

  it("imports recordVerificationResult from repairProposalService", () => {
    expect(service).toMatch(/recordVerificationResult/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("uses ACTOR_KINDS.VERIFICATION_WORKER as actor", () => {
    expect(service).toMatch(/ACTOR_KINDS\.VERIFICATION_WORKER/);
  });

  it("passes actor_kind to recordVerificationResult", () => {
    expect(service).toMatch(/actor_kind:\s*ACTOR/);
  });

  it("imports verifyArtifact from patchArtifactStore", () => {
    expect(service).toMatch(/verifyArtifact/);
    expect(service).toMatch(/from.*patchArtifactStore/);
  });

  it("imports from sandboxRunner", () => {
    expect(service).toMatch(/from.*sandboxRunner/);
    expect(service).toMatch(/buildValidationPlan/);
    expect(service).toMatch(/runSandboxVerification/);
    expect(service).toMatch(/computeVerificationFingerprint/);
  });

  it("imports GitHub client for source acquisition", () => {
    expect(service).toMatch(/acquireSourceSnapshot/);
  });

  it("does NOT create branches or PRs", () => {
    expect(service).not.toMatch(/createBranch|createPullRequest|createCommit/);
  });

  it("does NOT make network requests", () => {
    expect(service).not.toMatch(/fetch\(|axios|octokit\.request/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — worker contract", () => {
  it("exports startVerificationWorker", () => {
    expect(worker).toMatch(/export function startVerificationWorker/);
  });

  it("processes 'verification' queue", () => {
    expect(worker).toMatch(/"verification"/);
  });

  it("uses concurrency 1", () => {
    expect(worker).toMatch(/concurrency:\s*1/);
  });

  it("imports verifyProposal from verificationWorkerService", () => {
    expect(worker).toMatch(/import.*verifyProposal.*verificationWorkerService/);
  });

  it("imports GitHub client for source snapshot", () => {
    expect(worker).toMatch(/getInstallationClient|wrapOctokit/);
  });

  it("passes correlationId to verifyProposal", () => {
    expect(worker).toMatch(/correlationId/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH WORKER — enqueues verification after patch proposed
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — patch worker integration", () => {
  it("patch worker imports verificationQueue", () => {
    expect(patchWorker).toMatch(/verificationQueue/);
  });

  it("patch worker enqueues verification after proposed", () => {
    expect(patchWorker).toMatch(/verificationQueue\.add/);
    expect(patchWorker).toMatch(/verify.*proposalId/);
  });

  it("only enqueues when status is proposed", () => {
    expect(patchWorker).toMatch(/proposal\.status === "proposed"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE CONTRACT — public API remains read-only
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — route contract", () => {
  it("mutation routes still return 403", () => {
    expect(routes).toMatch(/router\.post\("\/"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.patch\("\/:id\/evidence"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.post\("\/:id\/transition"[\s\S]*?403/s);
  });

  it("routes do not import verificationWorkerService", () => {
    expect(routes).not.toMatch(/verificationWorkerService/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — infrastructure", () => {
  it("QUEUES includes VERIFICATION in core", () => {
    expect(queueCore).toMatch(/VERIFICATION.*"verification"/);
  });

  it("verificationQueue singleton in runtime compat", () => {
    expect(runtimeCompat).toMatch(/verificationQueue.*VERIFICATION/);
  });

  it("verificationQueue exported from runtime compat", () => {
    expect(runtimeCompat).toMatch(/export const verificationQueue/);
  });

  it("verificationQueue re-exported from web lib/queue.js", () => {
    expect(webQueue).toMatch(/verificationQueue/);
  });

  it("startVerificationWorker imported in index.js", () => {
    expect(indexJs).toMatch(/import.*startVerificationWorker/);
  });

  it("startVerificationWorker called in workers array", () => {
    expect(indexJs).toMatch(/startVerificationWorker\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOUNDARY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Verification Worker — boundary enforcement", () => {
  it("service does NOT import github.js", () => {
    expect(service).not.toMatch(/from.*github\.js/);
  });

  it("service does NOT write to repository", () => {
    expect(service).not.toMatch(/createCommit|createBranch|createPullRequest|gitPush/);
  });

  it("sandbox runner does NOT execute real commands", () => {
    expect(sandboxRunner).not.toMatch(/child_process|execSync|execFileSync/);
  });

  it("service header documents source acquisition boundaries", () => {
    expect(service).toMatch(/READ-ONLY GitHub client OUTSIDE the sandbox/);
    expect(service).toMatch(/sandbox executor receives NO GitHub credentials/);
  });
});
