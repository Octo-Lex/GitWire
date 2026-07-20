// tests/unit/stress-functional/bounded-concurrency.test.js
//
// C3 of P2: proves the burst scheduler never exceeds its configured
// concurrency limit, using controlled deferred barriers (not elapsed-time
// inference). Every operation has TWO barriers:
//
//   startedSignal — resolved by run() immediately on entry, proving the
//                   scheduler admitted this operation.
//   releaseGate   — awaited by run() until the test permits settlement,
//                   keeping the operation in-flight (holding a slot).
//
// An injected `state` object independently tracks active/maxActive so the
// scheduler's `maxInFlightObserved` is cross-checked against external
// observation, never used as its own sole proof.
//
// Deterministic clock and event-loop-turn helpers keep the suite wall-clock-
// free and timing-independent.

import { describe, it, expect } from "@jest/globals";
import { runBurst, runContractedBurst } from "../../stress/burst-runner.js";
import { deferred } from "../../stress/modules/scenario-harness.js";

// ─── Deterministic helpers ────────────────────────────────────────────────

/** Deterministic monotonic clock — never wall-clock. Each call returns ++tick. */
function deterministicNow() {
  let tick = 0;
  return () => ++tick;
}

/** Event-loop-turn yield — allows queued promise work (scheduler refill
 *  chains) to drain without any wall-clock delay. */
function flushSchedulerTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A valid ClassifiedOutcome for a completed GET 200. */
function completedOutcome(status = 200) {
  return {
    transport: "completed",
    status,
    body: { state: "empty", value: null, error: null },
    error: null,
  };
}

/** A valid ClassifiedOutcome for a transport failure. */
function failedOutcome(category = "timeout", code = "ETIMEDOUT") {
  return {
    transport: "failed",
    status: null,
    body: { state: "not_read", value: null, error: null },
    error: { category, name: "Error", code, message: "fail" },
  };
}

/**
 * Build a controlled operation with TWO barriers. The `state` object
 * independently tracks how many ops are active and the max observed.
 *
 * @param {number} id operation id
 * @param {{active: number, maxActive: number}} state shared mutable state
 * @param {object} [opts]
 * @param {object} [opts.outcome] ClassifiedOutcome to return on release; default completedOutcome(200)
 * @returns {{started: object, release: object, descriptor: object}}
 */
function controlledOperation(id, state, opts = {}) {
  const started = deferred();
  const release = deferred();
  const outcome = opts.outcome ?? completedOutcome(200);

  return {
    started,
    release,
    descriptor: {
      kind: `op-${id}`,
      method: "GET",
      run: async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        started.resolve(id);
        try {
          await release.promise;
          return outcome;
        } finally {
          state.active -= 1;
        }
      },
    },
  };
}

/** Build N controlled operations sharing a state object. */
function buildOps(n, state, opts) {
  return Array.from({ length: n }, (_, i) => controlledOperation(i, state, opts));
}

/** Release all gates and drain the burst promise — use in try/finally. */
async function releaseAllAndDrain(controls, burstPromise) {
  for (const c of controls) {
    try { c.release.resolve(); } catch { /* already settled */ }
  }
  await flushSchedulerTurn();
  try { await burstPromise; } catch { /* may reject */ }
}

// ─── 1. Concurrency matrix ────────────────────────────────────────────────

describe("bounded concurrency — matrix", () => {
  const configs = [
    { concurrency: 1, ops: 3, expected: 1 },
    { concurrency: 2, ops: 5, expected: 2 },
    { concurrency: 3, ops: 5, expected: 3 },
    { concurrency: 5, ops: 5, expected: 5 },
    { concurrency: 8, ops: 5, expected: 5 },
  ];

  for (const { concurrency, ops: nOps, expected } of configs) {
    it(`concurrency=${concurrency}, ops=${nOps} → maxActive=${expected}`, async () => {
      const state = { active: 0, maxActive: 0 };
      const now = deterministicNow();
      const controls = buildOps(nOps, state);
      const descriptors = controls.map((c) => c.descriptor);

      const burstPromise = runBurst(descriptors, {
        concurrency, pacing: { mode: "none" }, now,
      });
      await flushSchedulerTurn();

      expect(state.maxActive).toBe(expected);
      expect(state.maxActive).toBeLessThanOrEqual(concurrency);

      for (const c of controls) c.release.resolve();
      const aggregate = await burstPromise;

      expect(aggregate.maxInFlightObserved).toBe(state.maxActive);
      expect(aggregate.requestedConcurrency).toBe(concurrency);
      expect(aggregate.attempted).toBe(nOps);
    });
  }
});

