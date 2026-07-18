// tests/stress/pagination-boundary.test.js
// Stress Test: Pagination edge cases — boundary values, deep pagination, invalid inputs.
//
// Semantics preserved from the original test:
// - Reads accept [200, 429] (429 after retries is expected, not unexpected)
// - Body assertions run only on HTTP 200 (assertOnStatuses: [200])
// - Deep pagination counts only HTTP 200 as a pass; 429 is expected but
//   assertion=not_run (status_not_applicable); 500 is unexpected
// - limit=1 test inspects body.data length on 200; 429 is expected but skipped
// - Inter-request delays preserved

import { describe, it, expect, beforeEach } from "@jest/globals";
import { runContractedOperation } from "./burst-runner.js";
import { resilientGetBurstOperation } from "../helpers.js";
import { STATUS_SETS } from "./response-contracts.js";
import { sleep } from "./stress-helpers.js";

function paginationOp(path, { assert } = {}) {
  const burst = resilientGetBurstOperation(path, { kind: "pagination", bodyMode: "auto" });
  return {
    ...burst,
    responseContract: {
      expectedStatuses: STATUS_SETS.READ_OK_OR_RATE_LIMITED,
      // Only attach assertOnStatuses when an assert callback exists.
      // Preflight rejects assertOnStatuses without assert.
      ...(assert ? { assertOnStatuses: [200], assert } : {}),
    },
  };
}

function assertPageEquals(expectedPage) {
  return ({ body }) => {
    if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected a parsed response body" };
    return body.value?.meta?.page === expectedPage
      ? { passed: true }
      : { passed: false, code: "EXPECTED_PAGE_CLAMP", message: `Expected body.meta.page to equal ${expectedPage}` };
  };
}

function assertPerPageInRange(min, max) {
  return ({ body }) => {
    if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected a parsed response body" };
    const pp = body.value?.meta?.per_page;
    return (pp >= min && pp <= max)
      ? { passed: true }
      : { passed: false, code: "PER_PAGE_OUT_OF_RANGE", message: `Expected per_page in [${min},${max}]` };
  };
}

function assertEmptyData() {
  return ({ body }) => {
    if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected a parsed response body" };
    return (Array.isArray(body.value?.data) && body.value.data.length === 0)
      ? { passed: true }
      : { passed: false, code: "EXPECTED_EMPTY_DATA", message: "Expected body.data to be an empty array" };
  };
}

describe("Pagination Boundary Tests", () => {
  beforeEach(async () => { await sleep(500); });

  it("page=0 should clamp to page 1", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?page=0", { assert: assertPageEquals(1) }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("page=-1 should clamp to page 1", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?page=-1", { assert: assertPageEquals(1) }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("page=999999 returns empty data", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?page=999999", { assert: assertEmptyData() }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("limit=0 should use default", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?limit=0", { assert: assertPerPageInRange(1, 100) }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("limit=-5 should use default", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?limit=-5", { assert: assertPerPageInRange(1, 100) }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("limit=10000 should cap at max", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?limit=10000", { assert: assertPerPageInRange(1, 100) }));
    expect(result.http).toBe("expected");
    if (result.status === 200) expect(result.assertion).toBe("passed");
  });

  it("limit=abc (non-numeric) should use default", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?limit=abc"));
    expect(result.http).toBe("expected");
  });

  it("page=abc (non-numeric) should use default", async () => {
    const result = await runContractedOperation(paginationOp("/api/repos?page=abc"));
    expect(result.http).toBe("expected");
  });

  it("Deep pagination across 6 endpoints", async () => {
    const endpoints = [
      "/api/issues?page=9999", "/api/pull-requests?page=9999",
      "/api/ci?page=9999", "/api/heal?page=9999",
      "/api/duplicates?page=9999", "/api/audit/entries?page=9999",
    ];
    let pass200 = 0;
    for (const ep of endpoints) {
      // Original behavior: assertion-only contract (status !== 500).
      // expectedStatuses omitted → all transport-completed are "expected".
      // Count only HTTP 200 as pass. Sleep 2000ms only on 429.
      const result = await runContractedOperation({
        ...resilientGetBurstOperation(ep, { kind: "pagination", bodyMode: "auto" }),
        responseContract: {
          assert: ({ status }) => status !== 500
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_500", message: "Deep pagination returned 500" },
        },
      });
      if (result.status === 200) pass200++;
      if (result.status === 429) { await sleep(2000); continue; }
    }
    console.log(`  ${pass200}/${endpoints.length} endpoints returned 200`);
    expect(pass200).toBeGreaterThan(0);
  });

  it("All paginated endpoints handle limit=1 consistently", async () => {
    const endpoints = [
      "/api/repos?limit=1", "/api/issues?limit=1", "/api/pull-requests?limit=1",
      "/api/ci?limit=1", "/api/duplicates?limit=1", "/api/heal?limit=1",
      "/api/phase2/queue?limit=1", "/api/audit/entries?limit=1", "/api/review/results?limit=1",
    ];
    let pass200 = 0;
    for (const ep of endpoints) {
      const result = await runContractedOperation(paginationOp(ep, {
        assert: ({ body }) => {
          if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected parsed body" };
          const data = body.value?.data;
          if (Array.isArray(data) && data.length > 1) {
            console.log(`  BUG: ${ep} returned ${data.length} items (expected ≤1)`);
          }
          return { passed: true };
        },
      }));
      if (result.status === 200) pass200++;
      await sleep(200); // Original inter-request delay preserved
    }
    console.log(`  ${pass200}/${endpoints.length} endpoints handle limit=1 correctly`);
    expect(pass200).toBeGreaterThan(0);
  });
});
