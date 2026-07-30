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
  // NOTE: worker:webhook is the BullMQ consumer in webhookWorker.js that
  // processes sync-installation and sync-repo jobs. It has its own adoptWorker
  // call, distinct from the webhook:github HTTP ingress (which is in
  // routes/webhooks.js). Both are wired — they are separate boundaries.
  "worker:webhook": {
    entry_module: "packages/web/src/workers/webhookWorker.js",
    exported_symbol: "startWebhookWorker (handleInstallationSync, handleRepoSync)",
    adoption_location: "webhookWorker.js:16 (top of createWorker handler, before switch)",
    principal_origin: "installationId from payload.installation.id (HMAC-verified enqueue)",
    permission: "installation:read",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "db.query (installations/repositories UPSERT)",
    principal_destination: "principalId threaded to handleInstallationSync/handleRepoSync",
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

  // ── Ingress (2 proven) ────────────────────────────────────────────────────
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
  "telegram:heal": {
    entry_module: "packages/bot/src/commands.js",
    exported_symbol: "registerCommands → bot.command('heal')",
    adoption_location: "commands.js:451 (resolveInstallationId → POST /api/ci/:runId/heal)",
    principal_origin: "API key from Redis → Bearer header → route observer resolves principal",
    permission: "repository:github:act",
    resource_origin: "resolveInstallationId (GET /api/repos/:owner/:repo → installation_id)",
    first_side_effect: "ciHealQueue.add (via /api/ci/:runId/heal route)",
    principal_destination: "auth_decision_log.principal_id (via route observer)",
  },
  // webhook:github — the webhook HTTP route (POST /webhooks/github) is the
  // ingress surface. It verifies HMAC, then calls adoptWorker before enqueuing.
  // The webhook vertical proof covers this path end-to-end.
  "webhook:github": {
    entry_module: "packages/web/src/routes/webhooks.js",
    exported_symbol: "webhookRouter POST /github",
    adoption_location: "webhooks.js:81 (after HMAC verification, before enqueue)",
    principal_origin: "installationId from HMAC-verified webhook payload.installation.id",
    permission: "installation:read",
    resource_origin: "resolveInstallationWorkerContext(installationId)",
    first_side_effect: "triageQueue.add / ciHealQueue.add (via evaluateAndExecuteCustomRules)",
    principal_destination: "job.data via webhookPrincipalId → downstream worker adoption",
  },
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
    permission: "installation:read",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "syncQueue.add (full-sync repeatable + startup)",
    principal_destination: "auth_decision_log.principal_id (scheduler adoption)",
    status: "wired",
    note: "Scheduler producer resolves system:scheduler before enqueuing full-sync. Consumer (runFullSync) also adopts with the same principal.",
  },
  "scheduled:maintainer": {
    entry_module: "packages/web/src/workers/maintainerWorker.js",
    exported_symbol: "scheduleMaintainerJobs",
    adoption_location: "maintainerWorker.js:407 (inside scheduleMaintainerJobs, before enqueue loop)",
    principal_origin: "systemPrincipalName='system:maintainer-worker'",
    permission: "repository:github:act",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "maintainerQueue.add (stale-scan + branch-cleanup per repo)",
    principal_destination: "auth_decision_log.principal_id (scheduler adoption)",
    status: "wired",
    note: "Scheduler producer resolves system:maintainer-worker before enqueuing stale-scan and branch-cleanup. Consumer (worker:maintainer) also adopts.",
  },
  "scheduled:phase3": {
    entry_module: "packages/web/src/workers/phase3Worker.js",
    exported_symbol: "schedulePhase3Jobs",
    adoption_location: "phase3Worker.js:147 (inside schedulePhase3Jobs, before enqueue)",
    principal_origin: "systemPrincipalName='system:phase3-worker'",
    permission: "installation:read",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "phase3Queue.add (reconcile + dep scan + graduation)",
    principal_destination: "auth_decision_log.principal_id (scheduler adoption)",
    status: "wired",
    note: "Scheduler producer resolves system:phase3-worker before enqueuing fleet reconciliation, dep scan, graduation. Consumer (worker:phase3) also adopts.",
  },
  "scheduled:phase4": {
    entry_module: "packages/web/src/workers/phase4Worker.js",
    exported_symbol: "schedulePhase4Jobs",
    adoption_location: "phase4Worker.js:128 (inside schedulePhase4Jobs, before enqueue)",
    principal_origin: "systemPrincipalName='system:phase4-worker'",
    permission: "ai_review:create",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "phase4Queue.add (nightly-audit-export)",
    principal_destination: "auth_decision_log.principal_id (scheduler adoption)",
    status: "wired",
    note: "Scheduler producer resolves system:phase4-worker before enqueuing nightly-audit-export. Consumer (worker:phase4) also adopts.",
  },
  "scheduled:reconciliation": {
    entry_module: "packages/web/src/workers/reconciliationWorker.js",
    exported_symbol: "runReconciliation",
    adoption_location: "reconciliationWorker.js:26 (inside runReconciliation, before scan)",
    principal_origin: "systemPrincipalName='system:reconciliation-worker'",
    permission: "installation:read",
    resource_origin: "resolveSystemWorkerContext (fleet-wide)",
    first_side_effect: "getStaleActions + reconcile",
    principal_destination: "auth_decision_log.principal_id (scheduler adoption)",
    status: "wired",
    note: "Scheduled via setInterval (not BullMQ repeatable). Producer resolves system:reconciliation-worker before scanning.",
  },
};

