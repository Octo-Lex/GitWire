// src/services/auth/workerAdoptionRegistry.js
//
// Non-HTTP adoption gate (Wave 2 / issue #94).
//
// Three adoption states, each progressively stronger:
//
//   declared — the surface appears in declarations.js (every non-HTTP
//     surface must be declared; this is the completeness contract).
//
//   wired — the surface's source module contains an adoptWorker() call
//     (or equivalent adoption seam) at the entry point that runs before
//     every side effect. Source presence alone is NOT sufficient — the
//     gate carries structured per-surface metadata documenting:
//       - entry_module + exported_symbol (where the handler lives)
//       - adoption_location (where adoptWorker is called)
//       - principal_origin (system constant vs trusted installationId)
//       - permission + resource_origin (what authorize() receives)
//       - first_side_effect (the first domain write)
//       - principal_destination (where principalId ends up)
//
//   proven — the surface has a passing disposable integration proof that
//     exercises the real handler against real PG+Redis and asserts the
//     observable effects (auth_decision_log row, domain write, gap=0).
//     Only proven surfaces count toward the adoption metric.
//
// The completeness check reports all three layers AND the structured
// metadata so a reviewer can audit the adoption path for each surface.

/**
 * Per-surface adoption metadata.
 *
 * Each entry documents the full adoption path for a surface, not just
 * "an adoptWorker call exists somewhere." The fields follow the reviewer's
 * required schema (issue #94 review).
 *
 * @typedef {Object} SurfaceMetadata
 * @property {string} entry_module - source file of the handler
 * @property {string} exported_symbol - the function that processes jobs
 * @property {string} adoption_location - file:line where adoptWorker is called
 * @property {string} principal_origin - how the principal is resolved
 * @property {string} permission - the declared permission
 * @property {string} resource_origin - how the resource is resolved
 * @property {string} first_side_effect - the first domain write
 * @property {string} principal_destination - where principalId ends up
 * @property {string} [proof_command] - the proof command (if proven)
 * @property {number} [proof_checks] - check count (if proven)
 */

/**
 * WIRING: surfaces with a real adoptWorker() call at their entry point.
 *
 * MAINTAINED BY HAND to match the actual source. Each entry documents the
 * full adoption path. When you add/remove an adoptWorker() call, update
 * the corresponding entry here.
 *
 * NOTE on scheduled:* surfaces: these are BullMQ repeatable jobs enqueued
 * by scheduler functions. The scheduler producer is a SEPARATE entry point
 * from the worker consumer. A scheduled surface is NOT wired merely because
 * its downstream worker calls adoptWorker() — the scheduler itself must
 * resolve a server-owned principal before enqueuing. This is tracked
 * separately below in SCHEDULER_WIRING.
 */