// ─── 2. Invalid concurrency rejection ─────────────────────────────────────

describe("bounded concurrency — invalid configuration", () => {
  const now = deterministicNow();
  const ops = [{ kind: "t", method: "GET", run: async () => completedOutcome() }];

  const invalid = [
    ["0", 0],
    ["negative", -1],
    ["fractional", 0.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ['numeric string "3"', "3"],
  ];

  for (const [label, value] of invalid) {
    it(`concurrency=${label} rejects before any work starts`, async () => {
      await expect(
        runBurst(ops, { concurrency: value, pacing: { mode: "none" }, now })
      ).rejects.toThrow(/concurrency must be a positive integer/);
    });
  }

  it("missing concurrency property rejects", async () => {
    await expect(
      runBurst(ops, { pacing: { mode: "none" }, now })
    ).rejects.toThrow(/concurrency must be a positive integer/);
  });

  it("invalid concurrency does not invoke any operation run()", async () => {
    let started = false;
    const op = { kind: "t", method: "GET", run: async () => { started = true; return completedOutcome(); } };
    try {
      await runBurst([op], { concurrency: 0, pacing: { mode: "none" }, now });
    } catch {
      // expected rejection
    }
    expect(started).toBe(false);
  });
});

// ─── 3. Semaphore refill protocol ─────────────────────────────────────────

describe("bounded concurrency — semaphore refill protocol", () => {
  it("concurrency=2, 5 ops: exactly 2 start, refill one-at-a-time on release", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const controls = buildOps(5, state);
    const burstPromise = runBurst(controls.map((c) => c.descriptor), {
      concurrency: 2, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      expect(state.active).toBe(2);
      expect(controls.filter((c) => c.started.settled).length).toBe(2);
      expect(controls.filter((c) => !c.started.settled).length).toBe(3);

      controls[0].release.resolve();
      await flushSchedulerTurn();
      expect(state.active).toBe(2);
      expect(controls.filter((c) => c.started.settled).length).toBe(3);

      controls[1].release.resolve();
      await flushSchedulerTurn();
      expect(state.active).toBe(2);
      expect(controls.filter((c) => c.started.settled).length).toBe(4);

      for (let i = 2; i < 5; i++) controls[i].release.resolve();
      const aggregate = await burstPromise;

      expect(aggregate.attempted).toBe(5);
      expect(aggregate.results).toHaveLength(5);
      expect(aggregate.results.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
      expect(aggregate.results.every(Boolean)).toBe(true);
      expect(aggregate.maxInFlightObserved).toBe(2);
      expect(state.maxActive).toBe(2);
    } finally {
      await releaseAllAndDrain(controls, burstPromise);
    }
  });
});

// ─── 4. legacy_batches cohort protocol ────────────────────────────────────

describe("bounded concurrency — legacy_batches cohort admission", () => {
  it("5 ops, concurrency=2, legacy_batches: cohort boundaries enforced", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const controls = buildOps(5, state);
    const burstPromise = runBurst(controls.map((c) => c.descriptor), {
      concurrency: 2,
      pacing: { mode: "legacy_batches", delayMs: 0 },
      now,
    });

    try {
      await flushSchedulerTurn();
      expect(controls.filter((c) => c.started.settled).length).toBe(2);

      controls[0].release.resolve();
      await flushSchedulerTurn();
      expect(controls.filter((c) => c.started.settled).length).toBe(2);

      controls[1].release.resolve();
      await flushSchedulerTurn();
      expect(controls.filter((c) => c.started.settled).length).toBe(4);

      controls[2].release.resolve();
      await flushSchedulerTurn();
      expect(controls.filter((c) => c.started.settled).length).toBe(4);

      controls[3].release.resolve();
      await flushSchedulerTurn();
      expect(controls.filter((c) => c.started.settled).length).toBe(5);

      controls[4].release.resolve();
      const aggregate = await burstPromise;

      expect(state.maxActive).toBe(2);
      expect(aggregate.maxInFlightObserved).toBe(2);
      expect(aggregate.attempted).toBe(5);
      expect(aggregate.results.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await releaseAllAndDrain(controls, burstPromise);
    }
  });
});

// ─── 5. Slot-release cases ────────────────────────────────────────────────

describe("bounded concurrency — slot release", () => {
  it("transport failure releases slot → next op starts", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const op0 = {
      kind: "op-0", method: "GET",
      run: async () => failedOutcome("connection_refused", "ECONNREFUSED"),
    };
    const ctrl1 = controlledOperation(1, state);
    const burstPromise = runBurst([op0, ctrl1.descriptor], {
      concurrency: 1, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      expect(ctrl1.started.settled).toBe(true);

      ctrl1.release.resolve();
      const aggregate = await burstPromise;
      expect(aggregate.attempted).toBe(2);
      expect(aggregate.transportFailed).toBe(1);
    } finally {
      await releaseAllAndDrain([ctrl1], burstPromise);
    }
  });

  it("assertion failure (semantic layer) does not retroactively hold the factual slot", async () => {
    // The contracted engine runs the FULL factual burst first, then enriches.
    // So the scheduler slot is released when the factual run() settles —
    // the assertion runs afterward over the settled results.
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const op0 = {
      kind: "op-0", method: "GET",
      run: async () => completedOutcome(200),
      responseContract: {
        expectedStatuses: [200],
        assert: () => ({ passed: false, code: "FAIL", message: "no" }),
      },
    };
    // ctrl1 needs a responseContract too — runContractedBurst requires one
    // on every operation.
    const ctrl1 = controlledOperation(1, state);
    const op1WithContract = {
      ...ctrl1.descriptor,
      responseContract: { expectedStatuses: [200] },
    };
    const burstPromise = runContractedBurst([op0, op1WithContract], {
      concurrency: 1, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      expect(ctrl1.started.settled).toBe(true);

      ctrl1.release.resolve();
      const aggregate = await burstPromise;
      expect(aggregate.attempted).toBe(2);
      expect(aggregate.assertionFailed).toBe(1);
      expect(aggregate.results[0].assertion).toBe("failed");
    } finally {
      await releaseAllAndDrain([ctrl1], burstPromise);
    }
  });

  it("escaped rejection: fatal stops scheduling, active ops drain, burst rejects", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();

    const ctrl0 = controlledOperation(0, state);
    const ctrl1Reject = deferred();
    const ctrl2 = controlledOperation(2, state);

    const op1 = {
      kind: "op-1", method: "GET",
      run: async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          await ctrl1Reject.promise;
          throw new Error("escaped rejection from op1");
        } finally {
          state.active -= 1;
        }
      },
    };

    const burstPromise = runBurst(
      [ctrl0.descriptor, op1, ctrl2.descriptor],
      { concurrency: 2, pacing: { mode: "none" }, now }
    );

    try {
      await flushSchedulerTurn();
      expect(ctrl0.started.settled).toBe(true);
      expect(ctrl2.started.settled).toBe(false);

      ctrl0.release.resolve();
      await flushSchedulerTurn();
      expect(ctrl2.started.settled).toBe(true);

      let burstSettled = false;
      burstPromise.then(() => { burstSettled = true; }, () => { burstSettled = true; });
      ctrl1Reject.reject(new Error("escaped"));
      await flushSchedulerTurn();
      expect(burstSettled).toBe(false);

      ctrl2.release.resolve();
      let caught = null;
      try { await burstPromise; } catch (err) { caught = err; }

      expect(caught).not.toBeNull();
      expect(caught.code).toBe("BURST_OPERATION_REJECTED");
      expect(caught.operation).toMatchObject({ id: 1, kind: "op-1", method: "GET" });
    } finally {
      try { ctrl0.release.resolve(); } catch {}
      try { ctrl2.release.resolve(); } catch {}
      await flushSchedulerTurn();
      try { await burstPromise; } catch {}
    }
  });
});