/**
 * ADOPTION_PROVEN: surfaces with a passing disposable proof that exercises
 * the real entry symbol → canonical principal resolver → authorize
 * observation → no side effect before adoption.
 *
 * This is WEAKER than integration-proven. An adoption proof establishes
 * that the principal resolves and the authorize decision is recorded. It
 * does NOT establish exact permission/resource match, domain effect,
 * or zero-gap attribution.
 */
const ADOPTION_PROVEN = {
  // System workers — proven by run_system_worker_adoption_proof.mjs
  "worker:diagnosis":    { proof_command: "node packages/web/db/proof/run_system_worker_adoption_proof.mjs", proof_checks: 41 },
  "worker:patch":        { proof_command: "node packages/web/db/proof/run_system_worker_adoption_proof.mjs", proof_checks: 41 },
  "worker:verification": { proof_command: "node packages/web/db/proof/run_system_worker_adoption_proof.mjs", proof_checks: 41 },
  "worker:critic":       { proof_command: "node packages/web/db/proof/run_system_worker_adoption_proof.mjs", proof_checks: 41 },
  // Installation workers — proven by run_installation_worker_adoption_proof.mjs
  "worker:ciEvidence":   { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:maintainer":   { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:issueFix":     { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:phase2":       { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:phase3":       { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:ciHeal":       { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  "worker:phase4":       { proof_command: "node packages/web/db/proof/run_installation_worker_adoption_proof.mjs", proof_checks: 44 },
  // Schedulers — proven by run_scheduler_adoption_proof.mjs
  "scheduled:sync":           { proof_command: "node packages/web/db/proof/run_scheduler_adoption_proof.mjs", proof_checks: 16 },
  "scheduled:maintainer":     { proof_command: "node packages/web/db/proof/run_scheduler_adoption_proof.mjs", proof_checks: 16 },
  "scheduled:phase3":         { proof_command: "node packages/web/db/proof/run_scheduler_adoption_proof.mjs", proof_checks: 16 },
  "scheduled:phase4":         { proof_command: "node packages/web/db/proof/run_scheduler_adoption_proof.mjs", proof_checks: 16 },
  "scheduled:reconciliation": { proof_command: "node packages/web/db/proof/run_scheduler_adoption_proof.mjs", proof_checks: 16 },
  // Integration-proven surfaces are also adoption-proven (stronger implies weaker)
  "worker:triage":    { proof_command: "node packages/web/db/proof/run_triage_handler_pg_proof.mjs", proof_checks: 28 },
  "worker:webhook":   { proof_command: "node packages/web/db/proof/run_webhook_worker_proof.mjs",   proof_checks: 26 },
  "webhook:github":   { proof_command: "node packages/web/db/proof/run_webhook_vertical_proof.mjs",  proof_checks: 36 },
  "worker:sync":      { proof_command: "node packages/web/db/proof/run_sync_vertical_proof.mjs",     proof_checks: 25 },
  "telegram:fix":     { proof_command: "node packages/web/db/proof/run_telegram_bot_proof.mjs",      proof_checks: 15 },
  "telegram:heal":    { proof_command: "node packages/web/db/proof/run_telegram_heal_proof.mjs",     proof_checks: 8 },
};

/**
 * INTEGRATION_PROVEN: surfaces with a passing disposable proof that
 * additionally establishes:
 *   → exact permission and resource
 *   → expected domain effect exactly once
 *   → authoritative principal at persistence
 *   → zero positive attribution gaps
 *   → negative matrix
 *   → natural exit 0
 *
 * This is the STRONGEST evidence level.
 */
const INTEGRATION_PROVEN = {
  "worker:triage":   { proof_command: "node packages/web/db/proof/run_triage_handler_pg_proof.mjs", proof_checks: 28 },
  "worker:webhook":  { proof_command: "node packages/web/db/proof/run_webhook_worker_proof.mjs",   proof_checks: 26 },
  "webhook:github":  { proof_command: "node packages/web/db/proof/run_webhook_vertical_proof.mjs",  proof_checks: 36 },
  "worker:sync":     { proof_command: "node packages/web/db/proof/run_sync_vertical_proof.mjs",     proof_checks: 25 },
  "telegram:fix":    { proof_command: "node packages/web/db/proof/run_telegram_bot_proof.mjs",      proof_checks: 15 },
  "telegram:heal":   { proof_command: "node packages/web/db/proof/run_telegram_heal_proof.mjs",     proof_checks: 8 },
};

// PROVEN kept as backward-compatible alias for INTEGRATION_PROVEN
const PROVEN = INTEGRATION_PROVEN;

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
 * A surface in WIRING with adoption_location=null is declared but NOT wired.
 */
export function isWired(surfaceId) {
  const w = WIRING[surfaceId];
  return w != null && w.adoption_location != null;
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
  return Object.prototype.hasOwnProperty.call(INTEGRATION_PROVEN, surfaceId);
}

/**
 * Check if a surface is adoption-proven (has a passing adoption proof).
 */
export function isAdoptionProven(surfaceId) {
  return Object.prototype.hasOwnProperty.call(ADOPTION_PROVEN, surfaceId);
}

/**
 * Get the adoption proof info for a surface (or null).
 */
export function getAdoptionProof(surfaceId) {
  return ADOPTION_PROVEN[surfaceId] || null;
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
 * The four-state adoption gate with ambiguity detection.
 *
 * Derives state from ALL authoritative maps:
 *   WIRING + SCHEDULER_WIRING → wired
 *   ADOPTION_PROVEN           → adoption_proven
 *   INTEGRATION_PROVEN        → integration_proven
 *
 * Returns exact sets so counts can be derived without hard-coding.
 * Detects ambiguous mappings (two surface IDs sharing the same module +
 * adoption location without an explicit boundary distinction).
 *
 * @param {string[]} expectedNonHttpIds - the non-HTTP surface ids from declarations
 * @returns {{
 *   declared: string[],
 *   wired: string[],
 *   adoptionProven: string[],
 *   integrationProven: string[],
 *   declaredOnly: string[],
 *   wiredOnly: string[],
 *   adoptionProvenOnly: string[],
 *   ambiguousMappings: Array<{ surfaces: string[], module: string, adoptionLocation: string }>,
 *   rows: Array<object>,
 *   counts: { declared: number, wired: number, adoptionProven: number, integrationProven: number }
 * }}
 */
export function classifyAdoptionStates(expectedNonHttpIds) {
  const declared = [...expectedNonHttpIds].sort();

  // Wired = in WIRING OR in SCHEDULER_WIRING
  const wired = declared.filter((id) => isWired(id) || isSchedulerWired(id));

  // Adoption-proven = in ADOPTION_PROVEN
  const adoptionProven = declared.filter((id) => isAdoptionProven(id));

  // Integration-proven = in INTEGRATION_PROVEN
  const integrationProven = declared.filter((id) => isProven(id));

  // Derived sets
  const declaredOnly = declared.filter((id) => !(isWired(id) || isSchedulerWired(id)));
  const wiredOnly = wired.filter((id) => !isAdoptionProven(id));
  const adoptionProvenOnly = adoptionProven.filter((id) => !isProven(id));

  // Ambiguity detection: two+ surfaces sharing the same module + adoption line.
  // Normalizes adoption_location to just the file:line part for comparison,
  // ignoring parenthetical annotations.
  const locationMap = new Map();
  for (const id of wired) {
    const w = WIRING[id] || SCHEDULER_WIRING[id];
    if (!w || !w.adoption_location) continue;
    // Extract just the filename:line portion (before any space/paren)
    const locBase = w.adoption_location.split(/[ (]/)[0];
    const loc = w.entry_module + ":" + locBase;
    if (!locationMap.has(loc)) locationMap.set(loc, []);
    locationMap.get(loc).push(id);
  }
  const ambiguousMappings = [];
  for (const [loc, surfaces] of locationMap) {
    if (surfaces.length > 1) {
      const w = WIRING[surfaces[0]] || SCHEDULER_WIRING[surfaces[0]];
      ambiguousMappings.push({
        surfaces: surfaces.sort(),
        module: w.entry_module,
        adoptionLocation: w.adoption_location,
      });
    }
  }

  // Build per-surface rows for the full matrix
  const rows = declared.map((id) => {
    const w = WIRING[id] || SCHEDULER_WIRING[id];
    const ap = ADOPTION_PROVEN[id];
    const ip = INTEGRATION_PROVEN[id];
    return {
      surface_id: id,
      category: id.startsWith("worker:") ? "worker"
        : id.startsWith("scheduled:") ? "scheduled"
        : id.startsWith("telegram:") ? "telegram"
        : id.startsWith("webhook:") ? "webhook"
        : "unknown",
      module: w?.entry_module || null,
      exported_symbol: w?.exported_symbol || null,
      declared: true,
      wired: isWired(id) || isSchedulerWired(id),
      adoption_proven: isAdoptionProven(id),
      integration_proven: isProven(id),
      principal_origin: w?.principal_origin || null,
      permission: w?.permission || null,
      resource_origin: w?.resource_origin || null,
      adoption_location: w?.adoption_location || null,
      first_side_effect: w?.first_side_effect || null,
      principal_destination: w?.principal_destination || null,
      proof_command: ip?.proof_command || ap?.proof_command || null,
    };
  });

  return {
    declared,
    wired,
    adoptionProven,
    integrationProven,
    declaredOnly,
    wiredOnly,
    adoptionProvenOnly,
    ambiguousMappings,
    rows,
    counts: {
      declared: declared.length,
      wired: wired.length,
      adoptionProven: adoptionProven.length,
      integrationProven: integrationProven.length,
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
