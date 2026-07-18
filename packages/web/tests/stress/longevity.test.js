// tests/stress/longevity.test.js
// Stress Test: Longevity — sustained load over multiple rounds to detect memory leaks.
//
// Semantics preserved from the original test:
// - Rounds with all-200 are counted for degradation
// - Rounds with non-200 results must NOT contain 500s
// - Transport failures are failures (not ordinary degraded rounds)
// - Degradation calculation unchanged

import { describe, it, expect } from "@jest/globals";
import { runContractedOperation } from "./burst-runner.js";
import { apiContractedOperation, STATUS_SETS } from "./response-contracts.js";
import { httpOperation } from "./burst-runner.js";
import { BASE_URL } from "../helpers.js";
import { sleep } from "./stress-helpers.js";

const ROUNDS = 10;
const REQUESTS_PER_ROUND = 5;

describe(`Longevity: ${ROUNDS} rounds × ${REQUESTS_PER_ROUND} requests`, () => {
  const roundTimes = [];

  it("Sustained read load stays stable", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const start = Date.now();
      const statuses = [];
      let allOk = true;
      for (let i = 0; i < REQUESTS_PER_ROUND; i++) {
        const result = await runContractedOperation(
          apiContractedOperation("/api/repos", {
            kind: "read", method: "GET", bodyMode: "auto",
            expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
          })
        );
        // Transport failure is a hard failure, not a degraded round.
        if (result.transport === "failed") {
          throw new Error(`Transport failure in round ${round}: ${result.error?.category}`);
        }
        statuses.push(result.status);
        if (result.status !== 200) allOk = false;
        await sleep(100);
      }
      const elapsed = Date.now() - start;
      roundTimes.push(elapsed);

      if (!allOk) {
        // Original behavior: assert every non-200 response is NOT 500.
        for (const s of statuses) {
          expect(s).not.toBe(500);
        }
        await sleep(200);
        continue;
      }
      await sleep(200);
    }

    const first3Avg = roundTimes.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const last3Avg = roundTimes.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const degradation = last3Avg / first3Avg;

    console.log(`  Round times: ${roundTimes.map(t => t + "ms").join(", ")}`);
    console.log(`  Early avg: ${first3Avg.toFixed(0)}ms, Late avg: ${last3Avg.toFixed(0)}ms, Degradation: ${degradation.toFixed(2)}x`);
    expect(degradation).toBeLessThan(3);
  });

  it("Sustained mixed-endpoint load stays stable", async () => {
    const endpoints = [
      "/api/repos", "/api/issues", "/api/ci/stats", "/api/insights/overview",
      "/api/duplicates/stats", "/api/heal/stats", "/api/maintainer/members",
      "/api/enforcement/stats", "/api/phase2/telemetry/summary", "/api/review/stats",
    ];
    const roundTimes2 = [];

    for (let round = 0; round < ROUNDS; round++) {
      const start = Date.now();
      for (const ep of endpoints) {
        const result = await runContractedOperation(
          apiContractedOperation(ep, {
            kind: "read", method: "GET", bodyMode: "auto",
            expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
          })
        );
        if (result.transport === "failed") {
          throw new Error(`Transport failure at ${ep}: ${result.error?.category}`);
        }
        if (result.status === 500) {
          throw new Error(`${ep} returned 500`);
        }
        await sleep(50);
      }
      const elapsed = Date.now() - start;
      roundTimes2.push(elapsed);
    }

    const first3Avg = roundTimes2.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const last3Avg = roundTimes2.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const degradation = last3Avg / first3Avg;

    console.log(`  Mixed times: ${roundTimes2.map(t => t + "ms").join(", ")}`);
    console.log(`  Early avg: ${first3Avg.toFixed(0)}ms, Late avg: ${last3Avg.toFixed(0)}ms, Degradation: ${degradation.toFixed(2)}x`);
    expect(degradation).toBeLessThan(3);
  });

  it("Health check remains stable throughout", async () => {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const result = await runContractedOperation({
        kind: "health", method: "GET",
        run: () => httpOperation({
          method: "GET", bodyMode: "none",
          execute: () => fetch(`${BASE_URL}/health`),
        }),
        responseContract: { expectedStatuses: STATUS_SETS.READ_OK },
      });
      times.push(result.durationMs);
      expect(result.http).toBe("expected");
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    console.log(`  Health x20: avg=${avg.toFixed(0)}ms, max=${max}ms`);
    expect(max).toBeLessThan(5000);
  });
});
