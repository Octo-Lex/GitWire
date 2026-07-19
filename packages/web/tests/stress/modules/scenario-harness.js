// packages/web/tests/stress/modules/scenario-harness.js
//
// Deterministic scenario primitives for P2 functional and concurrency tests.
//
// Network-free, clock-free, timer-free. Every notion of time flows through an
// injected clock; every notion of waiting flows through an injected sleeper.
// The module is guarded at source level against accidental wall-clock / timer
// use (see FORBIDDEN_TIME_TOKENS below) — the guard is enforced by the static
// isolation scanner as a string-match rule, so a future edit that introduces
// real time is caught at CI time, not at flaky-test time.
//
// This module composes on top of burst-runner.js (runContractedOperation /
// runContractedBurst) — it does NOT replace or extend the engine. Its job is
// to produce controlled ClassifiedOutcomes and scripted multi-attempt
// sequences so C2 (accounting), C3 (concurrency), and C4 (retry) can prove
// properties deterministically.
//
// No production-code imports: no actionStateMachine, no createQueue, no
// githubRateLimit. The production-policy adapter arrives in C4 and will call
// a narrow public classifier, not this module.

import {
  classifyTransportError,
  validateOutcome,
} from "../burst-runner.js";

// ─── Source-level determinism guard ───────────────────────────────────────
//
// The tokens below are FORBIDDEN anywhere in this file. The stress isolation
// scanner enforces this as a string-match rule (see scripts/check-stress-
// isolation.mjs). If a token appears, the build fails at the static gate.
// The list is mirrored here as a comment so the rule and the rationale stay
// co-located; do not remove this comment block when editing.
//
//   FORBIDDEN_TIME_TOKENS = [
//     "Date.now", "performance.now", "setTimeout", "setInterval",
//   ]
//
// Rationale: any wall-clock read or real timer breaks determinism. Inject
// createClock() and createSleeper() instead.

// ─── Error codes ──────────────────────────────────────────────────────────

export const SCENARIO_EXHAUSTED = "SCENARIO_EXHAUSTED";
export const SCENARIO_CANCELLED = "SCENARIO_CANCELLED";

// ─── Deterministic clock ──────────────────────────────────────────────────

/**
 * Create a deterministic clock. Time advances ONLY when clock.advance(ms) or
 * clock.now() is called; there is no wall-clock fallback.
 *
 * @param {number} [initialMs=0]
 * @returns {{now: () => number, advance: (ms: number) => number, value: () => number}}
 */
export function createClock(initialMs = 0) {
  let t = Number.isFinite(initialMs) ? initialMs : 0;
  return Object.freeze({
    now: () => t,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw Object.assign(
          new Error(`clock.advance: ms must be a non-negative finite number, got ${ms}`),
          { code: "INVALID_CLOCK_ADVANCE" }
        );
      }
      t += ms;
      return t;
    },
    value: () => t,
  });
}

// ─── Deterministic sleeper ────────────────────────────────────────────────

/**
 * Create a deterministic sleeper. sleep(ms) records the requested delay and,
 * if a clock was injected, advances it by exactly ms. No real timer is used.
 *
 * `calls` is a live view into the recorded delays; tests read it after the
 * scenario settles. Object.freeze on the returned sleeper prevents mutation
 * of the methods, not of the internal calls array.
 *
 * @param {{clock?: object, trace?: object}} [opts]
 * @returns {{sleep: (ms: number) => Promise<void>, calls: number[]}}
 */
export function createSleeper(opts = {}) {
  const { clock, trace } = opts;
  const calls = [];
  const sleep = async (ms) => {
    if (!Number.isFinite(ms) || ms < 0) {
      throw Object.assign(
        new Error(`sleeper.sleep: ms must be a non-negative finite number, got ${ms}`),
        { code: "INVALID_SLEEP" }
      );
    }
    calls.push(ms);
    if (clock && typeof clock.advance === "function") clock.advance(ms);
    if (trace && typeof trace.append === "function") trace.append({ kind: "sleep", detail: { ms } });
    // A single resolved-promise await yields to the microtask queue once,
    // preserving ordering with other async work without introducing latency.
    await Promise.resolve();
  };
  return Object.freeze({ sleep, calls });
}

// ─── Deferred barrier ─────────────────────────────────────────────────────

/**
 * Create a deferred promise — the barrier primitive for concurrency tests.
 * The returned object exposes settle state so tests can assert "still
 * pending" vs "settled exactly once" without polling real time.
 *
 * @returns {{promise: Promise, resolve: (v?: *) => void, reject: (e?: *) => void, settled: boolean, resolution: *}}
 */
