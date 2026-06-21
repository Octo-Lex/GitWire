// Tests for the idempotent, bounded graceful shutdown orchestrator.
//
// Root cause being fixed: the old shutdown() in index.js was async and called
// from the uncaughtException handler WITHOUT await. A second uncaughtException
// (e.g. pool.end() throwing "Called end on pool more than once") would re-enter
// shutdown() concurrently, throw again, and loop forever — the process never
// exited and never served requests.
//
// Invariant under test:
//   uncaughtException → ONE shutdown attempt → process exits
// not:
//   uncaughtException → shutdown re-entry → pool.end throws → uncaughtException loop

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { createGracefulShutdown } from "../../src/lib/gracefulShutdown.js";

// Build mock resources. Each .end()/.close()/.quit() is a jest.fn so we can
// assert call counts — the whole point is "called exactly once even under
// concurrent re-entry".
function makeMocks() {
  return {
    server: { close: jest.fn((cb) => cb && cb()) },
    workers: [{ close: jest.fn(() => Promise.resolve()) }],
    db: { end: jest.fn(() => Promise.resolve()) },
    redis: { quit: jest.fn(() => Promise.resolve()) },
    logger: { info: jest.fn(), fatal: jest.fn(), warn: jest.fn(), error: jest.fn() },
    exit: jest.fn(), // injected so the test process isn't killed
  };
}

describe("createGracefulShutdown — idempotency", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("calls db.end() exactly once even under concurrent re-entry", async () => {
    const mocks = makeMocks();
    const shutdown = createGracefulShutdown(mocks);

    // Fire shutdown twice concurrently — simulates the original bug:
    // uncaughtException → shutdown(); then a second uncaughtException before
    // the first completes.
    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("uncaughtException");

    await Promise.race([p1, p2]);
    // Drain any pending timers (the forced-exit timeout)
    jest.runAllTimers();
    await Promise.allSettled([p1, p2]);

    expect(mocks.db.end).toHaveBeenCalledTimes(1);
  });

  it("calls redis.quit() exactly once under concurrent re-entry", async () => {
    const mocks = makeMocks();
    const shutdown = createGracefulShutdown(mocks);

    await Promise.allSettled([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("uncaughtException")]);
    jest.runAllTimers();

    expect(mocks.redis.quit).toHaveBeenCalledTimes(1);
  });

  it("does not throw if db.end() rejects (e.g. 'Called end on pool more than once')", async () => {
    // This is the exact failure mode that caused the crash loop. The second
    // .end() call on a pg-pool throws. The shutdown must swallow it rather
    // than propagate to another uncaughtException.
    const mocks = makeMocks();
    mocks.db.end.mockRejectedValueOnce(new Error("Called end on pool more than once"));
    const shutdown = createGracefulShutdown(mocks);

    await expect(shutdown("SIGTERM")).resolves.not.toThrow();
    jest.runAllTimers();
    expect(mocks.exit).toHaveBeenCalled();
  });

  it("returns the same in-flight promise for concurrent callers", async () => {
    const mocks = makeMocks();
    const shutdown = createGracefulShutdown(mocks);

    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("SIGTERM");
    expect(p1).toBe(p2); // identical promise reference — no double execution
    jest.runAllTimers();
    await p1;
  });
});

describe("createGracefulShutdown — bounded exit", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("exits with code 0 on a clean signal (SIGTERM)", async () => {
    const mocks = makeMocks();
    const shutdown = createGracefulShutdown(mocks);

    await shutdown("SIGTERM");
    jest.runAllTimers();

    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 on uncaughtException (crash → let Docker restart)", async () => {
    // The key behavioral fix: after an uncaught exception, the process must
    // EXIT (code 1) so Docker's restart policy can bring it back clean,
    // rather than hang in a shutdown loop.
    const mocks = makeMocks();
    const shutdown = createGracefulShutdown(mocks);

    await shutdown("uncaughtException");
    jest.runAllTimers();

    expect(mocks.exit).toHaveBeenCalledWith(1);
  });

  it("force-exits after a timeout even if shutdown hangs", () => {
    // NOT async on purpose. In real execution the force-exit timer calls
    // process.exit, terminating the process; the runShutdown promise never
    // settles because the process is gone. We don't await it — we just assert
    // the force-exit timer fired and called exit(1). The hanging worker close
    // promise stays pending forever (as it would in prod until exit kills it).
    const mocks = makeMocks();
    // Make worker close hang forever (never resolves) — models a stuck worker.
    mocks.workers[0].close.mockImplementation(() => new Promise(() => {}));
    const shutdown = createGracefulShutdown(mocks, { forceExitMs: 5000 });

    // Kick off shutdown. Don't await — it can't resolve on its own.
    shutdown("SIGTERM");

    // Before the deadline: exit not yet called.
    expect(mocks.exit).not.toHaveBeenCalled();

    // Advance past the force-exit deadline → fires the timer → calls exit(1).
    jest.advanceTimersByTime(5000);

    expect(mocks.exit).toHaveBeenCalledWith(1);
  });
});

describe("createGracefulShutdown — does not allow re-throwing into uncaughtException", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it("swallows errors from all resource cleanup, never rejects", async () => {
    const mocks = makeMocks();
    mocks.server.close.mockImplementation(() => { throw new Error("server close boom"); });
    mocks.workers[0].close.mockRejectedValue(new Error("worker close boom"));
    mocks.db.end.mockRejectedValue(new Error("db end boom"));
    mocks.redis.quit.mockRejectedValue(new Error("redis quit boom"));

    const shutdown = createGracefulShutdown(mocks);

    // None of these should reject — if any did, it would become a new
    // uncaughtException and re-trigger the loop we're fixing.
    await expect(shutdown("SIGTERM")).resolves.not.toThrow();
    jest.runAllTimers();
    expect(mocks.exit).toHaveBeenCalled();
  });
});