const WIRING = {
  // ── Workers (14) ──────────────────────────────────────────────────────────
  "worker:webhook": {
    entry_module: "packages/web/src/routes/webhooks.js",
    exported_symbol: "webhookRouter POST /",
    adoption_location: "webhooks.js:81",
    principal_origin: "installationId from HMAC-verified webhook payload",
    permission: "installation:read",
    resource_origin: "resolveRepositoryResource (DB lookup by installation + repo)",
    first_side_effect: "triageQueue.add / ciHealQueue.add",
    principal_destination: "job.data via webhookPrincipalId → downstream worker adoption",
  },
  "worker:triage": {
    entry_module: "packages/web/src/workers/triageWorker.js",
    exported_symbol: "triageIssue, triagePR",
    adoption_location: "triageWorker.js:51 (triageIssue), :298 (triagePR)",
    principal_origin: "installationId from webhook-verified payload.installation.id",
    permission: "issue:update",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "logDecision (decision_log INSERT)",
    principal_destination: "logDecision principalId → decision_log.principal_id",
  },
  "worker:ciHeal": {
    entry_module: "packages/web/src/workers/ciHealWorker.js",
    exported_symbol: "startCIHealWorker (inline handler)",
    adoption_location: "ciHealWorker.js:191",
    principal_origin: "systemPrincipalName='system:ci-heal-worker'",
    permission: "repository:github:act",
    resource_origin: "resolveSystemWorkerContext",
    first_side_effect: "Trail.ciHeal (audit_trail_entries INSERT)",
    principal_destination: "Trail + logDecision + propose principalId",
  },
  "worker:sync": {
    entry_module: "packages/web/src/workers/syncWorker.js",
    exported_symbol: "runFullSync",
    adoption_location: "syncWorker.js:64",
    principal_origin: "systemPrincipalName='system:scheduler'",
    permission: "installation:read",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "upsertInstallation + upsertRepo",
    principal_destination: "logDecision principalId (sync audit)",
  },
  "worker:ciEvidence": {
    entry_module: "packages/web/src/workers/ciEvidenceWorker.js",
    exported_symbol: "startCIEvidenceWorker (inline handler)",
    adoption_location: "ciEvidenceWorker.js:30",
    principal_origin: "installationId from job data (HMAC-verified enqueue)",
    permission: "ci_run:read",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "collectForFailedRun → createProposal",
    principal_destination: "{ principalId } passed to collectForFailedRun options",
  },
  "worker:diagnosis": {
    entry_module: "packages/web/src/workers/diagnosisWorker.js",
    exported_symbol: "startDiagnosisWorker (inline handler)",
    adoption_location: "diagnosisWorker.js:30",
    principal_origin: "systemPrincipalName='system:diagnosis-worker'",
    permission: "repair_proposal:read",
    resource_origin: "resolveSystemWorkerContext",
    first_side_effect: "diagnoseProposal → attachEvidence",
    principal_destination: "{ principalId } passed to diagnoseProposal options",
  },
  "worker:patch": {
    entry_module: "packages/web/src/workers/patchWorker.js",
    exported_symbol: "startPatchWorker (inline handler)",
    adoption_location: "patchWorker.js:30",
    principal_origin: "systemPrincipalName='system:patch-worker'",
    permission: "patch_artifact:create",
    resource_origin: "resolveSystemWorkerContext",
    first_side_effect: "generatePatchForProposal → recordPatchProposal",
    principal_destination: "{ principalId } passed to generatePatchForProposal options",
  },
  "worker:verification": {
    entry_module: "packages/web/src/workers/verificationWorker.js",
    exported_symbol: "startVerificationWorker (inline handler)",
    adoption_location: "verificationWorker.js:33",
    principal_origin: "systemPrincipalName='system:verification-worker'",
    permission: "execution_receipt:read",
    resource_origin: "resolveSystemWorkerContext",
    first_side_effect: "verifyProposal → recordVerificationResult",
    principal_destination: "{ principalId } passed to verifyProposal options",
  },
  "worker:critic": {
    entry_module: "packages/web/src/workers/criticWorker.js",
    exported_symbol: "startCriticWorker (inline handler)",
    adoption_location: "criticWorker.js:24",
    principal_origin: "systemPrincipalName='system:critic-worker'",
    permission: "ai_review:create",
    resource_origin: "resolveSystemWorkerContext",
    first_side_effect: "reviewProposal → recordCriticReview",
    principal_destination: "{ principalId } passed to reviewProposal options",
  },
  "worker:maintainer": {
    entry_module: "packages/web/src/workers/maintainerWorker.js",
    exported_symbol: "runStaleScan, runBranchCleanup, runCommentCommand",
    adoption_location: "maintainerWorker.js:33 (top-level, before dispatch)",
    principal_origin: "installationId from job data (scheduler-set from repositories table)",
    permission: "repository:github:act",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "maintainerService.recordAction",
    principal_destination: "principalId passed to sub-handlers (not yet threaded to recordAction)",
  },
  "worker:issueFix": {
    entry_module: "packages/web/src/workers/issueFixWorker.js",
    exported_symbol: "startIssueFixWorker → processFixIssue",
    adoption_location: "issueFixWorker.js:28",
    principal_origin: "installationId from job data, fallback system:issue-fix-worker",
    permission: "pull_request:create",
    resource_origin: "resolveInstallationWorkerContext or resolveSystemWorkerContext",
    first_side_effect: "issueFix/validate.js → propose",
    principal_destination: "{ ...job.data, principalId } passed to processFixIssue ctx",
  },
  "worker:phase2": {
    entry_module: "packages/web/src/workers/phase2Worker.js",
    exported_symbol: "startMergeQueueWorker (inline handler)",
    adoption_location: "phase2Worker.js:27",
    principal_origin: "installationId from payload.installation.id",
    permission: "merge_queue_entry:update",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "admitToQueue / removeFromQueue / evaluateRollback",
    principal_destination: "principalId resolved (services do not yet accept it)",
  },
  "worker:phase3": {
    entry_module: "packages/web/src/workers/phase3Worker.js",
    exported_symbol: "startPhase3Worker (inline handler, 5 job types)",
    adoption_location: "phase3Worker.js:28 (top-level, before switch)",
    principal_origin: "mixed: system base + installationId when available per job type",
    permission: "installation:read",
    resource_origin: "resolveSystemWorkerContext + resolveInstallationWorkerContext",
    first_side_effect: "ingestTestResults / checkGraduation / scanRepo",
    principal_destination: "principalId resolved (services do not yet accept it)",
  },
  "worker:phase4": {
    entry_module: "packages/web/src/workers/phase4Worker.js",
    exported_symbol: "startPhase4Worker (inline handler)",
    adoption_location: "phase4Worker.js:72",
    principal_origin: "installationId from payload",
    permission: "ai_review:create",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "reviewPR",
    principal_destination: "principalId passed to reviewPR",
  },

  // ── Ingress (1 proven) ────────────────────────────────────────────────────
  "telegram:fix": {
    entry_module: "packages/bot/src/commands.js",
    exported_symbol: "registerCommands → bot.command('fix')",
    adoption_location: "commands.js:484 (resolveInstallationId → POST /api/fix)",
    principal_origin: "API key from Redis → Bearer header → route observer resolves principal",
    permission: "issue:create",
    resource_origin: "resolveInstallationId (GET /api/repos/:owner/:repo → installation_id)",
    first_side_effect: "issueFixQueue.add (via /api/fix route)",
    principal_destination: "auth_decision_log.principal_id (via route observer)",
  },
  // telegram:heal — declared but NOT wired. The bot command exists and targets
  // POST /api/ci/:runId/heal (which exists), but no integration proof has been
  // run. Do NOT count as wired without a passing proof.
  // webhook:github — the webhook HTTP route enqueues to worker:webhook, which
  // IS wired. But the ingress surface itself is a separate entry point.
};

