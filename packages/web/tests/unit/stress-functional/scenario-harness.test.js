// tests/unit/stress-functional/scenario-harness.test.js
//
// C1 tests for the deterministic scenario harness. Network-free, timer-free,
// clock-free. Every correctness assertion reads the injected clock, the
// injected sleeper, or the structured trace — never elapsed wall-clock time.
//
// Seven harness tests + one determinism guard. Each asserts exact results,
// not summary counters, except where a counter IS the property under test
// (e.g. sleeper.calls).

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  createClock,
  createSleeper,
  createTrace,
  deferred,
  mockOutcome,
  createScenario,
  validateDeferredGate,
  SCENARIO_EXHAUSTED,
  SCENARIO_CANCELLED,
} from "../../stress/modules/scenario-harness.js";
import { runContractedOperation } from "../../stress/burst-runner.js";

// ─── Source-level determinism guard ───────────────────────────────────────
//
// Prove the harness source contains no forbidden real-time / real-timer
// tokens. If a future edit introduces one, this test fails BEFORE any
// behavioral test runs, and the static-gate rule (added in the same commit)
// also fails at CI time. This is defense in depth: the source-level guard
// catches the defect even if the static gate is bypassed.

describe("scenario-harness — source-level determinism guard", () => {
  it("contains no Date.now / performance.now / setTimeout / setInterval", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const __filename = url.fileURLToPath(import.meta.url);
    // tests/unit/stress-functional/scenario-harness.test.js →
    //   ../../stress/modules/scenario-harness.js
    const harnessPath = path.resolve(path.dirname(__filename), "../../stress/modules/scenario-harness.js");
    const src = fs.readFileSync(harnessPath, "utf8");
    // Strip the FORBIDDEN_TIME_TOKENS comment block, which legitimately
    // mentions the tokens to document the rule. The guard checks actual
    // executable source, not documentation.
    const stripped = src.replace(/\/\/\s*FORBIDDEN_TIME_TOKENS[\s\S]*?\]/, "");
    for (const tok of ["Date.now", "performance.now", "setTimeout", "setInterval"]) {
      expect(stripped).not.toContain(tok);
    }
  });
});

// ─── 1. clean scenario completes ──────────────────────────────────────────

describe("scenario-harness — clean scenario completes", () => {
  let scenario;
  afterEach(async () => { if (scenario) await scenario.cleanup(); });

  it("consumes scripted outcomes in order and records an exact trace", async () => {
    const clock = createClock(0);
    const trace = createTrace({ clock });
    scenario = createScenario({
      clock,
      trace,
      attempts: [
        { transport: "completed", status: 200, body: { ok: true } },
        { transport: "completed", status: 201, body: { id: 1 } },
      ],
    });

    const a = await scenario.run();
    // Advance the clock between runs so trace timestamps are distinguishable
    // and the exact-equality assertion is meaningful (not all-zero).
    clock.advance(10);
    const b = await scenario.run();

    // Outcomes consumed in order, normalized to valid ClassifiedOutcomes.
    expect(a).toMatchObject({ transport: "completed", status: 200, body: { state: "parsed", value: { ok: true } } });
    expect(b).toMatchObject({ transport: "completed", status: 201, body: { state: "parsed", value: { id: 1 } } });

    // Exact trace: full event objects including ts, kind, scenarioOperationId,
    // cursor, and the settle detail. Mutation of a returned snapshot must not
    // affect the stored trace (covered by its own test below).
    expect(trace.events()).toEqual([
      { ts: 0, kind: "attempt_start", scenarioOperationId: 0, detail: { cursor: 0 } },
      { ts: 0, kind: "attempt_settle", scenarioOperationId: 0, detail: { transport: "completed", status: 200 } },
      { ts: 10, kind: "attempt_start", scenarioOperationId: 1, detail: { cursor: 1 } },
      { ts: 10, kind: "attempt_settle", scenarioOperationId: 1, detail: { transport: "completed", status: 201 } },
    ]);
  });
});

// ─── 2. deferred operation does not complete early ────────────────────────

