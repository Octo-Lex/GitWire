// Verifies the Zod config exposes a `validator` group (Gap 1.2).

import { describe, it, expect } from "@jest/globals";

describe("config.validator group", () => {
  it("is present on the config export", async () => {
    // config/index.js validates at import time — must have valid env for boot.
    // Provide minimal required vars so the schema parses.
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/db";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    const { config } = await import("../../config/index.js");
    expect(config).toHaveProperty("validator");
  });

  it("exposes ref, digest, allowTestFixture, executorBackend", async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://u:p@localhost:5432/db";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    const { config } = await import("../../config/index.js");
    expect(config.validator).toHaveProperty("ref");
    expect(config.validator).toHaveProperty("digest");
    expect(config.validator).toHaveProperty("allowTestFixture");
    expect(config.validator).toHaveProperty("executorBackend");
  });
});