export function deferred() {
  let resolve, reject;
  let settled = false;
  let resolution = null; // { status: "fulfilled"|"rejected", value?: *, reason?: * }
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const wrap = (status) => (val) => {
    if (settled) return;
    settled = true;
    resolution = { status, ...(status === "fulfilled" ? { value: val } : { reason: val }) };
    if (status === "fulfilled") resolve(val); else reject(val);
  };
  return {
    promise,
    resolve: wrap("fulfilled"),
    reject: wrap("rejected"),
    get settled() { return settled; },
    get resolution() { return resolution; },
  };
}

// ─── Execution trace ──────────────────────────────────────────────────────

/**
 * Create a structured execution trace. Every start/settle/sleep event is
 * appended with a timestamp from the injected clock, so tests can assert
 * exact event sequences without inferring from elapsed time.
 *
 * @param {{clock?: object}} [opts]
 * @returns {{append: (event) => void, events: () => object[]}}
 */
export function createTrace(opts = {}) {
  const { clock } = opts;
  const events = [];
  const append = (event) => {
    const ts = clock && typeof clock.now === "function" ? clock.now() : null;
    events.push({ ts, ...event });
  };
  return Object.freeze({
    append,
    events: () => [...events],
  });
}

// ─── Outcome normalization ────────────────────────────────────────────────

/**
 * Normalize a mock-outcome spec into a valid ClassifiedOutcome and validate
 * it before returning. This makes malformed specs fail at the harness
 * boundary (here) rather than later inside the burst scheduler, where the
 * failure mode would be BURST_OPERATION_REJECTED with scheduler attribution.
 *
 * Accepted spec shapes:
 *   { transport: "completed", status: 200, body?: {...}|undefined }
 *     - body is a raw value wrapped as { state:"parsed", value: body, error:null }.
 *     - omit body → { state:"empty", value:null, error:null }.
 *   { transport: "failed", error: Error }
 *     - status forced null, body forced not_read; error classified via the
 *       engine's classifyTransportError for consistent category mapping.
 *
 * A `throw` spec is NOT accepted here — escaped rejections are a scenario
 *-level concern handled by createScenario (the engine treats a thrown run()
 * as BURST_OPERATION_REJECTED, distinct from a transport failure).
 *
 * @param {object} spec
 * @returns {object} valid ClassifiedOutcome
 * @throws {Error} if the spec is unrecognizable or the normalized outcome
 *   fails validateOutcome (engine-side contradiction check).
 */
export function mockOutcome(spec) {
  if (!spec || typeof spec !== "object") {
    throw Object.assign(
      new Error(`mockOutcome: spec must be an object, got ${typeof spec}`),
      { code: "INVALID_OUTCOME_SPEC" }
    );
  }

  if (spec.transport === "completed") {
    if (!Number.isInteger(spec.status) || spec.status < 100 || spec.status > 599) {
      throw Object.assign(
        new Error(`mockOutcome: completed outcome requires integer status 100-599, got ${spec.status}`),
        { code: "INVALID_OUTCOME_SPEC" }
      );
    }
    let body;
    if (spec.body === undefined) {
      body = { state: "empty", value: null, error: null };
    } else {
      body = { state: "parsed", value: spec.body, error: null };
    }
    const outcome = { transport: "completed", status: spec.status, body, error: null };
    validateOutcome(outcome);
    return outcome;
  }

  if (spec.transport === "failed") {
    if (!(spec.error instanceof Error)) {
      throw Object.assign(
        new Error(`mockOutcome: failed outcome requires error: Error, got ${typeof spec.error}`),
        { code: "INVALID_OUTCOME_SPEC" }
      );
    }
    const outcome = {
      transport: "failed",
      status: null,
      body: { state: "not_read", value: null, error: null },
      error: classifyTransportError(spec.error),
    };
    validateOutcome(outcome);
    return outcome;
  }

  throw Object.assign(
    new Error(`mockOutcome: unrecognized spec (transport must be "completed" or "failed", got ${JSON.stringify(spec.transport)})`),
    { code: "INVALID_OUTCOME_SPEC" }
  );
}

// ─── Scenario ─────────────────────────────────────────────────────────────

