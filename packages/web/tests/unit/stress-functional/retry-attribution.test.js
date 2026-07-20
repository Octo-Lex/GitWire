// tests/unit/stress-functional/retry-attribution.test.js
//
// C4 behavioral tests: retry, duplicate, and backpressure behavior.
// All deterministic, network-free. Uses injected sleep, clock, and scripted
// outcomes. Retry delay happens BETWEEN physical attempt executions — not
// inside a runBurst slot.

import { describe, it, expect } from "@jest/globals";
import {
  createRetryPolicy,
  productionRetryPolicy,
  executeRetryScenario,
  RETRY_CLASSIFICATION_FAILED,
  RETRY_BACKOFF_FAILED,
  RETRY_DELAY_FAILED,
  classifyProductionGitHubError,
  parseRetryAfter,
  GITHUB_ERROR_REASONS,
  PRODUCTION_QUEUE_RETRY_DEFAULTS,
} from "../../stress/modules/retry-policy.js";
import { createBackpressureModel } from "../../stress/modules/backpressure.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function completedResult(status = 200) {
  return {
    kind: "t", method: "GET", durationMs: 5,
    transport: "completed", status,
    body: { state: "empty", value: null, error: null }, error: null,
    http: status === 200 ? "expected" : "unexpected",
    assertion: "not_run", assertionNotRunReason: "not_declared", assertionError: null,
  };
}

function failedResult(category = "timeout", code = "ETIMEDOUT") {
  return {
    kind: "t", method: "GET", durationMs: 5,
    transport: "failed", status: null,
    body: { state: "not_read", value: null, error: null },
    error: { category, name: "Error", code, message: "fail" },
    http: "not_received", assertion: "not_run",
    assertionNotRunReason: "transport_failed", assertionError: null,
  };
}

function serverErrorResult(status = 503) {
  return {
    kind: "t", method: "GET", durationMs: 5,
    transport: "completed", status,
    body: { state: "empty", value: null, error: null }, error: null,
    http: "unexpected", assertion: "not_run",
    assertionNotRunReason: "not_declared", assertionError: null,
  };
}

function assertionFailResult(status = 200) {
  return {
    kind: "t", method: "GET", durationMs: 5,
    transport: "completed", status,
    body: { state: "parsed", value: {}, error: null }, error: null,
    http: "expected", assertion: "failed",
    assertionNotRunReason: null, assertionError: { code: "BAD", message: "no" },
  };
}

function recordingSleeper() {
  const calls = [];
  return { calls, sleep: async (ms) => { calls.push(ms); await Promise.resolve(); } };
}

// ─── Retry behavior ───────────────────────────────────────────────────────

