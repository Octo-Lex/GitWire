// tests/unit/stress-functional/latency-populations.test.js
//
// C5 tests for the latency-population module. Every expected total is
// computed INDEPENDENTLY from the module's implementation — no oracle reuse
// (spec section 6.5 "Cross-check tests": "Do not test the aggregate
// implementation using the aggregate implementation itself as the oracle").
//
// Network-free, clock-free. Imports only the module under test. The
// population tests construct synthetic records directly (the same shape
// createAttemptRecord produces), not engine output.

import {
  computeLatencyPopulations,
  populationsForRecord,
  POPULATION_NAMES,
  emptyLatency,
  summarize,
  percentile,
} from "../../stress/modules/latency-populations.js";

// ─── Helpers: synthetic-record construction with explicit fields ──────────
// Tests build records that have ONLY the fields the population predicates
// read. This keeps the oracle arithmetic readable and proves the predicates
// do not depend on fields they should not read.

function rec(overrides) {
  return {
    transport: "completed",
    http: "expected",
    assertion: "passed",
    outcome: "succeeded",
    final: true,
    durationMs: 10,
    ...overrides,
  };
}

describe("latency-populations — module surface", () => {
  it("POPULATION_NAMES is exactly the 9 spec-mandated populations", () => {
    // Spec section 6.5 "Latency populations" lines 530-540 enumerates these
    // names. A rename or addition must fail this test.
    expect(POPULATION_NAMES).toEqual([
      "all_completed_attempts",
      "transport_success",
      "response_received",
      "expected_status",
      "unexpected_status",
      "assertion_passed",
      "assertion_failed",
      "logical_success",
      "logical_failure",
    ]);
    expect(Object.isFrozen(POPULATION_NAMES)).toBe(true);
  });

  it("emptyLatency() returns the null-filled shape (spec line 559-571)", () => {
    const e = emptyLatency();
    expect(e).toEqual({
      count: 0, min: null, max: null, mean: null,
      p50: null, p90: null, p95: null, p99: null,
    });
    expect(Object.isFrozen(e)).toBe(true);
  });

  it("summarize([]) returns emptyLatency()", () => {
    expect(summarize([])).toEqual(emptyLatency());
  });

  it("percentile([], p) returns null", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 99)).toBeNull();
  });
});

describe("latency-populations — percentile nearest-rank semantics", () => {
  // Independent oracle: the nearest-rank percentile for sorted xs at p is
  // xs[ceil(p/100 * n) - 1]. This is the textbook formula — we hard-code the
  // expected indices rather than calling the module's own percentile().

  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]; // n=10

  it("p50 of [10..100 step 10] = element at ceil(0.5*10)-1 = index 4 = 50", () => {
    expect(percentile(samples, 50)).toBe(50);
  });
  it("p90 = element at ceil(0.9*10)-1 = index 8 = 90", () => {
    expect(percentile(samples, 90)).toBe(90);
  });
  it("p95 = element at ceil(0.95*10)-1 = ceil(9.5)-1 = 10-1 = index 9 = 100", () => {
    expect(percentile(samples, 95)).toBe(100);
  });
  it("p99 = element at ceil(0.99*10)-1 = ceil(9.9)-1 = 10-1 = index 9 = 100", () => {
    expect(percentile(samples, 99)).toBe(100);
  });
  it("p100 = element at ceil(1.0*10)-1 = 10-1 = index 9 = 100 (the max)", () => {
    expect(percentile(samples, 100)).toBe(100);
  });
  it("percentile is clamped: p1 of n=10 = ceil(0.1)-1 = 1-1 = index 0 = min", () => {
    expect(percentile(samples, 1)).toBe(10);
  });
});

describe("latency-populations — summarize arithmetic (independent oracle)", () => {
  it("mean is computed independently via sum/length, not via module internals", () => {
    const samples = [4, 8, 15, 16, 23, 42];
    const sum = samples.reduce((a, b) => a + b, 0); // 108
    const expectedMean = sum / samples.length; // 18
    const s = summarize(samples);
    expect(s.count).toBe(6);
    expect(s.min).toBe(4);
    expect(s.max).toBe(42);
    expect(s.mean).toBe(expectedMean);
    // Independent percentile oracle for sorted [4,8,15,16,23,42], n=6:
    // p50: ceil(0.5*6)-1 = 3-1 = index 2 = 15
    // p90: ceil(0.9*6)-1 = ceil(5.4)-1 = 6-1 = index 5 = 42
    // p95: ceil(0.95*6)-1 = ceil(5.7)-1 = 6-1 = index 5 = 42
    // p99: ceil(0.99*6)-1 = ceil(5.94)-1 = 6-1 = index 5 = 42
    expect(s.p50).toBe(15);
    expect(s.p90).toBe(42);
    expect(s.p95).toBe(42);
    expect(s.p99).toBe(42);
  });

  it("single-sample population returns that value for every stat", () => {
    const s = summarize([777]);
    expect(s).toEqual({
      count: 1, min: 777, max: 777, mean: 777,
      p50: 777, p90: 777, p95: 777, p99: 777,
    });
  });

  it("summary object is frozen", () => {
    expect(Object.isFrozen(summarize([1, 2, 3]))).toBe(true);
  });

  it("stat fields for a non-empty population obey min ≤ p50 ≤ p90 ≤ p95 ≤ p99 ≤ max", () => {
    const s = summarize([5, 1, 4, 2, 3]);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.p50).toBeGreaterThanOrEqual(s.min);
    expect(s.p90).toBeGreaterThanOrEqual(s.p50);
    expect(s.p95).toBeGreaterThanOrEqual(s.p90);
    expect(s.p99).toBeGreaterThanOrEqual(s.p95);
    expect(s.max).toBeGreaterThanOrEqual(s.p99);
  });
});

