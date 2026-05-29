// tests/e2e/reconciliation.test.js
// T8: Reconciliation. Validates action lifecycle APIs.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("T8: Reconciliation", function () {
  jest.setTimeout(30000);

  it("API returns action summary with status counts", async function () {
    const res = await apiFetch("/api/actions/summary");
    expect(res.summary).toBeTruthy();
    expect(Array.isArray(res.summary)).toBe(true);
    const succeeded = res.summary.find((s) => s.status === "succeeded");
    expect(succeeded.count).toBeGreaterThan(0);
  });

  it("actions API is paginated", async function () {
    const res = await apiFetch("/api/actions?limit=5");
    const actions = res.data || res;
    expect(Array.isArray(actions)).toBe(true);
  });

  it("single action detail endpoint works", async function () {
    const list = await apiFetch("/api/actions?limit=1");
    const actions = list.data || list;
    if (actions.length > 0) {
      const detail = await apiFetch(`/api/actions/${actions[0].id}`);
      expect(detail).toBeTruthy();
      expect(detail.id || detail.data?.id).toBeTruthy();
    }
  });
});