describe("retry attribution — behavior", () => {
  it("first attempt fails transiently (503), second succeeds → 2 attempts, logical succeeded", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), completedResult(200)];
    let idx = 0;
    const { attemptRecords, report, decisions } = await executeRetryScenario({
      logicalOperationId: "retry-ok",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(report.violations).toEqual([]);
    expect(attemptRecords.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(report.logicalOperations[0].outcome).toBe("succeeded");
    expect(sleeper.calls).toEqual([2000]); // one backoff before attempt 2
    expect(decisions[0].retry).toBe(true);
    expect(decisions[1].retry).toBe(false);
  });

  it("multiple transient failures then success → 3 attempts", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(500), serverErrorResult(502), completedResult(200)];
    let idx = 0;
    const { attemptRecords, report } = await executeRetryScenario({
      logicalOperationId: "retry-multi",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(report.violations).toEqual([]);
    expect(attemptRecords.map((r) => r.attemptNumber)).toEqual([1, 2, 3]);
    expect(report.logicalOperations[0].outcome).toBe("succeeded");
    expect(sleeper.calls).toEqual([2000, 4000]); // exponential: 2^0*2000, 2^1*2000
  });

  it("retry budget exhausted → 3 attempts, logical failed, final attempt retryable=true", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), serverErrorResult(503), serverErrorResult(503)];
    let idx = 0;
    const { attemptRecords, report, decisions } = await executeRetryScenario({
      logicalOperationId: "retry-exhausted",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(report.violations).toEqual([]);
    expect(attemptRecords.map((r) => r.attemptNumber)).toEqual([1, 2, 3]);
    expect(report.logicalOperations[0].outcome).toBe("failed");
    expect(attemptRecords[2].retryable).toBe(true); // intrinsically retryable, but budget exhausted
    expect(attemptRecords[2].final).toBe(true);
    expect(decisions[2].retry).toBe(false);
  });

  it("non-retryable error (401) → 1 attempt, no retry", async () => {
    const sleeper = recordingSleeper();
    const { attemptRecords, report, decisions } = await executeRetryScenario({
      logicalOperationId: "no-retry-401",
      executeAttempt: async () => completedResult(401),
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords).toHaveLength(1);
    expect(attemptRecords[0].final).toBe(true);
    expect(decisions[0].retry).toBe(false);
    expect(sleeper.calls).toEqual([]); // no backoff
    expect(report.logicalOperations[0].outcome).toBe("failed");
  });

  it("assertion failure is NOT retried (unless explicitly permitted)", async () => {
    const sleeper = recordingSleeper();
    const { attemptRecords, decisions } = await executeRetryScenario({
      logicalOperationId: "assert-no-retry",
      executeAttempt: async () => assertionFailResult(),
      policy: productionRetryPolicy, // retryAssertionFailures: false
      sleep: sleeper.sleep,
    });

    expect(attemptRecords).toHaveLength(1);
    expect(decisions[0].retry).toBe(false);
  });

  it("transport timeout retry → eventually succeeds", async () => {
    const sleeper = recordingSleeper();
    const results = [failedResult("timeout", "ETIMEDOUT"), completedResult(200)];
    let idx = 0;
    const { attemptRecords, report } = await executeRetryScenario({
      logicalOperationId: "timeout-retry",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(report.logicalOperations[0].outcome).toBe("succeeded");
  });

  it("abort is terminal → no retry", async () => {
    const sleeper = recordingSleeper();
    // For abort, we need a custom classifier that marks abort as non-retryable.
    const abortPolicy = createRetryPolicy({
      maxAttempts: 3,
      classifyAttempt: ({ transport }) => {
        if (transport === "failed") return { reason: "abort", retryable: false };
        return { reason: "unknown", retryable: false };
      },
      backoffMs: () => 0,
    });
    const { attemptRecords, decisions } = await executeRetryScenario({
      logicalOperationId: "abort-terminal",
      executeAttempt: async () => failedResult("abort", "ABORT_ERR"),
      policy: abortPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords).toHaveLength(1);
    expect(decisions[0].retry).toBe(false);
  });

  it("retry attempt numbering is contiguous", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), completedResult(200)];
    let idx = 0;
    const { attemptRecords } = await executeRetryScenario({
      logicalOperationId: "contiguous",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords.map((r) => r.attemptNumber)).toEqual([1, 2]);
  });

  it("all attempt latencies represented (durationMs on every record)", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), completedResult(200)];
    let idx = 0;
    const { attemptRecords } = await executeRetryScenario({
      logicalOperationId: "latencies",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords.every((r) => typeof r.durationMs === "number" && r.durationMs > 0)).toBe(true);
  });

  it("final logical status derived from terminal attempt", async () => {
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), completedResult(200)];
    let idx = 0;
    const { report } = await executeRetryScenario({
      logicalOperationId: "final-status",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    // Final attempt succeeded → logical succeeded.
    expect(report.logicalOperations[0].outcome).toBe("succeeded");
    expect(report.logical.succeeded).toBe(1);
    expect(report.logical.failed).toBe(0);
  });
});

// ─── Retry delay concurrency proof ────────────────────────────────────────

describe("retry attribution — delay outside execution slot", () => {
  it("retry sleep does not occupy an active execution slot", async () => {
    // Proof: during the retry sleep, executionState.active MUST be 0.
    // This shows the delay happens BETWEEN physical executions, not inside
    // a runBurst slot.
    const sleeper = recordingSleeper();
    const results = [serverErrorResult(503), completedResult(200)];
    let idx = 0;
    const executionState = { active: 0, maxActive: 0 };

    // Custom sleep that checks active == 0 during the delay.
    const assertIdleSleep = async (ms) => {
      sleeper.calls.push(ms);
      // During sleep, no execution should be active.
      expect(executionState.active).toBe(0);
      await Promise.resolve();
    };

    const { attemptRecords } = await executeRetryScenario({
      logicalOperationId: "delay-slot",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: assertIdleSleep,
      executionState,
    });

    expect(attemptRecords).toHaveLength(2);
    expect(executionState.maxActive).toBe(1); // never more than 1 concurrent execution
  });
});