describe("latency-populations — empty input", () => {
  it("computeLatencyPopulations([]) returns all 9 populations as empty", () => {
    const map = computeLatencyPopulations([]);
    expect(POPULATION_NAMES.every((n) => map[n].count === 0)).toBe(true);
    for (const n of POPULATION_NAMES) {
      expect(map[n]).toEqual(emptyLatency());
    }
  });

  it("throws on non-array input (programming error, not a violation)", () => {
    expect(() => computeLatencyPopulations(null)).toThrow(/attemptRecords must be an array/);
    expect(() => computeLatencyPopulations("foo")).toThrow(/attemptRecords must be an array/);
    expect(() => computeLatencyPopulations({})).toThrow(/attemptRecords must be an array/);
  });
});

describe("latency-populations — membership via populationsForRecord", () => {
  // Independent oracle: for each record, hand-encode the EXACT set of
  // populations it should belong to, then compare to the module's output.
  // This proves the predicate logic, not just the count.

  it("a completed+expected+passed+succeeded-final record belongs to 7 populations", () => {
    // all_completed, transport_success, response_received, expected_status,
    // assertion_passed, logical_success (final+succeeded).
    // (Not assertion_failed, unexpected_status, or logical_failure.)
    const r = rec({});
    const set = new Set(populationsForRecord(r));
    expect(set).toEqual(new Set([
      "all_completed_attempts",
      "transport_success",
      "response_received",
      "expected_status",
      "assertion_passed",
      "logical_success",
    ]));
  });

  it("a failed-transport record belongs only to all_completed_attempts", () => {
    // transport=failed → not transport_success, not response_received, no
    // http, assertion=not_run (not passed/failed). If final + outcome=failed,
    // also logical_failure. We use final=false here to isolate the case.
    const r = rec({ transport: "failed", http: "not_received", assertion: "not_run", final: false, outcome: "failed" });
    expect(populationsForRecord(r)).toEqual(["all_completed_attempts"]);
  });

  it("a failed-transport final attempt also belongs to logical_failure", () => {
    const r = rec({ transport: "failed", http: "not_received", assertion: "not_run", final: true, outcome: "failed" });
    expect(populationsForRecord(r)).toEqual(["all_completed_attempts", "logical_failure"]);
  });

  it("unexpected-status completed record belongs to unexpected_status, not expected_status", () => {
    const r = rec({ http: "unexpected" });
    const set = new Set(populationsForRecord(r));
    expect(set.has("unexpected_status")).toBe(true);
    expect(set.has("expected_status")).toBe(false);
    expect(set.has("response_received")).toBe(true); // still got a response
  });

  it("assertion-failed record belongs to assertion_failed, not assertion_passed", () => {
    const r = rec({ assertion: "failed", outcome: "failed" });
    const set = new Set(populationsForRecord(r));
    expect(set.has("assertion_failed")).toBe(true);
    expect(set.has("assertion_passed")).toBe(false);
  });

  it("non-final successful attempt is NOT in logical_success (terminal-only)", () => {
    // Spec line 542: do not compute semantic-success percentile from all
    // completed attempts. logical_success is restricted to final attempts.
    const r = rec({ final: false });
    expect(populationsForRecord(r).includes("logical_success")).toBe(false);
  });

  it("transport_success and response_received have identical membership (spec)", () => {
    // The two are distinct names but identical membership by design — every
    // completed transport IS a received response. Confirms they won't drift.
    const cases = [
      rec({}),
      rec({ transport: "failed", http: "not_received", assertion: "not_run", final: false, outcome: "failed" }),
      rec({ http: "unexpected" }),
    ];
    for (const r of cases) {
      const set = new Set(populationsForRecord(r));
      expect(set.has("transport_success")).toBe(set.has("response_received"));
    }
  });
});

