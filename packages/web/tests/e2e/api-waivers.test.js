// tests/e2e/api-waivers.test.js
// A8: Waivers API. Tests list, create, check, delete.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A8: Waivers API", function () {
  jest.setTimeout(15000);
  let waiverId;

  afterAll(async function () {
    if (waiverId) {
      try { await apiFetch(`/api/waivers/${waiverId}`, { method: "DELETE" }); } catch (_e) {}
    }
  });

  it("GET /api/waivers returns waiver list for a repo", async function () {
    const res = await apiFetch("/api/waivers?repo=xjeddah/MyShell");
    const waivers = res.data || res;
    expect(Array.isArray(waivers)).toBe(true);
  });

  it("POST /api/waivers creates a waiver", async function () {
    const res = await apiFetch("/api/waivers", {
      method: "POST",
      body: JSON.stringify({
        repo: "xjeddah/MyShell",
        pillar: "triage",
        scope: "issue",
        scopeValue: "999999",
        reason: "e2e test waiver",
        grantedBy: "e2e",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    expect(res).toBeTruthy();
    waiverId = res.id || res.data?.id;
  });

  it("GET /api/waivers/check returns waiver status", async function () {
    const res = await apiFetch("/api/waivers/check?repo=xjeddah/MyShell&pillar=triage&scope=issue&scopeValue=999999");
    expect(res).toBeTruthy();
  });

  it("DELETE /api/waivers/:id removes the waiver", async function () {
    if (waiverId) {
      const res = await apiFetch(`/api/waivers/${waiverId}`, { method: "DELETE" });
      expect(res).toBeTruthy();
      waiverId = null;
    }
  });
});
