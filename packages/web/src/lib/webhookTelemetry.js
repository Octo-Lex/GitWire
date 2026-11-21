// src/lib/webhookTelemetry.js
// #10-A: telemetry-only registry for webhook ingress capacity evidence.
//
// OBSERVES the webhook ingress lifecycle and reports aggregates. It has NO
// effect on admission: nothing here rejects, delays, queues, or throttles a
// request, and the instrumented code paths are behavior-identical to their
// uninstrumented forms. The point is to measure, in production, the
// quantities the admission-control design (#10-C) needs: how many webhook
// requests concurrently retain body memory, how many bytes they retain, for
// how long, and with what outcomes.
//
// LIFECYCLE MODEL (v4):
//   entry (middleware) → [streaming: chunks buffered] → body complete →
//   HANDOFF (next(): the async route handler now owns the body) →
//   handler settlement (route finally: req.webhookTelemetrySettle()).
// Retention accounting ends at HANDLER SETTLEMENT, not transport
// termination: a client disconnect while the async handler still holds
// req.rawBody does NOT release the accounting — the body is still retained
// until the handler settles. Transport events (res finish/close, req
// aborted) release accounting ONLY before handoff (rejections and stream
// errors, where no handler ever owns the body); after handoff they merely
// record that the transport ended, for outcome classification at
// settlement.
//
// OVERDUE (never force-released): age alone NEVER removes accounting — a
// live handler exceeding OVERDUE_MS keeps its gauges. Overdue records are
// flagged and reported separately, and while any exist the snapshot marks
// the measurement evidence EXPLICITLY UNRELIABLE rather than presenting a
// falsely precise gauge.
//
// METRIC SEMANTICS: retained_bytes is LOGICAL retained payload bytes — the
// sum of accepted chunk lengths per in-flight request. It does NOT include
// the transient Buffer.concat() second allocation (~2x at completion),
// UTF-8 conversions, parsed objects, or allocator retention. Admission
// sizing (#10-C) must account for that amplification separately.
//
// Exposure is a coarse, anonymous-safe block on /health (counts, bytes,
// durations — no delivery ids, repository identities, payloads, or
// per-delivery labels), matching the established health-block pattern.
//
// Accounting contract (pinned by webhook-telemetry.test.js):
// - release happens exactly once, only at handler settlement (post-handoff)
//   or transport termination (pre-handoff); a second release is a no-op
// - unknown-id release is ignored — counters can never go negative
// - active_requests always equals the number of tracked in-flight ids
// - retained_bytes is the sum of the tracked ids' buffered byte counts
// - overdue records are never removed, only flagged, and their presence
//   flips the snapshot's evidence-reliability flag

const WINDOW_MS = 60_000;
const KEPT_WINDOW_SUMMARIES = 10;
// Age after which an in-flight record is flagged overdue (NOT released):
// comfortably above Node's requestTimeout (300 s) so a live request is
// never flagged, and far above expected handler runtimes. A flagged record
// means "settlement was never observed" — visible as unreliable evidence,
// never silently dropped.
const OVERDUE_MS = 600_000;

let activeRequests = 0;
let retainedBytes = 0;

let windowStartedAt = Date.now();
let windowHighWaterActive = 0;
let windowHighWaterBytes = 0;
let lifetimeHighWaterActive = 0;
let lifetimeHighWaterBytes = 0;
const windowSummaries = [];

const outcomes = {
  completed: 0,
  rejected_400: 0,
  rejected_401: 0,
  rejected_413: 0,
  error: 0,
  aborted: 0,
};

const streaming = { count: 0, sumMs: 0, maxMs: 0 };
const retention = { count: 0, sumMs: 0, maxMs: 0 };

const inflight = new Map();

function rolloverWindowIfNeeded(now) {
  if (now - windowStartedAt < WINDOW_MS) return;
  windowSummaries.push({
    windowStartedAt,
    windowEndedAt: now,
    highWaterActive: windowHighWaterActive,
    highWaterBytes: windowHighWaterBytes,
  });
  if (windowSummaries.length > KEPT_WINDOW_SUMMARIES) {
    windowSummaries.splice(0, windowSummaries.length - KEPT_WINDOW_SUMMARIES);
  }
  windowStartedAt = now;
  windowHighWaterActive = 0;
  windowHighWaterBytes = 0;
  // Seed the fresh window from the current gauges: sustained load crossing
  // a window boundary must not read as a zero-peak window. (Rolled-over
  // summaries keep the previous window's true peak.)
  if (activeRequests > windowHighWaterActive) windowHighWaterActive = activeRequests;
  if (retainedBytes > windowHighWaterBytes) windowHighWaterBytes = retainedBytes;
}

function observeHighWaters(now) {
  rolloverWindowIfNeeded(now);
  if (activeRequests > windowHighWaterActive) windowHighWaterActive = activeRequests;
  if (retainedBytes > windowHighWaterBytes) windowHighWaterBytes = retainedBytes;
  if (activeRequests > lifetimeHighWaterActive) lifetimeHighWaterActive = activeRequests;
  if (retainedBytes > lifetimeHighWaterBytes) lifetimeHighWaterBytes = retainedBytes;
}

function flagOverdue(now) {
  let overdueRequests = 0;
  let overdueBytes = 0;
  for (const rec of inflight.values()) {
    if (!rec.overdue && now - rec.admittedAt > OVERDUE_MS) rec.overdue = true;
    if (rec.overdue) {
      overdueRequests += 1;
      overdueBytes += rec.bytes;
    }
  }
  return { overdueRequests, overdueBytes };
}

function recordDuration(bucket, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  bucket.count += 1;
  bucket.sumMs += ms;
  bucket.maxMs = Math.max(bucket.maxMs, ms);
}

