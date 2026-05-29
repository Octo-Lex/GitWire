// tests/e2e/api-transfers.test.js
// A7: Repo Reconciliation / Transfers API.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A7: Transfers API", function () {
  jest.setTimeout(15000);

  it("GET /api/repos/reconcile returns reconcile list", async function () {
    const res = await apiFetch("/api/repos/reconcile");
    expect(res).toBeTruthy();
    const repos = res.data || res;
    expect(Array.isArray(repos)).toBe(true);
  });
});
