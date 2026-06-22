// Tests for the executor-service config loader (v0.23.0 Task 2).
//
// The config loader reads env vars and returns a validated, frozen config
// object. It does no I/O. Missing required values are returned as null/empty
// (NOT thrown) so /health can report ready=false rather than crash on boot;
// the loader's job is parsing, not policy.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { loadExecutorServiceConfig } from "../src/config.js";

describe("loadExecutorServiceConfig — env parsing", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    // Strip all executor-service env vars before each test for determinism.
    delete process.env.EXECUTOR_DEPLOYMENT_MODE;
    delete process.env.PORT;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    delete process.env.GITWIRE_EXECUTOR_SERVICE_VERSION;
  });

  afterEach(() => {
    // Restore; simplest correct approach is re-set the keys we touched.
    for (const k of Object.keys(ORIG_ENV)) process.env[k] = ORIG_ENV[k];
  });

  it("returns an object with the documented shape", () => {
    const c = loadExecutorServiceConfig();
    expect(c).toHaveProperty("executor_service_id");
    expect(c).toHaveProperty("executor_service_version");
    expect(c).toHaveProperty("deployment_mode");
    expect(c).toHaveProperty("port");
    expect(c).toHaveProperty("service_token");
    expect(c).toHaveProperty("validator_image_ref");
    expect(c).toHaveProperty("validator_image_digest");
  });

  it("has stable executor_service_id = 'executor-service'", () => {
    expect(loadExecutorServiceConfig().executor_service_id).toBe("executor-service");
  });

  it("defaults deployment_mode to 'compose-local' when env unset", () => {
    expect(loadExecutorServiceConfig().deployment_mode).toBe("compose-local");
  });

  it("honors EXECUTOR_DEPLOYMENT_MODE when set", () => {
    process.env.EXECUTOR_DEPLOYMENT_MODE = "remote";
    expect(loadExecutorServiceConfig().deployment_mode).toBe("remote");
  });

  it("rejects unknown deployment_mode values (fail-closed)", () => {
    process.env.EXECUTOR_DEPLOYMENT_MODE = "magic-cloud";
    // Error mentions the env var name (EXECUTOR_DEPLOYMENT_MODE) — match
    // case-insensitively so the test is robust to the exact wording.
    expect(() => loadExecutorServiceConfig()).toThrow(/DEPLOYMENT_MODE/i);
  });

  it("defaults port to 3003 when PORT unset", () => {
    expect(loadExecutorServiceConfig().port).toBe(3003);
  });

  it("parses PORT as a number", () => {
    process.env.PORT = "4001";
    expect(loadExecutorServiceConfig().port).toBe(4001);
  });

  it("rejects non-numeric PORT (fail-closed)", () => {
    process.env.PORT = "not-a-port";
    expect(() => loadExecutorServiceConfig()).toThrow(/PORT/);
  });

  it("returns service_token=null when token unset (does NOT throw)", () => {
    expect(loadExecutorServiceConfig().service_token).toBeNull();
  });

  it("returns service_token from env when GITWIRE_EXECUTOR_SERVICE_TOKEN set", () => {
    process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN = "secret-token";
    expect(loadExecutorServiceConfig().service_token).toBe("secret-token");
  });
});

describe("loadExecutorServiceConfig — validator image identity", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
  });

  afterEach(() => {
    for (const k of Object.keys(ORIG_ENV)) process.env[k] = ORIG_ENV[k];
  });

  it("returns validator_image_ref=null + digest=null when unconfigured (does NOT throw)", () => {
    const c = loadExecutorServiceConfig();
    expect(c.validator_image_ref).toBeNull();
    expect(c.validator_image_digest).toBeNull();
  });

  it("reads validator_image_ref + validator_image_digest from env", () => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "registry.example.com/v@sha256:" + "a".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "a".repeat(64);
    const c = loadExecutorServiceConfig();
    expect(c.validator_image_ref).toContain("sha256:");
    expect(c.validator_image_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("loadExecutorServiceConfig — frozen + derived helpers", () => {
  it("the returned config is frozen", () => {
    const c = loadExecutorServiceConfig();
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("exposes a validatorIdentityComplete() helper on the config", () => {
    const c = loadExecutorServiceConfig();
    expect(typeof c.validatorIdentityComplete).toBe("function");
  });

  it("validatorIdentityComplete() is false when either ref or digest is missing", () => {
    delete process.env.GITWIRE_VALIDATOR_IMAGE_REF;
    delete process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST;
    const c = loadExecutorServiceConfig();
    expect(c.validatorIdentityComplete()).toBe(false);
  });

  it("validatorIdentityComplete() is true only when both ref AND digest are set", () => {
    process.env.GITWIRE_VALIDATOR_IMAGE_REF = "registry.example.com/v@sha256:" + "b".repeat(64);
    process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST = "sha256:" + "b".repeat(64);
    const c = loadExecutorServiceConfig();
    expect(c.validatorIdentityComplete()).toBe(true);
  });
});
