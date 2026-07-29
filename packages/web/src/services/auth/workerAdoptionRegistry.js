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
//     (or equivalent adoption seam) that resolves a trusted principal at
//     entry. Statically verifiable: the gate reads WIRING below, which is
//     maintained by hand to match the actual source. A mismatch between
//     WIRING and the source is a review finding, not a silent pass.
//
//   proven — the surface has a passing disposable integration proof that
//     exercises the real handler against real PG+Redis and asserts the
//     observable effects (auth_decision_log row, domain write, gap=0).
//     Only proven surfaces count toward the adoption metric.
//
// The completeness check reports all three layers so a reviewer can see
// exactly which surfaces are declared-but-not-wired and wired-but-not-proven.
// It does NOT conflate "declared" with "adopted."

/**
 * Wiring map: surface id → { module, adoptCall }.
 *
 * MAINTAINED BY HAND to match the actual source. Each entry must point to
 * a real adoptWorker() call (or equivalent adoption seam) in the named
 * module. The static gate verifies the module exists; the integration proof
 * verifies the runtime behavior.
 *
 * When you add an adoptWorker() call to a worker, add an entry here.
 * When you remove one, remove the entry. The completeness check will flag
 * any declared surface that is missing from this map.
 *
 * NOTE on scheduled:* surfaces: these are NOT separate entry points — they
 * are BullMQ repeatable jobs enqueued by scheduler functions (e.g.
 * scheduleSyncJobs, scheduleMaintainerJobs). When the scheduled job fires,
 * it is processed by the corresponding worker's createWorker handler, which
 * IS wired with adoptWorker (e.g. scheduled:sync → worker:sync handler).
 * The scheduled surface is therefore adopted transitively through its worker.
 * A future enhancement may add adoption at the scheduler level too, but the
 * runtime path is covered.
 *
 * NOTE on webhook:github: the webhook HTTP route (POST /webhooks) is the
 * ingress, but the actual adoption happens in the webhook WORKER handler
 * (worker:webhook), which is wired. The route itself only verifies HMAC and
 * enqueues; the worker does the adopted work.
 */
const WIRING = {
  // ── Workers (14) ──────────────────────────────────────────────────────────
  "worker:webhook":      { module: "packages/web/src/routes/webhooks.js",       adoptCall: "adoptWorker({ workerId: 'worker:webhook', ... })", line: 81 },
  "worker:triage":       { module: "packages/web/src/workers/triageWorker.js",  adoptCall: "adoptWorker({ workerId: 'worker:triage', ... })", line: 51 },
  "worker:ciHeal":       { module: "packages/web/src/workers/ciHealWorker.js",  adoptCall: "adoptWorker({ workerId: 'worker:ciHeal', ... })", line: 191 },
  "worker:sync":         { module: "packages/web/src/workers/syncWorker.js",    adoptCall: "adoptWorker({ workerId: 'worker:sync', ... })", line: 64 },
  "worker:ciEvidence":   { module: "packages/web/src/workers/ciEvidenceWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:ciEvidence', ... })", line: 30 },
  "worker:diagnosis":    { module: "packages/web/src/workers/diagnosisWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:diagnosis', ... })", line: 30 },
  "worker:patch":        { module: "packages/web/src/workers/patchWorker.js",  adoptCall: "adoptWorker({ workerId: 'worker:patch', ... })", line: 30 },
  "worker:verification": { module: "packages/web/src/workers/verificationWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:verification', ... })", line: 33 },
  "worker:critic":       { module: "packages/web/src/workers/criticWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:critic', ... })", line: 24 },
  "worker:maintainer":   { module: "packages/web/src/workers/maintainerWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:maintainer', ... })", line: 33 },
  "worker:issueFix":     { module: "packages/web/src/workers/issueFixWorker.js", adoptCall: "adoptWorker({ workerId: 'worker:issueFix', ... })", line: 28 },
  "worker:phase2":       { module: "packages/web/src/workers/phase2Worker.js", adoptCall: "adoptWorker({ workerId: 'worker:phase2', ... })", line: 27 },
  "worker:phase3":       { module: "packages/web/src/workers/phase3Worker.js", adoptCall: "adoptWorker({ workerId: 'worker:phase3', ... })", line: 28 },
  "worker:phase4":       { module: "packages/web/src/workers/phase4Worker.js", adoptCall: "adoptWorker({ workerId: 'worker:phase4', ... })", line: 72 },

  // ── Ingress (3) ───────────────────────────────────────────────────────────
  "telegram:fix":        { module: "packages/bot/src/commands.js",              adoptCall: "resolveInstallationId → POST /api/fix (route observer adopts)", line: 484 },
  "telegram:heal":       { module: "packages/bot/src/commands.js",              adoptCall: "resolveInstallationId → POST /api/ci/:runId/heal (route observer adopts)", line: 451 },
  // webhook:github — adopted via the webhook worker (worker:webhook) entry above
};