/**
 * SCHEDULER_WIRING: scheduled producer surfaces.
 *
 * Each scheduler is a SEPARATE entry point from its worker consumer.
 * A scheduler is wired only if it resolves a server-owned principal before
 * enqueuing. Currently NONE of the schedulers have adoption — they enqueue
 * directly without resolving a principal. This is an explicit gap.
 *
 * The scheduler producers are:
 *   scheduleSyncJobs        → enqueues full-sync, sync-installation, sync-repo
 *   scheduleMaintainerJobs  → enqueues stale-scan, branch-cleanup
 *   schedulePhase3Jobs      → enqueues policy-reconcile-fleet, dependency-scan-fleet, graduation-check
 *   schedulePhase4Jobs      → enqueues phase4 recurring jobs
 *   scheduleReconciliation  → enqueues reconciliation jobs
 */
const SCHEDULER_WIRING = {
  "scheduled:sync": {
    entry_module: "packages/web/src/workers/syncWorker.js",
    exported_symbol: "scheduleSyncJobs",
    adoption_location: "syncWorker.js:48 (inside scheduleSyncJobs, before enqueue)",
    principal_origin: "systemPrincipalName='system:scheduler'",
    status: "wired",
    note: "Scheduler producer resolves system:scheduler before enqueuing full-sync. Consumer (runFullSync) also adopts with the same principal.",
  },
  "scheduled:maintainer": {
    entry_module: "packages/web/src/workers/maintainerWorker.js",
    exported_symbol: "scheduleMaintainerJobs",
    adoption_location: "maintainerWorker.js:407 (inside scheduleMaintainerJobs, before enqueue loop)",
    principal_origin: "systemPrincipalName='system:maintainer-worker'",
    status: "wired",
    note: "Scheduler producer resolves system:maintainer-worker before enqueuing stale-scan and branch-cleanup. Consumer (worker:maintainer) also adopts.",
  },
  "scheduled:phase3": {
    entry_module: "packages/web/src/workers/phase3Worker.js",
    exported_symbol: "schedulePhase3Jobs",
    adoption_location: "phase3Worker.js:147 (inside schedulePhase3Jobs, before enqueue)",
    principal_origin: "systemPrincipalName='system:phase3-worker'",
    status: "wired",
    note: "Scheduler producer resolves system:phase3-worker before enqueuing fleet reconciliation, dep scan, graduation. Consumer (worker:phase3) also adopts.",
  },
  "scheduled:phase4": {
    entry_module: "packages/web/src/workers/phase4Worker.js",
    exported_symbol: "schedulePhase4Jobs",
    adoption_location: "phase4Worker.js:128 (inside schedulePhase4Jobs, before enqueue)",
    principal_origin: "systemPrincipalName='system:phase4-worker'",
    status: "wired",
    note: "Scheduler producer resolves system:phase4-worker before enqueuing nightly-audit-export. Consumer (worker:phase4) also adopts.",
  },
  "scheduled:reconciliation": {
    entry_module: "packages/web/src/workers/reconciliationWorker.js",
    exported_symbol: "runReconciliation",
    adoption_location: "reconciliationWorker.js:26 (inside runReconciliation, before scan)",
    principal_origin: "systemPrincipalName='system:reconciliation-worker'",
    status: "wired",
    note: "Scheduled via setInterval (not BullMQ repeatable). Producer resolves system:reconciliation-worker before scanning.",
  },
};

/**
 * PROVEN: surfaces with a passing disposable integration proof.
 */