describe("scenario-harness — deferred barrier", () => {
  it("deferred does not settle until explicitly resolved", async () => {
    const d = deferred();
    expect(d.settled).toBe(false);
    expect(d.resolution).toBe(null);

    // Schedule a waiter; yield once so it's actually waiting on the promise.
    let captured = "pending";
    d.promise.then(() => { captured = "fulfilled"; }, () => { captured = "rejected"; });
    await Promise.resolve();
    expect(captured).toBe("pending");
    expect(d.settled).toBe(false);

    d.resolve("value");
    await Promise.resolve();
    expect(d.settled).toBe(true);
    expect(captured).toBe("fulfilled");
    expect(d.resolution).toEqual({ status: "fulfilled", value: "value" });
  });

  it("deferred settles exactly once (second resolve/reject is a no-op)", () => {
    const d = deferred();
    d.resolve("first");
    expect(d.settled).toBe(true);
    d.resolve("second"); // no-op
    d.reject(new Error("late")); // no-op
    expect(d.resolution).toEqual({ status: "fulfilled", value: "first" });
  });
});

// ─── 3. transport failure is classified, not escaped ──────────────────────

describe("scenario-harness — transport failure vs escaped rejection", () => {
  let scenario;
  afterEach(async () => { if (scenario) await scenario.cleanup(); });

  it("transport-failure spec → valid ClassifiedOutcome with classified error", async () => {
    const connectionError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    scenario = createScenario({
      attempts: [{ transport: "failed", error: connectionError }],
    });
    const outcome = await scenario.run();
    expect(outcome.transport).toBe("failed");
    expect(outcome.status).toBe(null);
    expect(outcome.body).toEqual({ state: "not_read", value: null, error: null });
    expect(outcome.error).toMatchObject({ category: "connection_refused", code: "ECONNREFUSED" });
  });

  it("escaped-throw spec → run() rejects with the thrown Error (becomes BURST_OPERATION_REJECTED in the engine)", async () => {
    const connectionError = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    scenario = createScenario({
      attempts: [{ throw: connectionError }],
    });
    // The harness propagates the throw verbatim — the engine then attributes
    // it as BURST_OPERATION_REJECTED when this run() is the operation body.
    await expect(scenario.run()).rejects.toThrow("connect failed");
  });
});

// ─── 4. controlled response preserves status and body ────────────────────

describe("scenario-harness — controlled response through runContractedOperation", () => {
  let scenario;
  afterEach(async () => { if (scenario) await scenario.cleanup(); });

  it("a scripted 503 with body round-trips through the engine", async () => {
    scenario = createScenario({
      attempts: [{ transport: "completed", status: 503, body: { error: "busy" } }],
    });
    // The harness composes on the engine: scenario.run is the operation's
    // run() body; the contract classifies it.
    const result = await runContractedOperation({
      kind: "test",
      method: "GET",
      run: scenario.run,
      responseContract: { expectedStatuses: [503] },
    });
    // Full ClassifiedOutcome preserved on the result.
    expect(result.transport).toBe("completed");
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ state: "parsed", value: { error: "busy" }, error: null });
    expect(result.error).toBe(null);
    // Contract classification: 503 ∈ expectedStatuses → http=expected.
    expect(result.http).toBe("expected");
  });
});

// ─── 5. injected clock and sleeper are used ───────────────────────────────

describe("scenario-harness — injected clock and sleeper", () => {
  it("sleeper advances the injected clock and records the call (no wall-clock delay)", async () => {
    const clock = createClock(1000);
    const trace = createTrace({ clock });
    const sleeper = createSleeper({ clock, trace });

    const before = clock.value();
    await sleeper.sleep(2000);
    const after = clock.value();

    expect(sleeper.calls()).toEqual([2000]);
    expect(after - before).toBe(2000); // deterministic, no real wait
    expect(trace.events()).toEqual([{ ts: 3000, kind: "sleep", detail: { ms: 2000 } }]);
  });

  it("clock.now reads without advancing; advance moves time deterministically", () => {
    const clock = createClock(500);
    expect(clock.now()).toBe(500);
    expect(clock.value()).toBe(500);
    expect(clock.advance(10)).toBe(510);
    expect(clock.now()).toBe(510);
  });
});

// ─── 6. cleanup is async, idempotent, and rejects further runs ────────────