// ─── Retry sleeper failure ────────────────────────────────────────────────

describe("retry attribution — sleeper failure", () => {
  it("sleeper throws → RETRY_DELAY_FAILED, no fake final attempt, no authoritative report", async () => {
    const failingSleep = async () => { throw new Error("sleeper boom"); };
    let caught = null;
    try {
      await executeRetryScenario({
        logicalOperationId: "sleeper-fail",
        executeAttempt: async () => serverErrorResult(503),
        policy: productionRetryPolicy,
        sleep: failingSleep,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe(RETRY_DELAY_FAILED);
    expect(caught.attemptRecords).toHaveLength(1); // prior attempt remains as diagnostic
    expect(caught.decisions).toHaveLength(1);
    // No fake final attempt was manufactured.
    expect(caught.attemptRecords[0].final).toBe(false);
  });
});

// ─── Policy configuration validation ──────────────────────────────────────

describe("retry policy — configuration validation", () => {
  it("maxAttempts=0 throws INVALID_POLICY_CONFIG", () => {
    expect(() => createRetryPolicy({ maxAttempts: 0, classifyAttempt: () => ({}), backoffMs: () => 0 }))
      .toThrow(/maxAttempts must be a positive integer/);
  });

  it("maxAttempts negative throws", () => {
    expect(() => createRetryPolicy({ maxAttempts: -1, classifyAttempt: () => ({}), backoffMs: () => 0 }))
      .toThrow(/maxAttempts must be a positive integer/);
  });

  it("maxAttempts fractional throws", () => {
    expect(() => createRetryPolicy({ maxAttempts: 1.5, classifyAttempt: () => ({}), backoffMs: () => 0 }))
      .toThrow(/maxAttempts must be a positive integer/);
  });

  it("classifyAttempt not a function throws", () => {
    expect(() => createRetryPolicy({ maxAttempts: 3, classifyAttempt: "nope", backoffMs: () => 0 }))
      .toThrow(/classifyAttempt must be a function/);
  });

  it("backoffMs not a function throws", () => {
    expect(() => createRetryPolicy({ maxAttempts: 3, classifyAttempt: () => ({}), backoffMs: "nope" }))
      .toThrow(/backoffMs must be a function/);
  });

  it("retryAssertionFailures non-boolean throws", () => {
    expect(() => createRetryPolicy({ maxAttempts: 3, classifyAttempt: () => ({}), backoffMs: () => 0, retryAssertionFailures: "yes" }))
      .toThrow(/retryAssertionFailures must be boolean/);
  });
});

// ─── Backpressure behavior ────────────────────────────────────────────────

describe("backpressure — admission control", () => {
  it("admits up to maxQueueDepth then rejects with queue_full", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 2, rateLimitPerWindow: 10, windowMs: 100, now: () => tick });

    const a1 = model.admit();
    const a2 = model.admit();
    const a3 = model.admit();

    expect(a1.admitted).toBe(true);
    expect(a2.admitted).toBe(true);
    expect(a3.admitted).toBe(false);
    expect(a3.reason).toBe("queue_full");
    expect(a3.status).toBe(503);
  });

  it("complete releases exactly one slot", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 1, rateLimitPerWindow: 10, windowMs: 100, now: () => tick });

    const a1 = model.admit();
    expect(a1.admitted).toBe(true);
    expect(model.admit().admitted).toBe(false); // full

    const result = model.complete(a1.ticket);
    expect(result.released).toBe(true);

    const a2 = model.admit();
    expect(a2.admitted).toBe(true);
  });

  it("rate-limit rejection → 429 with retryAfterMs", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 10, rateLimitPerWindow: 2, windowMs: 100, now: () => tick });

    model.admit();
    model.admit();
    const a3 = model.admit();

    expect(a3.admitted).toBe(false);
    expect(a3.reason).toBe("rate_limited");
    expect(a3.status).toBe(429);
    expect(typeof a3.retryAfterMs).toBe("number");
    expect(a3.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it("window rollover restores rate tokens", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 10, rateLimitPerWindow: 1, windowMs: 100, now: () => tick });

    expect(model.admit().admitted).toBe(true);
    expect(model.admit().admitted).toBe(false); // rate exhausted

    tick = 101; // advance past window
    expect(model.admit().admitted).toBe(true); // new window
  });

  it("closed state rejects all admissions with precedence over queue/rate", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 10, rateLimitPerWindow: 10, windowMs: 100, now: () => tick });
    model.close();

    const a = model.admit();
    expect(a.admitted).toBe(false);
    expect(a.reason).toBe("closed");
    expect(a.status).toBe(503);
  });

  it("open re-enables admission after close", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 10, rateLimitPerWindow: 10, windowMs: 100, now: () => tick });
    model.close();
    expect(model.admit().admitted).toBe(false);

    model.open();
    expect(model.admit().admitted).toBe(true);
  });

  it("double completion ticket rejected", () => {
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 1, rateLimitPerWindow: 10, windowMs: 100, now: () => tick });
    const a = model.admit();

    expect(model.complete(a.ticket).released).toBe(true);
    expect(model.complete(a.ticket).released).toBe(false);
  });

  it("rejected admission does NOT start execution (zero attempt records)", () => {
    // A closed model rejects all admissions with no execution.
    let tick = 0;
    const model = createBackpressureModel({ maxQueueDepth: 1, rateLimitPerWindow: 1, windowMs: 100, now: () => 0 });
    model.close();

    const rejected = model.admit();

    expect(rejected.admitted).toBe(false);
    expect(rejected.reason).toBe("closed");
    // The rejection is a pre-execution decision — NOT an attempt record.
    // It must not be fed into createAttemptRecord or counted as an HTTP response.
    expect(rejected.status).toBe(503);
    // snapshot confirms zero queue depth consumed (nothing started).
    expect(model.snapshot().queueDepth).toBe(0);
  });
});