/**
 * Build a scripted multi-attempt operation. Each call to run() consumes the
 * next scripted outcome. When the script is exhausted, behavior is governed
 * by onExhausted:
 *   "throw"        (default) — rejects with code SCENARIO_EXHAUSTED
 *   "repeat_last"  — returns the last scripted outcome again
 *
 * A spec of { throw: Error } inside the attempts array is an escaped
 * rejection: run() throws that Error, which the burst scheduler treats as
 * BURST_OPERATION_REJECTED (fatal harness/programming defect). It is NOT
 * converted to a transport-failed outcome — that path belongs to
 * { transport: "failed", error: Error }, which runs through mockOutcome.
 *
 * Each non-throw attempt is normalized via mockOutcome before being recorded
 * in the trace and returned. start/settle events carry the scenarioOperationId
 * (distinct from the burst engine's input-position result id) so tests can
 * assert ordering.
 *
 * @param {object} opts
 * @param {Array} opts.attempts scripted specs
 * @param {object} [opts.clock] injected clock for trace timestamps
 * @param {object} [opts.trace] injected trace (one is created if omitted)
 * @param {"throw"|"repeat_last"} [opts.onExhausted="throw"]
 * @returns {{run: () => Promise<object>, cleanup: () => Promise<void>, pendingDeferredCount: () => number, trace: object}}
 */
export function createScenario(opts = {}) {
  const { attempts = [] } = opts;
  if (!Array.isArray(attempts)) {
    throw Object.assign(new Error("createScenario: attempts must be an array"), { code: "INVALID_SCENARIO" });
  }
  const onExhausted = opts.onExhausted || "throw";
  if (onExhausted !== "throw" && onExhausted !== "repeat_last") {
    throw Object.assign(
      new Error(`createScenario: onExhausted must be "throw" or "repeat_last", got ${JSON.stringify(onExhausted)}`),
      { code: "INVALID_SCENARIO" }
    );
  }

  const clock = opts.clock || createClock(0);
  const trace = opts.trace || createTrace({ clock });
  let nextScenarioOpId = 0;
  let cursor = 0;
  let closing = false;
  // Track the OUTER run() promises (not the inner IIFEs). cleanup() attaches
  // a safety catch to any still-pending outer promise so a caller who fires
  // run() without awaiting does not produce an unhandledRejection at process
  // exit. Legitimate callers still receive rejections via their own await;
  // the safety catch only suppresses the orphaned-reference count.
  const activeRuns = new Set();

  const run = async () => {
    if (closing) {
      throw Object.assign(new Error("scenario.run: scenario is closing/closed"), { code: SCENARIO_CANCELLED });
    }
    const scenarioOperationId = nextScenarioOpId++;
    trace.append({ kind: "attempt_start", scenarioOperationId, detail: { cursor } });

    let spec;
    if (cursor < attempts.length) {
      spec = attempts[cursor];
      cursor++;
    } else if (onExhausted === "repeat_last" && attempts.length > 0) {
      spec = attempts[attempts.length - 1];
    } else {
      throw Object.assign(
        new Error(`scenario: attempts exhausted (consumed ${cursor})`),
        { code: SCENARIO_EXHAUSTED }
      );
    }

    if (spec && typeof spec === "object" && spec.throw instanceof Error) {
      trace.append({ kind: "attempt_throw", scenarioOperationId, detail: { code: spec.throw.code || null } });
      throw spec.throw;
    }

    const outcome = mockOutcome(spec);
    trace.append({
      kind: "attempt_settle",
      scenarioOperationId,
      detail: { transport: outcome.transport, status: outcome.status },
    });
    return outcome;
  };

  // Wrap run so every invocation tracks its outer promise. The tracking Set
  // is what cleanup() drains; the safety catch is attached in cleanup() to
  // any promise still in the Set at drain time, so fire-and-forget callers
  // don't leak unhandled rejections.
  const trackedRun = (...args) => {
    const p = run(...args);
    activeRuns.add(p);
    // Self-remove on settle. The .finally callback itself cannot throw, so
    // its returned promise resolves cleanly; we attach a safety .catch on
    // that returned promise so a rejecting p does not propagate through the
    // finally chain as an unhandled rejection (finally re-throws the
    // original rejection, which would otherwise have no consumer).
    p.finally(() => activeRuns.delete(p)).catch(() => { /* safety */ });
    return p;
  };

  const pendingDeferredCount = () => 0; // C1 has no built-in deferreds; callers compose with deferred().

  const cleanup = async () => {
    if (closing) return; // idempotent — second call is a no-op
    closing = true;
    // Snapshot pending runs. Attach a safety catch to each BEFORE awaiting
    // so any that reject during the allSettled drain cannot surface as
    // unhandledRejection (allSettled itself does not count as a handler for
    // Node's unhandled-rejection detection in some runtimes; the explicit
    // catch is the portable guarantee).
    const pending = [...activeRuns];
    for (const p of pending) p.catch(() => { /* safety — see trackedRun */ });
    await Promise.allSettled(pending);
    activeRuns.clear();
    trace.append({ kind: "scenario_cleanup", detail: { consumedAttempts: cursor } });
  };

  return Object.freeze({
    run: trackedRun,
    cleanup,
    pendingDeferredCount,
    trace,
  });
}
