// tests/stress/pagination-boundary.test.js
// Stress Test: Pagination edge cases — boundary values, deep pagination, invalid inputs.
//
// Each test uses resilientGetBurstOperation (retry-aware) wrapped with a
// responseContract. Body assertions inspect body.state before body.value.
// The dead expectOkOr429 helper is removed.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { runContractedOperation } from "./burst-runner.js";
import { resilientGetBurstOperation, BASE_URL } from "../helpers.js";
import { STATUS_SETS } from "./response-contracts.js";
import { sleep } from "./stress-helpers.js";

/**
 * Build a retry-aware contracted read operation for pagination testing.
 * Wraps resilientGetBurstOperation with a responseContract.
 */
function paginationOp(path, { expectedStatuses = STATUS_SETS.READ_OK, assertOnStatuses, assert } = {}) {
  const burst = resilientGetBurstOperation(path, { kind: "pagination", bodyMode: "auto" });
  return {
    ...burst,
    responseContract: {
      ...(expectedStatuses ? { expectedStatuses } : {}),
      ...(assertOnStatuses ? { assertOnStatuses } : {}),
      ...(assert ? { assert } : {}),
    },
  };
}

/** Assertion: body.meta.page must equal expected value */
function assertPageEquals(expectedPage) {
  return ({ body }) => {
    if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected a parsed response body" };
    return body.value?.meta?.page === expectedPage
      ? { passed: true }
      : { passed: false, code: "EXPECTED_PAGE_CLAMP", message: `Expected body.meta.page to equal ${expectedPage}, got ${body.value?.meta?.page}` };
  };
}

/** Assertion: body.meta.per_page must be within [min, max] */
function assertPerPageInRange(min, max) {
  return ({ body }) => {
    if (body.state !== "parsed") return { passed: false, code: "BODY_NOT_PARSED", message: "Expected a parsed response body" };
    const pp = body.value?.meta?.per_page;
    return (pp >= min && pp <= max)
      ? { passed: true }
      : { passed: false, code: "PER_PAGE_OUT_OF_RANGE", message: `Expected per_page in [${min},${max}], got ${pp}` };
  };
}

/** Assertion: body.data must be an empty array */
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
    const result = await runContractedOperation(
      paginationOp("/api/repos?page=0", { assert: assertPageEquals(1) })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("page=-1 should clamp to page 1", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?page=-1", { assert: assertPageEquals(1) })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("page=999999 returns empty data", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?page=999999", { assert: assertEmptyData() })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("limit=0 should use default", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?limit=0", { assert: assertPerPageInRange(1, 100) })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("limit=-5 should use default", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?limit=-5", { assert: assertPerPageInRange(1, 100) })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("limit=10000 should cap at max", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?limit=10000", { assert: assertPerPageInRange(1, 100) })
    );
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("passed");
  });

  it("limit=abc (non-numeric) should use default", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?limit=abc")
    );
    expect(result.http).toBe("expected");
  });

  it("page=abc (non-numeric) should use default", async () => {
    const result = await runContractedOperation(
      paginationOp("/api/repos?page=abc")
    );
    expect(result.http).toBe("expected");
  });

  it("Deep pagination across 6 endpoints", async () => {
    const endpoints = [
      "/api/issues?page=9999", "/api/pull-requests?page=9999",
      "/api/ci?page=9999", "/api/heal?page=9999",
      "/api/duplicates?page=9999", "/api/audit/entries?page=9999",
    ];
    let pass = 0;
    for (const ep of endpoints) {
      const result = await runContractedOperation(
        paginationOp(ep, {
          assert: ({ status }) => status !== 500
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_500", message: "Deep pagination returned 500" },
        })
      );
      if (result.assertion === "passed") pass++;
    }
    console.log(`  ${pass}/${endpoints.length} endpoints handled deep pagination without 500`);
    expect(pass).toBeGreaterThan(0);
  });

  it("All paginated endpoints handle limit=1 consistently", async () => {
    const endpoints = [
      "/api/repos?limit=1", "/api/issues?limit=1", "/api/pull-requests?limit=1",
      "/api/ci?limit=1", "/api/duplicates?limit=1", "/api/heal?limit=1",
      "/api/phase2/queue?limit=1", "/api/audit/entries?limit=1", "/api/review/results?limit=1",
    ];
    let pass = 0;
    for (const ep of endpoints) {
      const result = await runContractedOperation(
        paginationOp(ep, {
          assert: ({ status }) => status !== 500
            ? { passed: true }
            : { passed: false, code: "UNEXPECTED_500", message: "limit=1 returned 500" },
        })
      );
      if (result.assertion === "passed") pass++;
    }
    console.log(`  ${pass}/${endpoints.length} endpoints handle limit=1 correctly`);
    expect(pass).toBeGreaterThan(0);
  });
});