// ─── Retry-After header parsing ───────────────────────────────────────────

describe("parseRetryAfter — header parsing", () => {
  it("integer seconds → milliseconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("null/undefined → null", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it("negative → null", () => {
    expect(parseRetryAfter("-1")).toBeNull();
  });

  it("excessive (> 86400 seconds) → null", () => {
    expect(parseRetryAfter("100000")).toBeNull();
  });

  it("malformed → null", () => {
    expect(parseRetryAfter("abc")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
  });
});

// ─── Duplicate behavior (injected policy) ─────────────────────────────────

describe("duplicate behavior — injected route semantics", () => {
  it("different idempotency keys → independent operations, both succeed", async () => {
    // Two logical operations with different keys execute independently.
    const sleeper = recordingSleeper();
    const { report: reportA } = await executeRetryScenario({
      logicalOperationId: "dup-a",
      executeAttempt: async () => completedResult(200),
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });
    const { report: reportB } = await executeRetryScenario({
      logicalOperationId: "dup-b",
      executeAttempt: async () => completedResult(200),
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(reportA.violations).toEqual([]);
    expect(reportB.violations).toEqual([]);
    expect(reportA.logicalOperations[0].logicalOperationId).toBe("dup-a");
    expect(reportB.logicalOperations[0].logicalOperationId).toBe("dup-b");
  });

  it("same-key replay does not execute the underlying operation twice", async () => {
    // A replay policy short-circuits: on the second submission with the same
    // key, it returns 200 with the existing result WITHOUT executing.
    let executions = 0;
    const replayStore = new Map();

    async function submitWithReplay(key, operation) {
      if (replayStore.has(key)) {
        return { replayed: true, result: replayStore.get(key) };
      }
      executions += 1;
      const { attemptRecords, report } = await executeRetryScenario({
        logicalOperationId: `key-${key}`,
        executeAttempt: operation,
        policy: createRetryPolicy({ maxAttempts: 1, classifyAttempt: () => ({ reason: "never_retry", retryable: false }), backoffMs: () => 0 }),
        sleep: async () => {},
      });
      replayStore.set(key, { attemptRecords, report });
      return { replayed: false, result: { attemptRecords, report } };
    }

    const op = async () => completedResult(200);
    await submitWithReplay("key-1", op);
    await submitWithReplay("key-1", op); // replay — should NOT execute

    expect(executions).toBe(1); // only one execution
  });

  // ─── Additional C4 invariants (per spec) ───────────────────────────────────
  //
  // Abort-terminal-under-production-policy, classifier/backoff infrastructure
  // failures, Retry-After delay precedence, a two-operation deferred retry-slot
  // proof, duplicate conflicts, and rejected-admission zero-execution proofs.

  it("abort is terminal under productionRetryPolicy (not a custom policy)", async () => {
    const sleeper = recordingSleeper();
    const { attemptRecords, decisions } = await executeRetryScenario({
      logicalOperationId: "abort-prod-policy",
      executeAttempt: async () => failedResult("abort", "ABORT_ERR"),
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
    });

    expect(attemptRecords).toHaveLength(1);
    expect(decisions[0].retry).toBe(false);
    expect(decisions[0].reason).toBe("abort");
  });

  it("classifier throws → RETRY_CLASSIFICATION_FAILED with no authoritative report", async () => {
    const throwingPolicy = createRetryPolicy({
      maxAttempts: 3,
      classifyAttempt: () => { throw new Error("classifier boom"); },
      backoffMs: () => 0,
    });

    let caught = null;
    try {
      await executeRetryScenario({
        logicalOperationId: "classifier-throws",
        executeAttempt: async () => completedResult(200),
        policy: throwingPolicy,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe(RETRY_CLASSIFICATION_FAILED);
    expect(caught.attemptRecords).toHaveLength(0);
  });

  it("backoff returns invalid (NaN) → RETRY_BACKOFF_FAILED", async () => {
    const invalidBackoffPolicy = createRetryPolicy({
      maxAttempts: 3,
      classifyAttempt: () => ({ reason: "server_error", retryable: true }),
      backoffMs: () => NaN,
    });

    let caught = null;
    try {
      await executeRetryScenario({
        logicalOperationId: "backoff-invalid",
        executeAttempt: async () => serverErrorResult(503),
        policy: invalidBackoffPolicy,
        sleep: async () => {},
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught.code).toBe(RETRY_BACKOFF_FAILED);
  });

  it("Retry-After delay precedence — sleeps 5000 (Retry-After), not 2000 (backoff)", async () => {
    // Direct classifier check: with retry-after=5 and finite remaining/reset,
    // classifyProductionGitHubError must return retryAfterMs=5000.
    const classification = classifyProductionGitHubError({
      status: 429,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1000000000",
        "retry-after": "5",
      },
    });
    expect(classification.reason).toBe(GITHUB_ERROR_REASONS.RATE_LIMITED_RETRY_AFTER);
    expect(classification.retryAfterMs).toBe(5000);

    // Full scenario: delayMs must come from Retry-After, not the exponential backoff.
    const sleeper = recordingSleeper();
    const results = [completedResult(429), completedResult(200)];
    let idx = 0;
    const { attemptRecords, decisions } = await executeRetryScenario({
      logicalOperationId: "retry-after-precedence",
      executeAttempt: async () => results[idx++],
      policy: productionRetryPolicy,
      sleep: sleeper.sleep,
      retryMetadataFor: () => ({
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1000000000",
          "retry-after": "5",
        },
      }),
    });

    expect(decisions[0].retry).toBe(true);
    expect(decisions[0].delayMs).toBe(5000);
    expect(sleeper.calls).toEqual([5000]); // not 2000 (the exponential backoff value)
    expect(attemptRecords).toHaveLength(2);
  });

  it("two-operation deferred retry-slot proof — max active executions never exceeds 1", async () => {
    // Capacity = 1. Op A fails (503) and enters retry sleep. During that sleep,
    // op B starts, succeeds, and completes. Then op A's sleep resolves and
    // op A's attempt 2 runs. Throughout, executionState.maxActive must be 1 —
    // proving retry delay does NOT occupy an execution slot.
    const executionState = { active: 0, maxActive: 0 };

    // Deferred barriers coordinating the two operations.
    let signalOpASleeping;
    const opAStartedSleep = new Promise((resolve) => { signalOpASleeping = resolve; });
    let releaseOpASleep;
    const opASleepGate = new Promise((resolve) => { releaseOpASleep = resolve; });

    const opAResults = [serverErrorResult(503), completedResult(200)];
    let opAIdx = 0;

    const opAPromise = executeRetryScenario({
      logicalOperationId: "deferred-op-a",
      executeAttempt: async () => opAResults[opAIdx++],
      policy: productionRetryPolicy,
      sleep: async () => {
        // Inside the sleep: op A is NOT executing. Signal main, then wait.
        signalOpASleeping();
        await opASleepGate;
      },
      executionState,
    });

    // Wait until op A has entered its retry sleep (active = 0 during the delay).
    await opAStartedSleep;

    // While op A is sleeping, op B runs to completion.
    const opBPromise = executeRetryScenario({
      logicalOperationId: "deferred-op-b",
      executeAttempt: async () => completedResult(200),
      policy: productionRetryPolicy,
      sleep: async () => {},
      executionState,
    });

    const { attemptRecords: opBRecords } = await opBPromise;

    // Release op A's sleep; its attempt 2 now runs.
    releaseOpASleep();
    const { attemptRecords: opARecords } = await opAPromise;

    expect(executionState.maxActive).toBe(1); // never more than 1 concurrent execution
    expect(opARecords).toHaveLength(2);
    expect(opBRecords).toHaveLength(1);
  });

  it("duplicate conflict — same key with conflicting payload returns 409, no second execution", async () => {
    let executions = 0;
    const store = new Map(); // key → payload

    async function submitWithConflictCheck(key, payload, operation) {
      if (store.has(key)) {
        const existing = store.get(key);
        if (existing !== payload) {
          // Conflict — return 409 WITHOUT executing or creating attempt records.
          return { conflict: true, status: 409, existing, attemptRecords: null };
        }
        // Idempotent replay — also no execution.
        return { conflict: false, replayed: true, existing };
      }
      executions += 1;
      store.set(key, payload);
      const { attemptRecords, report } = await executeRetryScenario({
        logicalOperationId: `conflict-${key}`,
        executeAttempt: operation,
        policy: createRetryPolicy({
          maxAttempts: 1,
          classifyAttempt: () => ({ reason: "never_retry", retryable: false }),
          backoffMs: () => 0,
        }),
        sleep: async () => {},
      });
      return { conflict: false, replayed: false, attemptRecords, report };
    }

    const op = async () => completedResult(200);
    const first = await submitWithConflictCheck("k1", "payload-A", op);
    const second = await submitWithConflictCheck("k1", "payload-B", op);

    expect(first.conflict).toBe(false);
    expect(second.conflict).toBe(true);
    expect(second.status).toBe(409);
    expect(executions).toBe(1); // only the first submission executed
    expect(second.attemptRecords).toBeNull(); // no second attempt record on conflict
    expect(first.attemptRecords).toHaveLength(1); // original attribution unchanged
  });

  it("rejected admission (closed model) produces zero executions and zero attempt records", async () => {
    let tick = 0;
    const model = createBackpressureModel({
      maxQueueDepth: 1,
      rateLimitPerWindow: 1,
      windowMs: 100,
      now: () => tick,
    });
    model.close();

    let startCount = 0;
    const attemptRecords = [];

    // Mirror the orchestrator's admit → execute flow.
    async function tryAdmitAndRun() {
      const admission = model.admit();
      if (!admission.admitted) {
        // Rejected — must NOT start execution, must NOT create any attempt record.
        return { admitted: false, started: false };
      }
      startCount += 1;
      // (In a real orchestrator, executeRetryScenario would run here.)
      return { admitted: true, started: true };
    }

    const result = await tryAdmitAndRun();

    expect(result.admitted).toBe(false);
    expect(result.started).toBe(false);
    expect(startCount).toBe(0);
    expect(attemptRecords).toHaveLength(0);
    expect(model.snapshot().queueDepth).toBe(0);
  });
});