const PROVEN = {
  "worker:triage":   { proof_command: "node packages/web/db/proof/run_triage_handler_pg_proof.mjs", proof_checks: 28 },
  "worker:webhook":  { proof_command: "node packages/web/db/proof/run_webhook_vertical_proof.mjs",  proof_checks: 36 },
  "worker:sync":     { proof_command: "node packages/web/db/proof/run_sync_vertical_proof.mjs",     proof_checks: 25 },
  "telegram:fix":    { proof_command: "node packages/web/db/proof/run_telegram_bot_proof.mjs",      proof_checks: 15 },
};

// ── Read-only accessors ────────────────────────────────────────────────────

/**
 * Get the wiring metadata for a surface (or null if not wired).
 */
export function getWiring(surfaceId) {
  return WIRING[surfaceId] || null;
}

/**
 * Get the scheduler wiring metadata for a scheduled surface (or null).
 */
export function getSchedulerWiring(surfaceId) {
  return SCHEDULER_WIRING[surfaceId] || null;
}

/**
 * Check if a surface is wired (has an adoptWorker call at entry).
 */
export function isWired(surfaceId) {
  return Object.prototype.hasOwnProperty.call(WIRING, surfaceId);
}

/**
 * Check if a scheduled surface's producer is wired.
 */
export function isSchedulerWired(surfaceId) {
  return SCHEDULER_WIRING[surfaceId]?.adoption_location != null;
}

/**
 * Get the proof info for a surface (or null if not proven).
 */
export function getProof(surfaceId) {
  return PROVEN[surfaceId] || null;
}

/**
 * Check if a surface is proven (has a passing integration proof).
 */
export function isProven(surfaceId) {
  return Object.prototype.hasOwnProperty.call(PROVEN, surfaceId);
}

/**
 * List all wired surface ids (sorted).
 */
export function listWiredSurfaces() {
  return Object.keys(WIRING).sort();
}

/**
 * List all proven surface ids (sorted).
 */
export function listProvenSurfaces() {
  return Object.keys(PROVEN).sort();
}

/**
 * The 3-state adoption gate with full per-surface metadata.
 *
 * Classifies every declared non-HTTP surface into one of three states
 * (declared, wired, proven) and returns the structured metadata for each
 * wired surface. Also separately tracks scheduler producer adoption.
 *
 * @param {string[]} expectedNonHttpIds - the non-HTTP surface ids from declarations
 * @returns {{
 *   declared: string[],
 *   wired: string[],
 *   proven: string[],
 *   declaredOnly: string[],
 *   wiredOnly: string[],
 *   schedulerStatus: Array<{id: string, wired: boolean, note: string}>,
 *   metadata: Record<string, SurfaceMetadata>,
 *   counts: { declared: number, wired: number, proven: number, schedulersWired: number }
 * }}
 */
export function classifyAdoptionStates(expectedNonHttpIds) {
  const declared = [...expectedNonHttpIds].sort();
  const wired = declared.filter((id) => isWired(id));
  const proven = declared.filter((id) => isProven(id));
  const declaredOnly = declared.filter((id) => !isWired(id));
  const wiredOnly = wired.filter((id) => !isProven(id));

  // Build metadata map for wired surfaces
  const metadata = {};
  for (const id of wired) {
    metadata[id] = WIRING[id];
  }

  // Scheduler producer status
  const schedulerStatus = declared
    .filter((id) => id.startsWith("scheduled:"))
    .map((id) => ({
      id,
      wired: isSchedulerWired(id),
      note: SCHEDULER_WIRING[id]?.note || "no scheduler wiring metadata",
    }));

  return {
    declared,
    wired,
    proven,
    declaredOnly,
    wiredOnly,
    schedulerStatus,
    metadata,
    counts: {
      declared: declared.length,
      wired: wired.length,
      proven: proven.length,
      schedulersWired: schedulerStatus.filter((s) => s.wired).length,
    },
  };
}

// ── Backward compatibility (deprecated) ────────────────────────────────────

const ADOPTED = new Set(Object.keys(WIRING));

export function markWorkerAdopted(workerId) { ADOPTED.add(workerId); }
export function markWorkersAdopted(ids) { for (const id of ids) ADOPTED.add(id); }
export function isWorkerAdopted(workerId) { return ADOPTED.has(workerId); }
export function listAdoptedWorkers() { return [...ADOPTED].sort(); }

/**
 * @deprecated Use classifyAdoptionStates for the 3-state gate.
 */
export function assertWorkerAdoptionCompleteness(expectedNonHttpIds) {
  const missing = expectedNonHttpIds.filter((id) => !ADOPTED.has(id));
  return {
    ok: missing.length === 0,
    missing,
    adopted: ADOPTED.size,
    total: expectedNonHttpIds.length,
  };
}
