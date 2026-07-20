// packages/web/tests/stress/modules/latency-populations.js
//
// C5 of P2: computes the latency populations called out in spec section 6.5
// ("Latency populations"). It is a pure function over the normalized attempt
// records produced by createAttemptRecord (operation-accounting.js). It does
// NOT re-implement aggregate derivation or mutate the report shape — it
// produces an independent population map that validateBurstReport (see
// burst-report-validator.js) cross-checks against buildOperationReport's
// counters.
//
// Population set (frozen, mirrors spec section 6.5 exactly):
//
//   all_completed_attempts — every settled attempt (the universe)
//   transport_success      — transport=completed
//   response_received      — transport=completed (HTTP reached the client)
//   expected_status        — transport=completed && http=expected
//   unexpected_status      — transport=completed && http=unexpected
//   assertion_passed       — assertion=passed
//   assertion_failed       — assertion=failed
//   logical_success        — final attempt whose outcome=succeeded
//   logical_failure        — final attempt whose outcome=failed
//
// Per spec line 542: "Do not compute a semantic-success percentile from all
// completed attempts." logical_success and logical_failure are restricted to
// final attempts so a multi-attempt logical operation contributes exactly
// one latency sample to each of those populations (the terminal attempt).
//
// Per spec line 557: empty populations use an explicit null-filled shape —
// never zero-filled percentiles that could be mistaken for real measurements.
//
// Determinism contract: this module is imported by the static-gate collector
// (every .js under modules/ is scanned). It contains NO Date.now,
// performance.now, setTimeout, or setInterval. Time is irrelevant — only
// pre-recorded durationMs values are read.

// ─── Population membership predicates ─────────────────────────────────────
// Each predicate is total: it returns false for any record that does not match
// the population's membership rule, regardless of shape. Shape defects are the
// validator's concern (burst-report-validator.js), not the population layer's.

const POPULATIONS = Object.freeze({
  all_completed_attempts: () => true,
  transport_success: (r) => r && r.transport === "completed",
  // Per spec: response_received and transport_success have identical
  // membership (a completed transport IS a received response). They are kept
  // as separate named populations so consumers can express intent, and so the
  // validator can prove responseReceived === transportSuccess count.
  response_received: (r) => r && r.transport === "completed",
  expected_status: (r) => r && r.transport === "completed" && r.http === "expected",
  unexpected_status: (r) => r && r.transport === "completed" && r.http === "unexpected",
  assertion_passed: (r) => r && r.assertion === "passed",
  assertion_failed: (r) => r && r.assertion === "failed",
  logical_success: (r) => r && r.final === true && r.outcome === "succeeded",
  logical_failure: (r) => r && r.final === true && r.outcome === "failed",
});

// Frozen, sorted population name list. Tests assert this exact set so a
// rename or addition is caught.
const POPULATION_NAMES = Object.freeze(Object.keys(POPULATIONS));

// ─── Empty latency shape ──────────────────────────────────────────────────
// Per spec lines 559–571. Each field is null (not 0) so an empty population
// is never confused with a real zero-latency population.
function emptyLatency() {
  return Object.freeze({
    count: 0,
    min: null,
    max: null,
    mean: null,
    p50: null,
    p90: null,
    p95: null,
    p99: null,
  });
}

// ─── Percentile helper ────────────────────────────────────────────────────
// Nearest-rank percentile (the deterministic, sort-stable choice — no
// interpolation that could disagree with an independent oracle). For a sorted
// ascending array xs of length n, the p-th percentile is the element at
// index ceil(p/100 * n) - 1, clamped to [0, n-1]. The empty case is handled
// by the caller (emptyLatency()).
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  // p in (0, 100]; p=100 returns the max. ceil(100/100 * n) - 1 = n - 1.
  const idx = Math.ceil((p / 100) * n) - 1;
  const clamped = idx < 0 ? 0 : idx > n - 1 ? n - 1 : idx;
  return sortedAsc[clamped];
}

// ─── Per-population statistics ────────────────────────────────────────────
// Computes the 9-field shape for a single latency sample array. Returns the
// frozen empty shape for an empty array (no special-casing at call sites).
function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return emptyLatency();
  }
  // Sort ascending once. Uses the default comparator because durationMs is a
  // non-negative finite number on valid records (operation-accounting.js
  // Phase 1 already enforces INVALID_DURATION on shape defects). Any caller
  // passing malformed samples would already have failed the validator.
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return Object.freeze({
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: sum / n,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  });
}

// ─── Population extractor ─────────────────────────────────────────────────
// Given a single normalized record, return the list of population names it
// belongs to. Exposed for testability and for cross-check tests that need to
// confirm a record contributes to exactly the expected populations.
export function populationsForRecord(record) {
  const out = [];
  for (const name of POPULATION_NAMES) {
    if (POPULATIONS[name](record)) out.push(name);
  }
  return out;
}

// ─── Main export ──────────────────────────────────────────────────────────
/**
 * Compute the full latency-population map from a list of normalized attempt
 * records. Pure: no I/O, no wall-clock, no shared state. Records that do not
 * belong to a population simply do not contribute to that population's
 * samples; they do not produce violations (validation is the validator's job).
 *
 * @param {Array} attemptRecords normalized records (createAttemptRecord output)
 * @returns {object} frozen map of population name → frozen latency summary
 * @throws {Error} only when attemptRecords is not an array (programming error)
 */
export function computeLatencyPopulations(attemptRecords) {
  if (!Array.isArray(attemptRecords)) {
    throw Object.assign(
      new Error("computeLatencyPopulations: attemptRecords must be an array"),
      { code: "INVALID_POPULATIONS_ARG" }
    );
  }

  // Pre-allocate sample buckets. Each population owns an independent array so
  // a malformed durationMs on one record cannot leak into another population's
  // stats. durationMs is only read for records that pass the population
  // membership predicate; records that fail every predicate (none do, since
  // all_completed_attempts admits everything) still contribute nothing.
  const buckets = Object.create(null);
  for (const name of POPULATION_NAMES) buckets[name] = [];

  for (const r of attemptRecords) {
    // all_completed_attempts is the universe — every record, even a malformed
    // one, is counted here. A malformed durationMs (NaN, negative, non-number)
    // is still pushed; summarize() handles it via the default numeric sort.
    // Validator catches the shape defect separately (INVALID_DURATION).
    if (r && typeof r === "object") {
      for (const name of POPULATION_NAMES) {
        if (POPULATIONS[name](r)) {
          // Only finite non-negative numbers can enter the sample array. A
          // record with a bad durationMs gets counted in `count` via the
          // bucket's length but its value is replaced with NaN so the sort
          // is deterministic (NaN sorts last via default comparator) — and
          // summarize() will surface NaN in min/max/mean, exposing the
          // defect rather than hiding it. This is intentional: the
          // population layer is descriptive; the validator is prescriptive.
          const d = r.durationMs;
          if (typeof d === "number" && Number.isFinite(d) && d >= 0) {
            buckets[name].push(d);
          } else {
            // Sentinel: pushes NaN so a malformed duration surfaces as NaN
            // in the population stats rather than being silently dropped.
            buckets[name].push(Number.NaN);
          }
        }
      }
    }
  }

  const out = Object.create(null);
  for (const name of POPULATION_NAMES) {
    out[name] = summarize(buckets[name]);
  }
  return Object.freeze(out);
}

// Re-exports for tests and the validator.
export { POPULATION_NAMES, emptyLatency, summarize, percentile };
