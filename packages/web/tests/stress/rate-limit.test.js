// tests/stress/rate-limit.test.js
// Stress Test: Rate limiting — verify 429 responses after hitting the limit.
//
// Uses raw fetch() in a burst (not apiContractedOperation) to preserve
// exact batch size and request count. Wrapped in httpOperation for transport
// classification, with a semantic contract that accepts 200+429 and asserts
// the 429 body contains an error field.

import { describe, it, expect } from "@jest/globals";
import { httpOperation, runContractedBurst } from "./burst-runner.js";
import { BASE_URL, API_KEY } from "../helpers.js";
import { STATUS_SETS } from "./response-contracts.js";

const BURST = 120;

function rateLimitOp() {
  return {
    kind: "rate-limit-probe",
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
  it(`Burst ${BURST} requests — should see both 200 and 429`, async () => {
    const ops = Array.from({ length: BURST }, () => rateLimitOp());
    const result = await runContractedBurst(ops, {
      concurrency: 10, pacing: { mode: "none" },
    });
    console.log(`  ${BURST} requests:`);
    console.log(`    httpExpected:   ${result.httpExpected}`);
    console.log(`    httpUnexpected: ${result.httpUnexpected}`);
    console.log(`    httpNotReceived:${result.httpNotReceived}`);
    console.log(`    200s: ${result.statusCounts[200] || 0}`);
    console.log(`    429s: ${result.statusCounts[429] || 0}`);
    // Both 200 and 429 should appear if the rate limiter is working
    expect(result.httpUnexpected).toBe(0);
    expect(result.httpNotReceived).toBe(0);
    expect(result.statusCounts[200] || 0).toBeGreaterThan(0);
    expect(result.statusCounts[429] || 0).toBeGreaterThan(0);
  });

  it("Rate-limited request includes proper error body", async () => {
    const result = await runContractedBurst([rateLimitOp()], {
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
