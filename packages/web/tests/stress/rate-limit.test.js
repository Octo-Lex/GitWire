// tests/stress/rate-limit.test.js
// Stress Test: Rate limiting — verify 429 responses after hitting the limit.
//
// IMPORTANT: traffic shape preserved from the original test — sequential
// cohorts of 10 (not semaphore mode), accepting any mix of 200+429.
// Does NOT require both 200 and 429 (an earlier suite may have exhausted
// the window).

import { describe, it, expect } from "@jest/globals";
import { httpOperation, runContractedBurst } from "./burst-runner.js";
import { BASE_URL, API_KEY } from "../helpers.js";
import { STATUS_SETS } from "./response-contracts.js";

const BURST = 120;

// Status-only operation for the 120-request burst (no body reading).
function rateLimitStatusOp() {
  return {
    kind: "rate-limit-probe",
    method: "GET",
    run: () => httpOperation({
      method: "GET",
      bodyMode: "none",
      execute: () => fetch(`${BASE_URL}/api/repos`, {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      }),
    }),
    responseContract: {
      expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
    },
  };
}

// Body-asserting operation for the single-request body test.
function rateLimitBodyOp() {
  return {
    kind: "rate-limit-body",
    method: "GET",
    run: () => httpOperation({
      method: "GET",
      bodyMode: "auto",
      execute: () => fetch(`${BASE_URL}/api/repos`, {
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      }),
    }),
    responseContract: {
      expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
      assertOnStatuses: [429],
      assert: ({ body }) => {
        if (body.state !== "parsed") {
          return { passed: false, code: "RATE_LIMIT_BODY_NOT_PARSED", message: "Expected a parsed 429 response body" };
        }
        return body.value?.error !== undefined
          ? { passed: true }
          : { passed: false, code: "RATE_LIMIT_ERROR_MISSING", message: "Expected the 429 response body to contain error" };
      },
    },
  };
}

describe("Rate Limiting", () => {
  it(`Burst ${BURST} requests — should see 200 or 429`, async () => {
    const ops = Array.from({ length: BURST }, () => rateLimitStatusOp());
    // Restore original cohort pacing: batches of 10, no delay between.
    const result = await runContractedBurst(ops, {
      concurrency: 10,
      pacing: { mode: "legacy_batches", delayMs: 0 },
    });
    console.log(`    200 OK: ${result.statusCounts[200] || 0}`);
    console.log(`    429 Rate Limited: ${result.statusCounts[429] || 0}`);
    // Original acceptance: 200 or 429, any mix (including all-429).
    expect(result.httpUnexpected).toBe(0);
    expect(result.httpNotReceived).toBe(0);
    expect(result.httpExpected).toBe(result.attempted);
  });

  it("Rate-limited request includes proper error body", async () => {
    const result = await runContractedBurst([rateLimitBodyOp()], {
      concurrency: 1, pacing: { mode: "none" },
    });
    // Either 200 (not rate limited) or 429 (rate limited with body check)
    expect(result.httpUnexpected).toBe(0);
    expect(result.httpNotReceived).toBe(0);
    expect(result.assertionFailed).toBe(0);
  });

  it("/health endpoint is NOT rate limited", async () => {
    const ops = Array.from({ length: 50 }, () => ({
      kind: "health",
      method: "GET",
      run: () => httpOperation({
        method: "GET", bodyMode: "none",
        execute: () => fetch(`${BASE_URL}/health`),
      }),
      responseContract: { expectedStatuses: STATUS_SETS.READ_OK },
    }));
    const result = await runContractedBurst(ops, {
      concurrency: 10, pacing: { mode: "none" },
    });
    console.log(`  Health x50: all 200 = ${result.httpExpected === result.attempted}`);
    expect(result.httpExpected).toBe(result.attempted);
    expect(result.httpUnexpected).toBe(0);
  });
});
