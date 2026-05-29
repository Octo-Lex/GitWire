// tests/e2e/maintainer.test.js
// T6+T7: Maintainer — validates settings and action APIs.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("T6+T7: Maintainer", function () {
  jest.setTimeout(30000);

  it("maintainer settings API returns data", async function () {
    const res = await apiFetch("/api/maintainer/xjeddah/MyShell/settings");
    expect(res).toBeTruthy();
  });

  it("maintainer actions API returns data", async function () {
    const res = await apiFetch("/api/maintainer/xjeddah/MyShell/actions?limit=10");
    const actions = res.actions || res.data || res;
    expect(Array.isArray(actions)).toBe(true);
  });

  it("maintainer stats API returns data", async function () {
    const res = await apiFetch("/api/maintainer/xjeddah/MyShell/stats");
    expect(res).toBeTruthy();
  });
});