/**
 * Register a webhook-ingress request at middleware entry. Returns its
 * telemetry id (monotonically increasing).
 * @returns {number}
 */
export function webhookTelemetryBegin() {
  const id = nextId;
  nextId += 1;
  const now = Date.now();
  inflight.set(id, { admittedAt: now, bytes: 0, handedOff: false, overdue: false });
  activeRequests += 1;
  observeHighWaters(now);
  return id;
}
let nextId = 1;

/**
 * Account n newly buffered bytes for an in-flight request (called per
 * chunk; nothing copies or holds the chunk itself beyond the existing
 * buffer array).
 */
export function webhookTelemetryBytes(id, n) {
  const rec = inflight.get(id);
  if (!rec || !Number.isFinite(n) || n <= 0) return;
  rec.bytes += n;
  retainedBytes += n;
  observeHighWaters(Date.now());
}

/**
 * Mark the request's body as complete (streaming phase over; the buffer is
 * now the fixed req.rawBody). Records the streaming duration.
 */
export function webhookTelemetryBodyComplete(id) {
  const rec = inflight.get(id);
  if (!rec || rec.bodyCompletedAt) return;
  rec.bodyCompletedAt = Date.now();
  recordDuration(streaming, rec.bodyCompletedAt - rec.admittedAt);
}

/**
 * Mark handoff: the async route handler now owns the body (next() called
 * with the completed body). From here, transport termination does NOT
 * release retention accounting — only handler settlement does.
 */
export function webhookTelemetryHandoff(id) {
  const rec = inflight.get(id);
  if (rec) rec.handedOff = true;
}

/**
 * Release a request with its terminal outcome. Exactly-once per id; unknown
 * ids ignored. Called by the middleware's settle hook at handler
 * settlement (post-handoff) or transport termination (pre-handoff).
 * Records the retention duration (middleware entry until release — the
 * full body-memory lifetime).
 *
 * @param {"completed"|"rejected_400"|"rejected_401"|"rejected_413"|"error"|"aborted"} outcome
 * @returns {boolean} true if this call released the id
 */
export function webhookTelemetryRelease(id, outcome) {
  const rec = inflight.get(id);
  if (!rec) return false;
  inflight.delete(id);
  activeRequests -= 1;
  retainedBytes -= rec.bytes;
  if (Object.prototype.hasOwnProperty.call(outcomes, outcome)) {
    outcomes[outcome] += 1;
  } else {
    outcomes.error += 1;
  }
  recordDuration(retention, Date.now() - rec.admittedAt);
  return true;
}

/**
 * Coarse, anonymous-safe snapshot for the /health block.
 */
export function webhookTelemetrySnapshot() {
  const now = Date.now();
  const { overdueRequests, overdueBytes } = flagOverdue(now);
  rolloverWindowIfNeeded(now);
  return {
    // Metric semantics: retained_bytes is LOGICAL payload bytes (accepted
    // chunk sums) — excludes Buffer.concat transients, conversions, parsed
    // objects, allocator retention. Size admission with amplification.
    semantics: "logical_payload_bytes",
    active_requests: activeRequests,
    retained_bytes: retainedBytes,
    high_water: {
      current_window: {
        window_started_at: new Date(windowStartedAt).toISOString(),
        active_requests: windowHighWaterActive,
        retained_bytes: windowHighWaterBytes,
      },
      lifetime: {
        active_requests: lifetimeHighWaterActive,
        retained_bytes: lifetimeHighWaterBytes,
      },
      recent_windows: windowSummaries.slice(-3),
    },
    outcomes: { ...outcomes },
    durations_ms: {
      streaming: { count: streaming.count, avg: streaming.count ? Math.round(streaming.sumMs / streaming.count) : 0, max: streaming.maxMs },
      retention: { count: retention.count, avg: retention.count ? Math.round(retention.sumMs / retention.count) : 0, max: retention.maxMs },
    },
    integrity: {
      // activeRequests is always backed by exactly one inflight record.
      active_matches_inflight: activeRequests === inflight.size,
      // Overdue records are retained in the gauges (never force-released).
      // Any overdue record means a settlement signal was never observed —
      // the capacity evidence is explicitly UNRELIABLE until resolved.
      overdue_requests: overdueRequests,
      overdue_retained_bytes: overdueBytes,
      evidence_reliable: overdueRequests === 0,
    },
  };
}

/**
 * Test-only: reset all state. Not used by application code.
 */
export function __webhookTelemetryResetForTests() {
  activeRequests = 0;
  retainedBytes = 0;
  windowStartedAt = Date.now();
  windowHighWaterActive = 0;
  windowHighWaterBytes = 0;
  lifetimeHighWaterActive = 0;
  lifetimeHighWaterBytes = 0;
  windowSummaries.length = 0;
  for (const k of Object.keys(outcomes)) outcomes[k] = 0;
  streaming.count = 0; streaming.sumMs = 0; streaming.maxMs = 0;
  retention.count = 0; retention.sumMs = 0; retention.maxMs = 0;
  inflight.clear();
  nextId = 1;
}

/**
 * Test-only: backdate an inflight record so overdue flagging can be
 * exercised without waiting. Not used by application code.
 */
export function __webhookTelemetryTestBackdateInflight(id, ageMs) {
  const rec = inflight.get(id);
  if (rec) rec.admittedAt = Date.now() - ageMs;
}

/**
 * Test-only: backdate the measurement window so rollover behavior can be
 * exercised without waiting. Not used by application code.
 */
export function __webhookTelemetryTestBackdateWindow(ageMs) {
  windowStartedAt = Date.now() - ageMs;
}
