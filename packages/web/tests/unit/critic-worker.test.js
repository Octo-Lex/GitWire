// tests/unit/critic-worker.test.js
// Source-reading tests for the critic worker service and contracts.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const service = readSource("packages/web/src/services/criticWorkerService.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");
const authorityService = readSource("packages/web/src/services/repairAuthorityService.js");
const worker = readSource("packages/web/src/workers/criticWorker.js");
const routes = readSource("packages/web/src/routes/repairs.js");
const queueCore = readSource("packages/core/src/index.js");
const runtimeCompat = readSource("packages/runtime/compat/queue.js");
const webQueue = readSource("packages/web/src/lib/queue.js");
const indexJs = readSource("packages/web/src/index.js");

// ════════════════════════════════════════════════════════════════════════════
// RECORD CRITIC REVIEW — canonical transactional method
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — recordCriticReview canonical method", () => {
  it("exports recordCriticReview from repairProposalService", () => {
    expect(repairService).toMatch(/export async function recordCriticReview/);
  });

  it("requires actor_kind: critic_worker", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/requireActorKind\(actor_kind\)/);
    expect(section[1]).toMatch(/canAttachField\(actor_kind, "critic_review"\)/);
  });

  it("unconditionally rejects approve (P0 interim)", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/no receipt backend available/);
  });

  it("approve rejection comes before any transaction", () => {
    const section = repairService.split("export async function recordCriticReview");
    const approveIdx = section[1].indexOf("no receipt backend available");
    const txIdx = section[1].indexOf("db.transaction");
    expect(approveIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(-1);
    expect(approveIdx).toBeLessThan(txIdx);
  });

  it("enforces verified status after row lock", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/Critic review requires status 'verified'/);
  });

  it("requires patch_proposal to exist", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/patch_proposal must exist/);
  });

  it("requires validation_result to exist and be pass", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/validation_result must exist/);
    expect(section[1]).toMatch(/validation_result\.overall must be 'pass'/);
  });

  it("recomputes critic_input_hash from locked proposal state", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/buildCriticInputBundle\(proposal\)/);
    expect(section[1]).toMatch(/canonicalInputHash/);
    expect(section[1]).toMatch(/does not match canonical hash/);
  });

  it("recomputes review_fingerprint from canonical values", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/canonicalReviewFingerprint/);
    expect(section[1]).toMatch(/does not match canonical fingerprint/);
  });

  it("persists only recomputed values", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/review_fingerprint: canonicalReviewFingerprint/);
    expect(section[1]).toMatch(/critic_input_hash: canonicalInputHash/);
  });

  it("validates findings (P1b)", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/validateCriticFindings/);
  });

  it("records one critic_review_recorded event", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/critic_review_recorded/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0: UNCONDITIONAL APPROVE REJECTION
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — P0: unconditional approve gate", () => {
  it("approve is rejected before transaction body", () => {
    const section = repairService.split("export async function recordCriticReview");
    const approveIdx = section[1].indexOf("no receipt backend available");
    const txIdx = section[1].indexOf("db.transaction");
    expect(approveIdx).toBeLessThan(txIdx);
  });

  it("does not check for receipt presence (no hasVerifiedReceipt variable)", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).not.toMatch(/hasVerifiedReceipt/);
  });

  it("does not resolve artifacts in the approve path", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).not.toMatch(/verifyArtifact/);
  });

  it("target status is always 'failed'", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/targetStatus = "failed"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1a: CANONICAL HASH RECOMPUTATION
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — P1a: canonical recomputation", () => {
  it("buildCriticInputBundle is exported from repairProposalService", () => {
    expect(repairService).toMatch(/export function buildCriticInputBundle/);
  });

  it("computeReviewFingerprint is exported from repairProposalService", () => {
    expect(repairService).toMatch(/export function computeReviewFingerprint/);
  });

  it("worker imports buildCriticInputBundle from repairProposalService", () => {
    expect(service).toMatch(/buildCriticInputBundle/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("worker imports computeReviewFingerprint from repairProposalService", () => {
    expect(service).toMatch(/computeReviewFingerprint/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("worker no longer defines its own buildCriticInputBundle", () => {
    expect(service).not.toMatch(/export function buildCriticInputBundle/);
  });

  it("computeReviewFingerprint normalizes findings (sorted by code)", () => {
    expect(repairService).toMatch(/sort\(.*localeCompare/);
  });

  it("computeReviewFingerprint normalizes blocking_findings (sorted)", () => {
    expect(repairService).toMatch(/normalizedBlocking.*sort/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1b: FINDING VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — P1b: finding validation", () => {
  it("VALID_FINDING_CODES exported", () => {
    expect(repairService).toMatch(/export const VALID_FINDING_CODES/);
  });

  it("VALID_FINDING_SEVERITIES exported", () => {
    expect(repairService).toMatch(/export const VALID_FINDING_SEVERITIES/);
  });

  it("validateCriticFindings function exists", () => {
    expect(repairService).toMatch(/function validateCriticFindings/);
  });

  it("validates finding codes against allowlist", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/VALID_FINDING_CODES/);
  });

  it("validates finding severities against allowlist", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/VALID_FINDING_SEVERITIES/);
  });

  it("requires approve → zero blocking findings", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/approve.*zero blocking findings/);
  });

  it("requires reject → at least one blocking finding", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/reject.*at least one blocking finding/);
  });

  it("requires every blocking finding to have a matching finding", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/no matching finding with severity: blocking/);
  });

  it("requires finding detail to be non-empty", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/missing or empty detail/);
  });

  it("validates evidence_ref against locked bundle", () => {
    const section = repairService.split("function validateCriticFindings");
    expect(section[1]).toMatch(/evidence_ref is not bound/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLAY SAFETY
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — replay safety", () => {
  it("same fingerprint returns no-op", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/same fingerprint.*replay no-op/);
  });

  it("different fingerprint rejects", () => {
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/different fingerprint/);
    expect(section[1]).toMatch(/retries require an explicit revision contract/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CRITIC_REVIEW RESERVED
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — critic_review reserved", () => {
  it("attachEvidence rejects critic_review unconditionally", () => {
    expect(repairService).toMatch(/critic_review may only be recorded by recordCriticReview/);
  });

  it("attachEvidence does NOT include critic_review in fields array", () => {
    const section = repairService.split("export async function attachEvidence");
    const fieldsMatch = section[1].match(/const fields = \[([\s\S]*?)\];/);
    expect(fieldsMatch).toBeTruthy();
    expect(fieldsMatch[1]).not.toMatch(/critic_review/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY STATES — review_ready blocked from generic transition
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — review_ready in AUTHORITY_STATES", () => {
  it("AUTHORITY_STATES includes review_ready", () => {
    expect(repairService).toMatch(/AUTHORITY_STATES.*"review_ready"/s);
  });

  it("generic transition to review_ready rejects", () => {
    const section = repairService.split("export async function transitionProposal");
    expect(section[1]).toMatch(/requires a dedicated authority-bound endpoint/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY MATRIX
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — authority matrix", () => {
  it("critic_worker can only write 'critic_review' field", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.CRITIC_WORKER\]:\s*new Set\(\["critic_review"\]\)/);
  });

  it("critic_worker can transition to review_ready and failed", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.CRITIC_WORKER\]:\s*new Set\(\["review_ready", "failed"\]\)/);
  });

  it("critic_worker cannot create proposals", () => {
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.CRITIC_WORKER\]:\s*false/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVICE CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — service contract", () => {
  it("exports reviewProposal", () => {
    expect(service).toMatch(/export async function reviewProposal/);
  });

  it("exports assessCriticInput", () => {
    expect(service).toMatch(/export function assessCriticInput/);
  });

  it("imports buildCriticInputBundle and computeReviewFingerprint from repairProposalService", () => {
    expect(service).toMatch(/buildCriticInputBundle/);
    expect(service).toMatch(/computeReviewFingerprint/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("uses ACTOR_KINDS.CRITIC_WORKER as actor", () => {
    expect(service).toMatch(/ACTOR_KINDS\.CRITIC_WORKER/);
  });

  it("does NOT import GitHub client", () => {
    expect(service).not.toMatch(/getInstallationClient|wrapOctokit/);
  });

  it("does NOT create branches or PRs", () => {
    expect(service).not.toMatch(/createBranch|createPullRequest|createCommit/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — worker contract", () => {
  it("exports startCriticWorker", () => {
    expect(worker).toMatch(/export function startCriticWorker/);
  });

  it("processes 'critic' queue", () => {
    expect(worker).toMatch(/"critic"/);
  });

  it("uses concurrency 1", () => {
    expect(worker).toMatch(/concurrency:\s*1/);
  });

  it("imports reviewProposal from criticWorkerService", () => {
    expect(worker).toMatch(/import.*reviewProposal.*criticWorkerService/);
  });

  it("does NOT import GitHub client", () => {
    expect(worker).not.toMatch(/getInstallationClient|wrapOctokit/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — route contract", () => {
  it("mutation routes still return 403", () => {
    expect(routes).toMatch(/router\.post\("\/"[\s\S]*?403/s);
  });

  it("routes do not import criticWorkerService", () => {
    expect(routes).not.toMatch(/criticWorkerService/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — infrastructure", () => {
  it("QUEUES includes CRITIC in core", () => {
    expect(queueCore).toMatch(/CRITIC.*"critic"/);
  });

  it("criticQueue singleton in runtime compat", () => {
    expect(runtimeCompat).toMatch(/criticQueue.*CRITIC/);
  });

  it("criticQueue exported from runtime compat", () => {
    expect(runtimeCompat).toMatch(/export const criticQueue/);
  });

  it("criticQueue re-exported from web lib/queue.js", () => {
    expect(webQueue).toMatch(/criticQueue/);
  });

  it("startCriticWorker imported in index.js", () => {
    expect(indexJs).toMatch(/import.*startCriticWorker/);
  });

  it("startCriticWorker called in workers array", () => {
    expect(indexJs).toMatch(/startCriticWorker\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOUNDARY ENFORCEMENT
// ════════════════════════════════════════════════════════════════════════════

describe("Critic Worker — boundary enforcement", () => {
  it("service does NOT import github.js", () => {
    expect(service).not.toMatch(/from.*github\.js/);
  });

  it("service does NOT write to repository", () => {
    expect(service).not.toMatch(/createCommit|createBranch|createPullRequest|gitPush/);
  });

  it("service header documents boundaries", () => {
    expect(service).toMatch(/No GitHub API calls/);
    expect(service).toMatch(/no branch.*PR creation/);
  });
});