/**
 * Proven surfaces: surface id → proof file.
 *
 * Each entry has a passing disposable integration proof that exercises the
 * real handler against real PG+Redis. Only these surfaces count toward the
 * "proven" adoption metric. Adding a proof file here requires that the proof
 * actually passes (CI verifies this).
 */
const PROVEN = {
  "worker:triage":   { proof: "packages/web/db/proof/run_triage_handler_pg_proof.mjs", checks: 28 },
  "worker:webhook":  { proof: "packages/web/db/proof/run_webhook_vertical_proof.mjs",  checks: 36 },
  "worker:sync":     { proof: "packages/web/db/proof/run_sync_vertical_proof.mjs",     checks: 25 },
  "telegram:fix":    { proof: "packages/web/db/proof/run_telegram_bot_proof.mjs",      checks: 15 },
};

// ── Read-only accessors ────────────────────────────────────────────────────

/**
 * Get the wiring info for a surface (or null if not wired).
 * @param {string} surfaceId
 * @returns {{module: string, adoptCall: string, line: number} | null}
 */
export function getWiring(surfaceId) {
  return WIRING[surfaceId] || null;
}

/**
 * Check if a surface is wired (has an adoptWorker call in source).
 * @param {string} surfaceId
 * @returns {boolean}
 */
export function isWired(surfaceId) {
  return Object.prototype.hasOwnProperty.call(WIRING, surfaceId);
}

/**
 * Get the proof info for a surface (or null if not proven).
 * @param {string} surfaceId
 * @returns {{proof: string, checks: number} | null}
 */
export function getProof(surfaceId) {
  return PROVEN[surfaceId] || null;
}

/**
 * Check if a surface is proven (has a passing integration proof).
 * @param {string} surfaceId
 * @returns {boolean}
 */
export function isProven(surfaceId) {
  return Object.prototype.hasOwnProperty.call(PROVEN, surfaceId);
}

/**
 * List all wired surface ids (sorted).
 * @returns {string[]}
 */
export function listWiredSurfaces() {
  return Object.keys(WIRING).sort();
}

/**
 * List all proven surface ids (sorted).
 * @returns {string[]}
 */
export function listProvenSurfaces() {
  return Object.keys(PROVEN).sort();
}

/**
 * The 3-state adoption gate. Classifies every declared non-HTTP surface
 * into one of three states: declared, wired, proven.
 *
 * @param {string[]} expectedNonHttpIds - the non-HTTP surface ids from declarations
 * @returns {{
 *   declared: string[],
 *   wired: string[],
 *   proven: string[],
 *   declaredOnly: string[],   // declared but not wired
 *   wiredOnly: string[],      // wired but not proven
 *   counts: { declared: number, wired: number, proven: number }
 * }}
 */
export function classifyAdoptionStates(expectedNonHttpIds) {
  const declared = [...expectedNonHttpIds].sort();
  const wired = declared.filter((id) => isWired(id));
  const proven = declared.filter((id) => isProven(id));
  const declaredOnly = declared.filter((id) => !isWired(id));
  const wiredOnly = wired.filter((id) => !isProven(id));
  return {
    declared,
    wired,
    proven,
    declaredOnly,
    wiredOnly,
    counts: { declared: declared.length, wired: wired.length, proven: proven.length },
  };
}

// ── Backward compatibility (deprecated — use classifyAdoptionStates) ────────
// These exist so existing callers don't break during the transition. They
// report the WIRED set (not proven). New code should use the 3-state gate.

const ADOPTED = new Set(Object.keys(WIRING));

export function markWorkerAdopted(workerId) { ADOPTED.add(workerId); }
export function markWorkersAdopted(ids) { for (const id of ids) ADOPTED.add(id); }
export function isWorkerAdopted(workerId) { return ADOPTED.has(workerId); }
export function listAdoptedWorkers() { return [...ADOPTED].sort(); }

/**
 * @deprecated Use classifyAdoptionStates for the 3-state gate.
 * Returns the wired set (not proven).
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