// ─── 6. Attribution and drain cases ───────────────────────────────────────

describe("bounded concurrency — attribution and drain", () => {
  it("reverse completion order: results keep input-position IDs", async () => {
    const now = deterministicNow();
    const blockers = Array.from({ length: 5 }, () => deferred());
    const ops = blockers.map((d, i) => ({
      kind: `op-${i}`, method: "GET",
      run: () => d.promise.then(() => completedOutcome(200)),
    }));

    const burstPromise = runBurst(ops, { concurrency: 5, pacing: { mode: "none" }, now });

    for (let i = 4; i >= 0; i--) blockers[i].resolve();
    const aggregate = await burstPromise;

    expect(aggregate.results.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
    expect(aggregate.results.map((r) => r.kind)).toEqual(["op-0", "op-1", "op-2", "op-3", "op-4"]);
  });

  it("one op settling does not resolve the burst early", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const controls = buildOps(5, state);
    const burstPromise = runBurst(controls.map((c) => c.descriptor), {
      concurrency: 2, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      controls[0].release.resolve();
      await flushSchedulerTurn();
      await flushSchedulerTurn();

      let settled = false;
      burstPromise.then(() => { settled = true; }, () => { settled = true; });
      expect(settled).toBe(false);

      for (let i = 1; i < 5; i++) controls[i].release.resolve();
      const aggregate = await burstPromise;
      expect(aggregate.attempted).toBe(5);
    } finally {
      await releaseAllAndDrain(controls, burstPromise);
    }
  });

  it("scheduler waits for all started operations before returning", async () => {
    const state = { active: 0, maxActive: 0 };
    const now = deterministicNow();
    const controls = buildOps(3, state);
    const burstPromise = runBurst(controls.map((c) => c.descriptor), {
      concurrency: 3, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      expect(state.active).toBe(3);

      controls[2].release.resolve();
      await flushSchedulerTurn();
      let settled = false;
      burstPromise.then(() => { settled = true; }, () => { settled = true; });
      expect(settled).toBe(false);

      controls[0].release.resolve();
      await flushSchedulerTurn();
      expect(settled).toBe(false);

      controls[1].release.resolve();
      const aggregate = await burstPromise;
      expect(aggregate.attempted).toBe(3);
    } finally {
      await releaseAllAndDrain(controls, burstPromise);
    }
  });

  it("empty workload throws EMPTY_WORKLOAD", async () => {
    const now = deterministicNow();
    await expect(
      runBurst([], { concurrency: 1, pacing: { mode: "none" }, now })
    ).rejects.toMatchObject({ code: "EMPTY_WORKLOAD" });
  });
});

// ─── 7. Synchronous throw no-deadlock ─────────────────────────────────────

describe("bounded concurrency — synchronous throw", () => {
  it("operation whose run() throws synchronously does not deadlock", async () => {
    const now = deterministicNow();
    const state = { active: 0, maxActive: 0 };

    const ctrl0 = controlledOperation(0, state);
    const throwingOp = {
      kind: "throw-op", method: "GET",
      run: async () => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        try {
          throw new Error("sync throw inside async run");
        } finally {
          state.active -= 1;
        }
      },
    };

    const burstPromise = runBurst([ctrl0.descriptor, throwingOp], {
      concurrency: 1, pacing: { mode: "none" }, now,
    });

    try {
      await flushSchedulerTurn();
      expect(ctrl0.started.settled).toBe(true);

      ctrl0.release.resolve();
      let caught = null;
      try { await burstPromise; } catch (err) { caught = err; }

      expect(caught).not.toBeNull();
      expect(caught.code).toBe("BURST_OPERATION_REJECTED");
    } finally {
      try { ctrl0.release.resolve(); } catch {}
      await flushSchedulerTurn();
      try { await burstPromise; } catch {}
    }
  });
});