describe("latency-populations — count reconciliation (independent oracle)", () => {
  // Build a known mixed batch, hand-compute the expected per-population
  // counts, and assert the module's counts match. No reuse of the module's
  // own counting logic in the oracle.

  it("mixed batch of 8 records reconciles per spec", () => {
    const records = [
      // 3 succeeded final, expected, passed
      rec({ durationMs: 10 }),
      rec({ durationMs: 20 }),
      rec({ durationMs: 30 }),
      // 1 unexpected-status final failed
      rec({ http: "unexpected", assertion: "failed", outcome: "failed", durationMs: 40 }),
      // 2 transport failures (final, failed outcome) — count toward logical_failure
      rec({ transport: "failed", http: "not_received", assertion: "not_run", final: true, outcome: "failed", durationMs: 50 }),
      rec({ transport: "failed", http: "not_received", assertion: "not_run", final: true, outcome: "failed", durationMs: 60 }),
      // 1 non-final retry attempt (transport completed, expected, passed) —
      // NOT in logical_success because final=false
      rec({ final: false, durationMs: 70 }),
      // 1 assertion-failed but transport-completed+expected, final, outcome=failed
      rec({ assertion: "failed", outcome: "failed", durationMs: 80 }),
    ];

    const map = computeLatencyPopulations(records);

    // Independent hand-count:
    const oracle = {
      all_completed_attempts: 8, // everything
      transport_success: 6,      // 8 - 2 transport failures
      response_received: 6,      // identical to transport_success
      expected_status: 5,        // 6 completed - 1 unexpected
      unexpected_status: 1,
      assertion_passed: 4,       // 3 succeeded + 1 non-final retry
      assertion_failed: 2,       // unexpected+failed and assertion-only-failed
      logical_success: 3,        // 3 final+succeeded
      logical_failure: 4,        // 1 unexpected-failed + 2 transport-fail + 1 assertion-failed
    };

    for (const name of POPULATION_NAMES) {
      expect(map[name].count).toBe(oracle[name]);
    }
  });

  it("durationMs values are partitioned correctly into each population's stats", () => {
    // Focused check: the actual latency samples that feed each population.
    const records = [
      rec({ durationMs: 10 }),
      rec({ durationMs: 30 }),
      rec({ durationMs: 20 }),
    ];
    const map = computeLatencyPopulations(records);
    // all three are completed/expected/passed/succeeded-final, so every
    // relevant population should see the sorted set [10,20,30].
    const expected = { count: 3, min: 10, max: 30, mean: 20, p50: 20, p90: 30, p95: 30, p99: 30 };
    expect(map.all_completed_attempts).toEqual(expected);
    expect(map.transport_success).toEqual(expected);
    expect(map.expected_status).toEqual(expected);
    expect(map.assertion_passed).toEqual(expected);
    expect(map.logical_success).toEqual(expected);
    // These populations are empty:
    expect(map.unexpected_status).toEqual(emptyLatency());
    expect(map.assertion_failed).toEqual(emptyLatency());
    expect(map.logical_failure).toEqual(emptyLatency());
  });

  it("a record with a malformed durationMs surfaces as NaN in stats (descriptive, not prescriptive)", () => {
    // The population layer is descriptive: a NaN duration is exposed in the
    // stats so a downstream cross-check can catch it. This is intentional —
    // the validator is the prescriptive layer.
    const r = rec({ durationMs: Number.NaN });
    const map = computeLatencyPopulations([r]);
    expect(map.all_completed_attempts.count).toBe(1);
    expect(Number.isNaN(map.all_completed_attempts.min)).toBe(true);
    expect(Number.isNaN(map.all_completed_attempts.mean)).toBe(true);
  });

  it("a record with a negative durationMs contributes to count but surfaces as NaN (descriptive)", () => {
    // The population layer admits the record into the bucket (count is
    // correct) but exposes the shape defect as NaN — a negative duration is
    // invalid and the validator catches INVALID_DURATION separately. This
    // proves population stats never silently hide a defect behind a real
    // number.
    const r = rec({ durationMs: -5 });
    const map = computeLatencyPopulations([r]);
    expect(map.all_completed_attempts.count).toBe(1);
    expect(Number.isNaN(map.all_completed_attempts.min)).toBe(true);
    expect(Number.isNaN(map.all_completed_attempts.mean)).toBe(true);
  });

  it("returned map is frozen", () => {
    expect(Object.isFrozen(computeLatencyPopulations([]))).toBe(true);
  });

  it("map has no prototype pollution surface (null-prototype object)", () => {
    const map = computeLatencyPopulations([]);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(map.__proto__).toBeUndefined();
  });
});
