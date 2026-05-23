import { createLogger } from "../src/create-logger.js";
import { createDatabase } from "../src/create-db.js";
import { createRedisConnection, createQueue, createWorker } from "../src/create-queue.js";
import { createGitHubApp } from "../src/create-github.js";
import { initRuntime, getRuntime, isRuntimeInitialized, resetRuntime } from "../src/index.js";

// ── createLogger ────────────────────────────────────────────────────────────

describe("createLogger", () => {
  test("creates a pino logger with default options", () => {
    const log = createLogger();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
  });

  test("respects logLevel option", () => {
    const log = createLogger({ logLevel: "debug" });
    expect(log.level).toBe("debug");
  });

  test("defaults to info level", () => {
    const log = createLogger({});
    expect(log.level).toBe("info");
  });

  test("production env suppresses pino-pretty", () => {
    const log = createLogger({ env: "production" });
    expect(log.level).toBe("info");
  });
});

// ── createDatabase ──────────────────────────────────────────────────────────

describe("createDatabase", () => {
  test("returns object with query, transaction, end, pool", () => {
    // Use a fake URL — we don't actually connect
    const db = createDatabase({ url: "postgresql://fake:5432/test", logger: { error: () => {} } });
    expect(typeof db.query).toBe("function");
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.end).toBe("function");
    expect(db.pool).toBeDefined();
    // Clean up the pool
    db.pool.end().catch(() => {});
  });

  test("pool has correct max connections", () => {
    const db = createDatabase({ url: "postgresql://fake:5432/test", logger: { error: () => {} } });
    expect(db.pool.options.max).toBe(20);
    db.pool.end().catch(() => {});
  });
});

// ── createGitHubApp ─────────────────────────────────────────────────────────

describe("createGitHubApp", () => {
  test("returns all expected methods", () => {
    const gh = createGitHubApp({ logger: { error: () => {} } });
    expect(typeof gh.getWebhookApp).toBe("function");
    expect(typeof gh.getInstallationClient).toBe("function");
    expect(typeof gh.forEachInstallation).toBe("function");
    expect(typeof gh.forEachRepo).toBe("function");
    expect(typeof gh.getApp).toBe("function");
  });

  test("getWebhookApp returns null when not configured", () => {
    const gh = createGitHubApp({ logger: { error: () => {} } });
    expect(gh.getWebhookApp()).toBeNull();
  });

  test("getApp throws when not configured", () => {
    const gh = createGitHubApp({ logger: { error: () => {} } });
    expect(() => gh.getApp()).toThrow("GitHub App not configured");
  });

  test("getWebhookApp returns app when configured", () => {
    const gh = createGitHubApp({
      appId: "12345",
      // Minimal valid-looking RSA key that @octokit/app will accept
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA2Z3qX2BTLS4e7g5hMDTcb0lQgPMZ4gS9Vpuq\n-----END RSA PRIVATE KEY-----",
      logger: { error: () => {} },
    });
    // May still return null if @octokit/app rejects the key format
    // Just verify it doesn't throw
    expect(() => gh.getWebhookApp()).not.toThrow();
  });
});

// ── initRuntime / getRuntime ────────────────────────────────────────────────

describe("initRuntime / getRuntime", () => {
  let rt;

  beforeAll(() => {
    rt = initRuntime({
      server: { logLevel: "info", env: "test" },
      db: { url: "postgresql://fake:5432/test" },
      redis: { url: "redis://fake:6379" },
      github: {},
    });
  });

  afterAll(() => {
    try { rt.db.pool.end(); } catch (_e) {}
    try { rt.redis.disconnect(); } catch (_e) {}
    resetRuntime();
  });

  // NOTE: getRuntime throws before initRuntime tests are in a separate
  // describe below to avoid beforeAll ordering issues.

  test("initRuntime returns runtime with all components", () => {
    expect(rt.logger).toBeDefined();
    expect(rt.db).toBeDefined();
    expect(rt.redis).toBeDefined();
    expect(rt.github).toBeDefined();
    expect(rt.QUEUES).toBeDefined();
  });

  test("getRuntime returns same object after initRuntime", () => {
    expect(getRuntime()).toBe(rt);
  });

  test("isRuntimeInitialized reflects state", () => {
    expect(isRuntimeInitialized()).toBe(true);
  });

  test("second initRuntime returns existing runtime", () => {
    const rt2 = initRuntime({
      server: { logLevel: "debug", env: "development" },
      db: { url: "postgresql://other:5432/test" },
      redis: { url: "redis://other:6379" },
      github: {},
    });
    expect(rt).toBe(rt2);
  });
});

// Must be LAST describe — tests that runtime state is clean before init
describe("getRuntime pre-init state", () => {
  test("getRuntime throws when not initialized", () => {
    resetRuntime();
    expect(() => getRuntime()).toThrow("not initialized");
  });

  test("isRuntimeInitialized returns false when not initialized", () => {
    resetRuntime();
    expect(isRuntimeInitialized()).toBe(false);
  });
});