describe("scenario-harness — cleanup", () => {
  it("cleanup awaits active runs, marks the scenario closed, and is idempotent", async () => {
    const trace = createTrace({ clock: createClock(0) });
    const scenario = createScenario({
      trace,
      attempts: [
        { transport: "completed", status: 200 },
        { transport: "completed", status: 200 },
      ],
    });

    await scenario.run();
    const secondRun = scenario.run(); // do not await yet
    await scenario.cleanup();         // awaits the in-flight run via allSettled
    await secondRun;                  // settled by cleanup; awaiting again is safe

    // Idempotent: second cleanup returns without throwing.
    await expect(scenario.cleanup()).resolves.toBeUndefined();

    // Further runs reject with SCENARIO_CANCELLED.
    await expect(scenario.run()).rejects.toMatchObject({ code: SCENARIO_CANCELLED });

    // Trace records cleanup.
    expect(trace.events().some((e) => e.kind === "scenario_cleanup")).toBe(true);
  });

  it("pendingDeferredCount is 0 in C1 (no built-in deferreds; callers compose with deferred())", () => {
    const scenario = createScenario({ attempts: [] });
    expect(scenario.pendingDeferredCount()).toBe(0);
  });

  it("fire-and-forget run() that rejects does not leak an unhandled rejection", async () => {
    // Regression for the trackedRun finally-chain leak: a caller who fires
    // run() without awaiting, on a scenario whose next attempt throws, must
    // not produce a process-level unhandledRejection. The trackedRun wrapper
    // attaches a safety .catch on the .finally return promise so the
    // rejecting p does not propagate through the finally chain unhandled.
    //
    // Event-loop turns (not a real timer) are enough for Node to emit any
    // pending unhandledRejection — the assertion does not depend on a
    // machine completing a timer within an arbitrary duration.
    const rejections = [];
    const handler = (reason) => { rejections.push(reason); };
    process.on("unhandledRejection", handler);
    try {
      const scenario = createScenario({
        attempts: [{ throw: Object.assign(new Error("late"), { code: "LATE" }) }],
      });
      scenario.run(); // fire and forget — the misuse pattern
      await scenario.cleanup();
      // Two setImmediate yields let Node fire any queued microtasks and
      // emit unhandledRejection if one is pending. No wall-clock wait.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("cleanup cancels a genuinely-blocked deferred run with SCENARIO_CANCELLED", async () => {
    // The primary C1-fix regression: run() is blocked on a deferred gate
    // when cleanup begins. cleanup must reject the gate with SCENARIO_CANCELLED
    // so the blocked run settles, the original caller observes the typed
    // cancellation, and no deferred leaks past cleanup.
    const gate = deferred();
    const trace = createTrace({ clock: createClock(0) });
    const scenario = createScenario({
      trace,
      attempts: [{ deferred: gate }],
    });

    // Start the run; let it reach the await gate.promise line.
    const runP = scenario.run();
    await new Promise((r) => setImmediate(r));
    expect(scenario.pendingDeferredCount()).toBe(1); // genuinely blocked

    // cleanup while run is blocked.
    const cleanupP = scenario.cleanup();
    let observed = null;
    try { await runP; } catch (e) { observed = e; }
    await cleanupP;

    // Original caller observes the typed cancellation.
    expect(observed).toMatchObject({ code: SCENARIO_CANCELLED });
    // Deferred gate released; count returns to zero.
    expect(scenario.pendingDeferredCount()).toBe(0);
    // Trace records a terminal cancellation event with the exact count of
    // cancelled gates (captured before rejection so the count is not zeroed
    // by each gate's self-removal in its finally block).
    const cleanupEvents = trace.events().filter((e) => e.kind === "scenario_cleanup");
    expect(cleanupEvents.length).toBe(1);
    expect(cleanupEvents[0].detail.cancelledDeferreds).toBe(1);
  });

  it("concurrent cleanup() calls return the same promise and join the drain", async () => {
    // Regression: a second cleanup() made while the first is still draining
    // must NOT resolve immediately via `if (closing) return` — that would
    // race the first drain. Both calls receive the same promise and await
    // the same settlement.
    const gate = deferred();
    const scenario = createScenario({
      trace: createTrace({ clock: createClock(0) }),
      attempts: [{ deferred: gate }],
    });
    const runP = scenario.run();
    await new Promise((r) => setImmediate(r));

    const cleanupA = scenario.cleanup();
    const cleanupB = scenario.cleanup();
    expect(cleanupB).toBe(cleanupA); // same promise — single drain

    await Promise.all([cleanupA, cleanupB]);
    await expect(runP).rejects.toMatchObject({ code: SCENARIO_CANCELLED });
  });

  it("a fulfilled deferred value is normalized through mockOutcome", async () => {
    const gate = deferred();
    const scenario = createScenario({
      trace: createTrace({ clock: createClock(0) }),
      attempts: [{ deferred: gate }],
    });
    const runP = scenario.run();
    await new Promise((r) => setImmediate(r));
    gate.resolve({ transport: "completed", status: 200, body: { ok: true } });
    const result = await runP;
    // Fulfilled value ran through mockOutcome — body wrapped, validated.
    expect(result).toMatchObject({
      transport: "completed",
      status: 200,
      body: { state: "parsed", value: { ok: true }, error: null },
      error: null,
    });
    await scenario.cleanup();
  });
});

// ─── 7. determinism — same script + same clock = byte-identical traces ────

describe("scenario-harness — determinism", () => {
  it("two scenarios with the same script and same clock produce identical traces", async () => {
    const script = [
      { transport: "completed", status: 200, body: { ok: true } },
      { transport: "failed", error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    ];

    function build() {
      const clock = createClock(0);
      const trace = createTrace({ clock });
      return { clock, trace, scenario: createScenario({ clock, trace, attempts: script }) };
    }

    const a = build();
    const b = build();
    await a.scenario.run();
    await a.scenario.run();
    await b.scenario.run();
    await b.scenario.run();
    await a.scenario.cleanup();
    await b.scenario.cleanup();

    expect(a.trace.events()).toEqual(b.trace.events());
  });

  it("onExhausted='throw' rejects with SCENARIO_EXHAUSTED; 'repeat_last' returns the last outcome", async () => {
    const throwing = createScenario({
      attempts: [{ transport: "completed", status: 200 }],
      onExhausted: "throw",
    });
    await throwing.run();
    await expect(throwing.run()).rejects.toMatchObject({ code: SCENARIO_EXHAUSTED });
    await throwing.cleanup();

    const repeating = createScenario({
      attempts: [{ transport: "completed", status: 200, body: { n: 1 } }],
      onExhausted: "repeat_last",
    });
    await repeating.run();
    const again = await repeating.run();
    expect(again).toMatchObject({ transport: "completed", status: 200, body: { state: "parsed", value: { n: 1 } } });
    await repeating.cleanup();
  });
});

// ─── mockOutcome boundary failures ────────────────────────────────────────

describe("scenario-harness — mockOutcome boundary failures", () => {
  it("rejects a spec with non-integer status", () => {
    expect(() => mockOutcome({ transport: "completed", status: 99.5 }))
      .toThrow(/integer status 100-599/);
  });

  it("rejects a failed spec without an Error", () => {
    expect(() => mockOutcome({ transport: "failed", error: "string" }))
      .toThrow(/error: Error/);
  });

  it("rejects an unrecognized transport", () => {
    expect(() => mockOutcome({ transport: "purple" }))
      .toThrow(/transport must be "completed" or "failed"/);
  });
});

// ─── Defensive copy: trace and sleeper snapshots ──────────────────────────

describe("scenario-harness — defensive snapshots", () => {
  it("mutating a returned trace snapshot does not corrupt the stored trace", async () => {
    const trace = createTrace({ clock: createClock(0) });
    const scenario = createScenario({
      trace,
      attempts: [{ transport: "completed", status: 200, body: { ok: true } }],
    });
    await scenario.run();
    await scenario.cleanup();

    const original = trace.events();
    // Mutate the returned snapshot in depth.
    original[0].kind = "corrupted";
    original[0].detail.status = 999;
    if (original.find((e) => e.kind === "attempt_settle")) {
      original.find((e) => e.kind === "attempt_settle").detail.status = 999;
    }

    // A fresh snapshot is unaffected.
    const fresh = trace.events();
    expect(fresh[0].kind).toBe("attempt_start");
    expect(fresh[0].detail).toEqual({ cursor: 0 });
    const settle = fresh.find((e) => e.kind === "attempt_settle");
    if (settle) expect(settle.detail.status).toBe(200);
  });

  it("mutating a returned sleeper.calls() snapshot does not corrupt the record", async () => {
    const sleeper = createSleeper({ clock: createClock(0) });
    await sleeper.sleep(10);
    await sleeper.sleep(20);

    const snap = sleeper.calls();
    expect(snap).toEqual([10, 20]);
    snap.push(999);
    snap[0] = -1;

    expect(sleeper.calls()).toEqual([10, 20]);
  });
});

// ─── Fail-closed: invalid arguments ───────────────────────────────────────

describe("scenario-harness — invalid-argument fail-closed", () => {
  it("createClock rejects a non-finite initialMs", () => {
    expect(() => createClock(Infinity)).toThrow(/initialMs must be a finite number/);
    expect(() => createClock(NaN)).toThrow(/initialMs must be a finite number/);
    expect(() => createClock("100")).toThrow(/initialMs must be a finite number/);
  });

  it("createClock accepts undefined and finite initialMs", () => {
    expect(() => createClock()).not.toThrow();
    expect(() => createClock(0)).not.toThrow();
    expect(() => createClock(1000)).not.toThrow();
  });

  it("clock.advance rejects negative, non-finite, and non-numeric values", () => {
    const clock = createClock(0);
    expect(() => clock.advance(-1)).toThrow(/non-negative finite number/);
    expect(() => clock.advance(Infinity)).toThrow(/non-negative finite number/);
    expect(() => clock.advance(NaN)).toThrow(/non-negative finite number/);
    expect(() => clock.advance("10")).toThrow(/non-negative finite number/);
  });

  it("clock.advance(0) is a valid no-movement call", () => {
    const clock = createClock(100);
    expect(clock.advance(0)).toBe(100);
    expect(clock.now()).toBe(100);
  });

  it("sleeper.sleep rejects invalid delays", async () => {
    const sleeper = createSleeper({});
    await expect(sleeper.sleep(-1)).rejects.toThrow(/non-negative finite number/);
    await expect(sleeper.sleep(Infinity)).rejects.toThrow(/non-negative finite number/);
    await expect(sleeper.sleep(NaN)).rejects.toThrow(/non-negative finite number/);
  });
});

// ─── Deferred-gate validation ─────────────────────────────────────────────

describe("scenario-harness — deferred-gate validation", () => {
  it("validateDeferredGate accepts a well-formed gate", () => {
    const g = deferred();
    expect(() => validateDeferredGate(g)).not.toThrow();
  });

  it("validateDeferredGate rejects a missing promise", () => {
    expect(() => validateDeferredGate({ reject: () => {} })).toThrow(/invalid deferred gate/);
  });

  it("validateDeferredGate rejects a non-thenable promise", () => {
    expect(() => validateDeferredGate({ promise: {}, reject: () => {} })).toThrow(/invalid deferred gate/);
  });

  it("validateDeferredGate rejects a missing reject", () => {
    expect(() => validateDeferredGate({ promise: Promise.resolve() })).toThrow(/invalid deferred gate/);
  });

  it("validateDeferredGate rejects a non-function reject", () => {
    expect(() => validateDeferredGate({ promise: Promise.resolve(), reject: "nope" })).toThrow(/invalid deferred gate/);
  });

  it("run() rejects a malformed gate BEFORE entering pendingGates (cleanup stays safe)", async () => {
    // The primary A2 regression: a malformed gate that passed the old loose
    // predicate but had no callable reject made cleanup throw and left the
    // run blocked. Now the gate is validated before tracking; the run rejects
    // with INVALID_DEFERRED_GATE, pendingDeferredCount stays 0, and cleanup
    // runs cleanly.
    const scenario = createScenario({
      trace: createTrace({ clock: createClock(0) }),
      attempts: [{ deferred: { promise: new Promise(() => {}) } }],
    });
    await expect(scenario.run()).rejects.toMatchObject({ code: "INVALID_DEFERRED_GATE" });
    expect(scenario.pendingDeferredCount()).toBe(0);
    await expect(scenario.cleanup()).resolves.toBeUndefined();
  });

  it("a gate with callable reject but no resolve is still valid (resolve is not required by the harness)", () => {
    // The harness only invokes gate.reject (cleanup). resolve() is called by
    // the external test code that controls the gate. validateDeferredGate
    // must not require resolve.
    const minimalGate = { promise: Promise.resolve(), reject: () => {} };
    expect(() => validateDeferredGate(minimalGate)).not.toThrow();
  });
});
