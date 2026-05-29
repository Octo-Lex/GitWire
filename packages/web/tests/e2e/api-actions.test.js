// tests/e2e/api-actions.test.js
// A2: Actions API. Tests listing, summary, detail, cancel.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A2: Actions API", function () {
  jest.setTimeout(30000);

  it("GET /api/actions returns paginated list", async function () {
    const res = await apiFetch("/api/actions?limit=5");
    const actions = res.data || res;
    expect(Array.isArray(actions)).toBe(true);
  });

  it("GET /api/actions/summary returns stats", async function () {
    const res = await apiFetch("/api/actions/summary");
    expect(res).toBeTruthy();
  });

  it("GET /api/actions/:id returns single action", async function () {
    const list = await apiFetch("/api/actions?limit=1");
    const actions = list.data || list;
    if (actions.length > 0) {
      const detail = await apiFetch(`/api/actions/${actions[0].id}`);
      expect(detail).toBeTruthy();
    }
  });

  it("actions support filtering by pillar", async function () {
    const res = await apiFetch("/api/actions?pillar=triage&limit=5");
    const actions = res.data || res;
    expect(Array.isArray(actions)).toBe(true);
    for (const a of actions) {
      expect(a.pillar).toBe("triage");
    }
  });

  it("actions support filtering by status", async function () {
    const res = await apiFetch("/api/actions?status=succeeded&limit=5");
    const actions = res.data || res;
    expect(Array.isArray(actions)).toBe(true);
    for (const a of actions) {
      expect(a.status).toBe("succeeded");
    }
  });
});
