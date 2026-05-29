// tests/e2e/api-config.test.js
// A9: Config API. Tests resolved config with provenance metadata.

import { jest } from "@jest/globals";
import { apiFetch } from "./helpers.js";

describe("A9: Config API", function () {
  jest.setTimeout(15000);

  it("GET /api/config/:owner/:repo returns resolved config", async function () {
    const res = await apiFetch("/api/config/xjeddah/MyShell");
    expect(res.config).toBeTruthy();
    expect(res.config._meta).toBeTruthy();
    expect(res.config._meta.layers).toBeTruthy();
  });

  it("unconfigured repo config has no repo/org layers", async function () {
    const res = await apiFetch("/api/config/Elephant-Rock-Lab/Super-Browser");
    expect(res.config._meta.layers.repo).toBe(false);
    expect(res.config._meta.layers.org).toBe(false);
  });

  it("config includes quality_gates", async function () {
    const res = await apiFetch("/api/config/xjeddah/MyShell");
    expect(res.config.quality_gates).toBeTruthy();
  });
});
