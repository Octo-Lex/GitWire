// src/lib/webhookTelemetry.js
// #10-A: telemetry-only registry for webhook ingress capacity evidence.
//
// OBSERVES the existing express_raw_body_middleware lifecycle and reports
// aggregates. It has NO effect on admission: nothing here rejects, delays,
// queues, or throttles a request, and the instrumented middleware is
// behavior-identical to its uninstrumented form. The point is to measure,
// in production, the quantities the admission-control design (#10-C) needs:
// how many webhook requests concurrently retain body memory, how many bytes
// they retain, for how long, and with what outcomes.
//
// Exposure is a coarse, anonymous-safe block on /health (counts, bytes,
// durations — no delivery ids, no repository identities, no payloads, no
// per-delivery labels), matching the established health-block pattern.
//
// Accounting contract (pinned by webhook-telemetry.test.js):
// - every begin() must end in exactly one release(); a second release for
//   the same id is ignored (returns false) and can never double-decrement
// - release() of an unknown id is ignored — counters can never go negative
// - activeRequests always equals the number of tracked in-flight ids
// - retainedBytes is the sum of the tracked ids' buffered byte counts
//
// High-water marks are kept two ways: per measurement window (60 s, so the
// interval peak is visible without external scraping) and lifetime.

const WINDOW_MS = 60_000;
const KEPT_WINDOW_SUMMARIES = 10;

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
}

function observeHighWaters(now) {
  rolloverWindowIfNeeded(now);
  if (activeRequests > windowHighWaterActive) windowHighWaterActive = activeRequests;
  if (retainedBytes > windowHighWaterBytes) windowHighWaterBytes = retainedBytes;
  if (activeRequests > lifetimeHighWaterActive) lifetimeHighWaterActive = activeRequests;
  if (retainedBytes > lifetimeHighWaterBytes) lifetimeHighWaterBytes = retainedBytes;
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
  inflight.set(id, { admittedAt: now, bytes: 0 });
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
 * Release a request with its terminal outcome. Exactly-once per id; unknown
 * ids ignored. Records the retention duration (middleware entry until
 * release — the full period the body memory was retained).
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
  rolloverWindowIfNeeded(Date.now());
  return {
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
