// tests/unit/diagnosis-worker.test.js
// Source-reading tests for the diagnosis worker service and contracts.
//
// Validates:
// - Pure diagnosis engine produces valid structured output
// - Evidence binding enforcement (every claim references collected evidence)
// - Status gate (only evidence_collected)
// - Authority enforcement (actor_kind: diagnosis_worker, no transitions)
// - Idempotency (skip if diagnosis exists)
// - Worker contract (queue name, concurrency, no GitHub imports)
// - Route contract (public API remains read-only)
// - Infrastructure (queue registered, worker registered)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

// ════════════════════════════════════════════════════════════════════════════
// IMPORTS (source-reading approach — no DB needed)
// ════════════════════════════════════════════════════════════════════════════

const service = readSource("packages/web/src/services/diagnosisWorkerService.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");
const authorityService = readSource("packages/web/src/services/repairAuthorityService.js");
const worker = readSource("packages/web/src/workers/diagnosisWorker.js");
const ciWorker = readSource("packages/web/src/workers/ciEvidenceWorker.js");
const routes = readSource("packages/web/src/routes/repairs.js");
const queueCore = readSource("packages/core/src/index.js");
const runtimeCompat = readSource("packages/runtime/compat/queue.js");
const webQueue = readSource("packages/web/src/lib/queue.js");
const indexJs = readSource("packages/web/src/index.js");

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS ENGINE — PURE FUNCTION CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — diagnosis engine (pure functions)", () => {
  it("exports diagnoseFromEvidence", () => {
    expect(service).toMatch(/export function diagnoseFromEvidence/);
  });

  it("produces all required diagnosis fields", () => {
    // The engine must populate: summary, failure_category, root_cause_claim,
    // confidence, evidence_ids, and limitations when no excerpts
    expect(service).toMatch(/summary/);
    expect(service).toMatch(/failure_category/);
    expect(service).toMatch(/root_cause_claim/);
    expect(service).toMatch(/confidence/);
    expect(service).toMatch(/evidence_ids/);
    expect(service).toMatch(/limitations/);
  });

  it("references every evidence ref via evidence_ids", () => {
    // evidence_ids must be derived from evidenceRefs source field
    expect(service).toMatch(/evidenceRefs\.map.*r\.source|evidenceIds.*=.*evidenceRefs.*source/s);
  });

  it("throws when evidence_refs is empty", () => {
    expect(service).toMatch(/Cannot diagnose without evidence refs/);
  });

  it("confidence is medium when log excerpts exist, low otherwise", () => {
    expect(service).toMatch(/excerpts\.length > 0.*medium.*low/s);
  });

  it("categorizes failures deterministically", () => {
    expect(service).toMatch(/categorizeFailure/);
    expect(service).toMatch(/syntax_error|type_error|dependency_error|timeout|test_failure|build_error|auth_error/);
  });

  it("truncates summary to max length", () => {
    expect(service).toMatch(/MAX_SUMMARY_LENGTH/);
    expect(service).toMatch(/summary\.substring/);
  });

  it("truncates root_cause to max length", () => {
    expect(service).toMatch(/MAX_ROOT_CAUSE_LENGTH/);
    expect(service).toMatch(/rootCause\.substring/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS PIPELINE — diagnoseProposal CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — diagnoseProposal pipeline", () => {
  it("exports diagnoseProposal", () => {
    expect(service).toMatch(/export async function diagnoseProposal/);
  });

  it("requires proposalId", () => {
    expect(service).toMatch(/proposalId is required/);
  });

  it("fetches the proposal via getProposal", () => {
    expect(service).toMatch(/getProposal/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("rejects proposals not in evidence_collected", () => {
    expect(service).toMatch(/Diagnosis requires status 'evidence_collected'/);
  });

  it("skips when diagnosis already exists (idempotent)", () => {
    expect(service).toMatch(/already has diagnosis/i);
    expect(service).toMatch(/return proposal/);
  });

  it("rejects when proposal has no evidence_refs", () => {
    expect(service).toMatch(/Proposal has no evidence_refs/);
  });

  it("validates diagnosis schema via validateDiagnosis", () => {
    expect(service).toMatch(/validateDiagnosis/);
    expect(service).toMatch(/from.*repairProposalService/);
  });

  it("validates evidence binding via validateDiagnosisEvidenceBinding", () => {
    expect(service).toMatch(/validateDiagnosisEvidenceBinding/);
    expect(service).toMatch(/from.*repairProposalService/);
    expect(service).toMatch(/validateDiagnosisEvidenceBinding\(diagnosis, evidenceRefs\)/);
  });

  it("attaches through authorized path via attachEvidence", () => {
    expect(service).toMatch(/attachEvidence/);
  });

  it("uses ACTOR_KINDS.DIAGNOSIS_WORKER as actor", () => {
    expect(service).toMatch(/ACTOR_KINDS.DIAGNOSIS_WORKER/);
  });

  it("passes actor_kind to attachEvidence", () => {
    // ACTOR_KINDS.DIAGNOSIS_WORKER is passed as the last arg to attachEvidence
    expect(service).toMatch(/ACTOR_KINDS\.DIAGNOSIS_WORKER/);
    expect(service).toMatch(/attachEvidence/);
  });

  it("passes correlation_id to attachEvidence", () => {
    expect(service).toMatch(/correlation_id/);
  });

  it("does NOT import transitionProposal", () => {
    expect(service).not.toMatch(/import.*transitionProposal/);
  });

  it("does NOT call transitionProposal", () => {
    expect(service).not.toMatch(/transitionProposal\(/);
  });

  it("does NOT import GitHub client", () => {
    expect(service).not.toMatch(/getInstallationClient|wrapOctokit|octokit/);
  });

  it("does NOT import from ciEvidenceCollectorService", () => {
    expect(service).not.toMatch(/ciEvidenceCollectorService/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE BINDING — validateDiagnosisEvidenceBinding
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — evidence binding validation", () => {
  it("exports validateDiagnosisEvidenceBinding from repairProposalService", () => {
    expect(repairService).toMatch(/export function validateDiagnosisEvidenceBinding/);
  });

  it("requires diagnosis to have evidence_ids", () => {
    expect(repairService).toMatch(/Diagnosis must reference at least one evidence item/);
  });

  it("rejects evidence_ids that are not in collected evidence", () => {
    expect(repairService).toMatch(/references evidence not in proposal/);
  });

  it("rejects empty evidence_refs on proposal", () => {
    expect(repairService).toMatch(/No evidence refs available on proposal/);
  });

  it("extracts collected sources from evidence_refs", () => {
    expect(repairService).toMatch(/collectedSources/);
    expect(repairService).toMatch(/ref\.source/);
  });

  it("returns valid:true when all evidence_ids match", () => {
    // The function should have a valid return path
    expect(repairService).toMatch(/valid: true/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHORITY MATRIX — diagnosis_worker permissions
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — authority matrix", () => {
  it("diagnosis_worker can only write 'diagnosis' field", () => {
    // In FIELD_PERMISSIONS, DIAGNOSIS_WORKER maps to Set with "diagnosis"
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.DIAGNOSIS_WORKER\]:\s*new Set\(\["diagnosis"\]\)/);
  });

  it("diagnosis_worker has empty transition permissions", () => {
    // In TRANSITION_PERMISSIONS, DIAGNOSIS_WORKER maps to an empty Set
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.DIAGNOSIS_WORKER\]:\s*new Set\(\),/);
  });

  it("diagnosis_worker cannot create proposals", () => {
    // In CREATE_PROPOSAL_PERMISSIONS, DIAGNOSIS_WORKER maps to false
    expect(authorityService).toMatch(/\[ACTOR_KINDS\.DIAGNOSIS_WORKER\]:\s*false/);
  });

  it("FIELD_PERMISSIONS for diagnosis_worker only has 'diagnosis'", () => {
    // Extract the line for DIAGNOSIS_WORKER in FIELD_PERMISSIONS
    const match = authorityService.match(/\[ACTOR_KINDS\.DIAGNOSIS_WORKER\]:\s*new Set\(\[([^\]]*)\]\)/);
    expect(match).toBeTruthy();
    expect(match[1]).toBe("\"diagnosis\"");
  });

  it("diagnosis_worker cannot write evidence_refs (field permission check)", () => {
    // Only ci_evidence_collector can write evidence_refs
    const fieldPermsSection = authorityService.split("FIELD_PERMISSIONS")[1].split("TRANSITION_PERMISSIONS")[0];
    const diagLine = fieldPermsSection.match(/DIAGNOSIS_WORKER\]:\s*new Set\(\[([^\]]*)\]\)/);
    expect(diagLine[1]).not.toMatch(/evidence_refs/);
  });

  it("diagnosis_worker cannot write patch_proposal (field permission check)", () => {
    const fieldPermsSection = authorityService.split("FIELD_PERMISSIONS")[1].split("TRANSITION_PERMISSIONS")[0];
    const diagLine = fieldPermsSection.match(/DIAGNOSIS_WORKER\]:\s*new Set\(\[([^\]]*)\]\)/);
    expect(diagLine[1]).not.toMatch(/patch_proposal/);
  });

  it("diagnosis_worker cannot write critic_review (field permission check)", () => {
    const fieldPermsSection = authorityService.split("FIELD_PERMISSIONS")[1].split("TRANSITION_PERMISSIONS")[0];
    const diagLine = fieldPermsSection.match(/DIAGNOSIS_WORKER\]:\s*new Set\(\[([^\]]*)\]\)/);
    expect(diagLine[1]).not.toMatch(/critic_review/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ROUTE CONTRACT — public API remains read-only
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — route contract", () => {
  it("mutation routes still return 403", () => {
    expect(routes).toMatch(/router\.post\("\/"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.patch\("\/:id\/evidence"[\s\S]*?403/s);
    expect(routes).toMatch(/router\.post\("\/:id\/transition"[\s\S]*?403/s);
  });

  it("routes do not import diagnosisWorkerService", () => {
    expect(routes).not.toMatch(/diagnosisWorkerService/);
  });

  it("routes do not import diagnoseProposal", () => {
    expect(routes).not.toMatch(/diagnoseProposal/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WORKER CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — worker contract", () => {
  it("exports startDiagnosisWorker", () => {
    expect(worker).toMatch(/export function startDiagnosisWorker/);
  });

  it("processes 'diagnosis' queue", () => {
    expect(worker).toMatch(/"diagnosis"/);
  });

  it("uses concurrency 1 (sequential per proposal)", () => {
    expect(worker).toMatch(/concurrency:\s*1/);
  });

  it("imports diagnoseProposal from diagnosisWorkerService", () => {
    expect(worker).toMatch(/import.*diagnoseProposal.*diagnosisWorkerService/);
  });

  it("does NOT import GitHub client", () => {
    expect(worker).not.toMatch(/getInstallationClient|wrapOctokit/);
  });

  it("does NOT import ciEvidenceCollectorService", () => {
    expect(worker).not.toMatch(/ciEvidenceCollectorService/);
  });

  it("passes correlationId to diagnoseProposal", () => {
    expect(worker).toMatch(/correlationId/);
  });

  it("logs job start and completion", () => {
    expect(worker).toMatch(/Processing diagnosis job/);
    expect(worker).toMatch(/Diagnosis completed|Diagnosis job failed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CI EVIDENCE WORKER — enqueues diagnosis after collection
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — CI evidence worker integration", () => {
  it("CI evidence worker imports diagnosisQueue", () => {
    expect(ciWorker).toMatch(/diagnosisQueue/);
  });

  it("enqueues diagnosis job when proposal is evidence_collected", () => {
    expect(ciWorker).toMatch(/proposal\.status === "evidence_collected"/);
    expect(ciWorker).toMatch(/diagnosisQueue\.add/);
  });

  it("uses proposal ID as jobId for dedup", () => {
    expect(ciWorker).toMatch(/jobId.*diagnosis:.*proposal/);
  });

  it("uses priority 3 (lower than evidence collection)", () => {
    expect(ciWorker).toMatch(/priority:\s*3/);
  });

  it("does NOT enqueue when proposal is not evidence_collected", () => {
    // The if guard ensures we only enqueue on evidence_collected status
    expect(ciWorker).toMatch(/if.*proposal\.status === "evidence_collected"/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — infrastructure", () => {
  it("QUEUES.CI_EVIDENCE exists alongside DIAGNOSIS in core", () => {
    expect(queueCore).toMatch(/CI_EVIDENCE.*"ci-evidence"/);
    expect(queueCore).toMatch(/DIAGNOSIS.*"diagnosis"/);
  });

  it("diagnosisQueue singleton in runtime compat", () => {
    expect(runtimeCompat).toMatch(/diagnosisQueue.*DIAGNOSIS/);
  });

  it("diagnosisQueue exported from runtime compat", () => {
    expect(runtimeCompat).toMatch(/export const diagnosisQueue/);
  });

  it("diagnosisQueue re-exported from web lib/queue.js", () => {
    expect(webQueue).toMatch(/diagnosisQueue/);
  });

  it("startDiagnosisWorker imported in index.js", () => {
    expect(indexJs).toMatch(/import.*startDiagnosisWorker/);
  });

  it("startDiagnosisWorker called in workers array", () => {
    expect(indexJs).toMatch(/startDiagnosisWorker\(\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BOUNDARY ENFORCEMENT — no tool/repo expansion
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — boundary enforcement", () => {
  it("service does NOT import github.js", () => {
    expect(service).not.toMatch(/from.*github\.js/);
  });

  it("service does NOT import githubWrapper", () => {
    expect(service).not.toMatch(/githubWrapper/);
  });

  it("service does NOT make HTTP requests", () => {
    expect(service).not.toMatch(/fetch\(|axios|http\.request|octokit\.request/);
  });

  it("service does NOT write to repository", () => {
    expect(service).not.toMatch(/createCommit|createBranch|createPullRequest|gitPush/);
  });

  it("service does NOT generate patches", () => {
    expect(service).not.toMatch(/patch_proposal|generatePatch|diffPatch/);
  });

  it("service imports from repairProposalService only (not collectors)", () => {
    expect(service).toMatch(/from.*repairProposalService\.js/);
    expect(service).toMatch(/from.*repairAuthorityService\.js/);
  });

  it("service has header documenting boundaries", () => {
    expect(service).toMatch(/No lifecycle transition authority/);
    expect(service).toMatch(/No repository writes.*patch generation.*new GitHub reads/);
    expect(service).toMatch(/Every diagnosis claim must reference collected evidence/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EVIDENCE REFS WRITE-ONCE — P0 fix: evidence_refs reserved for recordCiEvidenceCollection
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — evidence_refs write-once contract", () => {
  it("attachEvidence rejects evidence_refs", () => {
    expect(repairService).toMatch(/evidence_refs may only be recorded by recordCiEvidenceCollection/);
  });

  it("attachEvidence does NOT include evidence_refs in fields array", () => {
    // Extract just the `const fields = [...]` array literal from attachEvidence
    const section = repairService.split("export async function attachEvidence");
    const fieldsMatch = section[1].match(/const fields = \[([\s\S]*?)\];/);
    expect(fieldsMatch).toBeTruthy();
    expect(fieldsMatch[1]).not.toMatch(/evidence_refs/);
  });

  it("recordCiEvidenceCollection is the sole path for evidence_refs writes", () => {
    const section = repairService.split("export async function recordCiEvidenceCollection");
    expect(section[1]).toMatch(/evidence_refs/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS EVIDENCE BINDING — P1 fix: enforced inside attachEvidence
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — evidence binding inside attachEvidence", () => {
  it("attachEvidence calls validateDiagnosisEvidenceBinding after row lock", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/validateDiagnosisEvidenceBinding/);
  });

  it("binding check uses proposal evidence_refs from locked row", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/parseJsonb\(proposal\.evidence_refs\)/);
  });

  it("binding failure throws with descriptive message", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/Diagnosis evidence binding failed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CANONICAL DIAGNOSIS WORKER BOUNDARIES — lifecycle gate + write-once in attachEvidence
// ════════════════════════════════════════════════════════════════════════════

describe("Diagnosis Worker — canonical lifecycle gate and write-once", () => {
  it("attachEvidence enforces evidence_collected for diagnosis_worker", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/diagnosis_worker requires status 'evidence_collected'/);
  });

  it("attachEvidence returns existing proposal when diagnosis already exists", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/Diagnosis already exists.*canonical no-op/);
    expect(section[1]).toMatch(/return redactProposal\(proposal\)/);
  });

  it("lifecycle check is guarded by actor_kind === DIAGNOSIS_WORKER", () => {
    const section = repairService.split("export async function attachEvidence");
    expect(section[1]).toMatch(/actor_kind === ACTOR_KINDS\.DIAGNOSIS_WORKER.*evidence\.diagnosis/s);
  });
});
