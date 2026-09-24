// tests/unit/review-heartbeat-timeout-classification.test.js
// Regression for #248: the heartbeat's own timeout must enter the same
// retryable transient-provider path as a primary inference timeout. Before
// this fix it threw an unclassified Error, so reviewPR persisted generic
// terminal_reason='error' and returned null instead of rethrowing for BullMQ.

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockInfo = jest.fn();
const mockError = jest.fn();

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: mockInfo,
    error: mockError,
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

const { withHeartbeat } = await import("../../src/services/reviewHeartbeat.js");

describe("reviewHeartbeat timeout classification", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("classifies its own inference timeout as retryable transient provider timeout", async () => {
    let observed;
    const pending = withHeartbeat(
      () => new Promise(() => {}),
      { label: "claude review", intervalMs: 1000, timeoutMs: 50 }
    ).catch((err) => {
      observed = err;
    });

    await jest.advanceTimersByTimeAsync(50);
    await pending;

    expect(observed).toBeInstanceOf(Error);
    expect(observed).toMatchObject({
      name: "ReviewHeartbeatTimeoutError",
      gitwireErrorCode: "E_REVIEW_PROVIDER_TRANSIENT",
      gitwireRejectionClass: "timeout",
    });
    expect(observed.message).toBe("Review timed out after 0.05s: claude review");
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ label: "claude review", err: observed.message }),
      expect.stringContaining("review failed: claude review")
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it("clears heartbeat and deadline timers after a successful operation", async () => {
    await expect(withHeartbeat(
      async () => "ok",
      { label: "claude review", intervalMs: 1000, timeoutMs: 5000 }
    )).resolves.toBe("ok");

    expect(jest.getTimerCount()).toBe(0);
  });

  it("preserves an underlying provider error instead of reclassifying it", async () => {
    const source = new Error("provider rejected request");
    source.gitwireErrorCode = "E_REVIEW_PROVIDER_TRANSIENT";
    source.gitwireRejectionClass = "rate_limit";

    await expect(withHeartbeat(
      async () => { throw source; },
      { label: "claude review", intervalMs: 1000, timeoutMs: 5000 }
    )).rejects.toBe(source);

    expect(jest.getTimerCount()).toBe(0);
  });
});
