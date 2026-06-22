// Tests for the executorService config group (v0.23.0 Task 3, step 5).
//
// NOTE on module-cache handling: config/index.js reads process.env at module
// load and freezes the result. Within a single jest worker the module is
// cached after first import, so tests that vary env vars must reset the
// module registry first (jest.resetModules + dynamic import). This mirrors
// the pattern other env-dependent config tests would need if they asserted
// on env-set values, not just structure.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

async function loadConfigFresh() {
  jest.resetModules();
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/db";
  process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
  const mod = await import("../../config/index.js");
  return mod.config;
}

describe("config.executorService group", () => {
  beforeEach(() => {
    delete process.env.GITWIRE_EXECUTOR_SERVICE_URL;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
  });

  it("is present on the config export", async () => {
    const config = await loadConfigFresh();
    expect(config).toHaveProperty("executorService");
  });

  it("exposes url + token", async () => {
    const config = await loadConfigFresh();
    expect(config.executorService).toHaveProperty("url");
    expect(config.executorService).toHaveProperty("token");
  });

  it("defaults url + token to null when env unset (not a boot error)", async () => {
    const config = await loadConfigFresh();
    expect(config.executorService.url).toBeNull();
    expect(config.executorService.token).toBeNull();
  });

  it("reads GITWIRE_EXECUTOR_SERVICE_URL + _TOKEN from env", async () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_URL = "http://executor:3003";
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "shared-secret";
    const config = await loadConfigFresh();
    expect(config.executorService.url).toBe("http://executor:3003");
    expect(config.executorService.token).toBe("shared-secret");
  });
});
