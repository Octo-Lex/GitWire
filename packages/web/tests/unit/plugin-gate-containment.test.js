// tests/unit/plugin-gate-containment.test.js
// #425 containment contract for CodeQL alert #12: repository plugin loading
// and playground plugin execution are operator-gated and default-off until
// the process isolation boundary replaces in-process execution. The gate must
// close BEFORE plugin sources are fetched or treated as loadable content.

import { jest } from "@jest/globals";

// ── Gate control via the real environment (the w2-04 pattern: env mutations
// in this test file ARE visible to modules under test in this jest setup) ──

// ── customRulesService scaffolding (modeled on custom-rules-integrity) ─────
const mockEvaluateRules = jest.fn(() => []);
const mockLoadPlugins = jest.fn(() => ({}));
const mockGetConfigForRepo = jest.fn(async () => ({
  settings: { dry_run: true },
  custom_rules: { "rule-one": { when: "true", actions: [] } },
}));
const mockGetPluginsForRepo = jest.fn(async () => [
  { source: "module.exports = { evil: () => 1 }", filename: "evil.js" },
]);
const mockGetInstallationClient = jest.fn(async () => ({}));
const mockLogDecision = jest.fn(async () => ({}));

jest.unstable_mockModule("@gitwire/rules", () => ({ evaluateRules: mockEvaluateRules }));
jest.unstable_mockModule("@gitwire/rules/plugins", () => ({ loadPlugins: mockLoadPlugins }));
jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
  getPluginsForRepo: mockGetPluginsForRepo,
  getConfigOverrides: jest.fn(async () => ({})),
  setConfigOverrides: jest.fn(async () => ({})),
  deleteConfigOverrides: jest.fn(async () => ({})),
  getConfigHistory: jest.fn(async () => ({ rows: [] })),
  restoreConfigVersion: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: mockGetInstallationClient,
}));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: jest.fn((_c, opts) => (opts?.skipCache ? { request: jest.fn() } : { request: jest.fn() })),
}));
jest.unstable_mockModule("../../src/services/decisionLogService.js", () => ({
  logDecision: mockLogDecision,
}));
jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: jest.fn(async () => ({})),
  approve: jest.fn(async () => ({})),
  execute: jest.fn(async () => ({})),
  succeed: jest.fn(async () => ({})),
  fail: jest.fn(async () => ({})),
  block: jest.fn(async () => ({})),
  BLOCKED_REASONS: { POLICY_DENIED: "policy_denied" },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── configRouter scaffolding (playground route) ─────────────────────────────
jest.unstable_mockModule("@gitwire/rules/expr", () => ({
  evaluateExpr: jest.fn(() => ({ value: true, trace: [] })),
  evaluateExprWithTrace: jest.fn(() => ({ value: true, trace: [] })),
}));
jest.unstable_mockModule("@gitwire/rules", () => ({
  evaluateRules: mockEvaluateRules,
  DEFAULT_CONFIG: {},
  validateConfig: jest.fn(() => ({ valid: true })),
}));
jest.unstable_mockModule("../../src/services/policyValidationService.js", () => ({
  validatePolicy: jest.fn(async () => ({ ok: true })),
}));
jest.unstable_mockModule("../../src/services/policySimulationService.js", () => ({
  simulatePolicy: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../src/services/policyDiffService.js", () => ({
  diffPolicyImpact: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../src/services/policyRecommendationService.js", () => ({
  recommendGuardrails: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.unstable_mockModule("../../src/services/auth/observeAdopt.js", () => ({
  observeAuthorize: jest.fn(async () => ({})),
}));
jest.unstable_mockModule("../../src/middleware/directPolicyWriteGuard.js", () => ({
  directPolicyWriteGuard: (_req, _res, next) => next(),
}));

const { repoPluginsEnabled, playgroundPluginsEnabled } = await import("../../src/lib/pluginGate.js");
const { evaluateAndExecuteCustomRules } = await import("../../src/services/customRulesService.js");
const { configRouter } = await import("../../src/routes/config.js");


const supertest = (await import("supertest")).default;
const express = (await import("express")).default;

function issuePayload() {
  return {
    action: "opened",
    repository: { id: 99, full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
    installation: { id: 7 },
    issue: { number: 11, title: "Issue", body: "Body", user: { login: "alice" }, labels: [] },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GITWIRE_ENABLE_REPO_PLUGINS;
  delete process.env.GITWIRE_ENABLE_PLAYGROUND_PLUGINS;
  mockEvaluateRules.mockReturnValue([]);
});

describe("plugin authorization gate — pure truth table (#425)", () => {
  it("both gates are default-off for unset, empty, and false-y values", () => {
    for (const env of [
      {},
      { GITWIRE_ENABLE_REPO_PLUGINS: "" },
      { GITWIRE_ENABLE_REPO_PLUGINS: "0" },
      { GITWIRE_ENABLE_REPO_PLUGINS: "false" },
    ]) {
      expect(repoPluginsEnabled(env)).toBe(false);
    }
    for (const env of [
      {},
      { GITWIRE_ENABLE_PLAYGROUND_PLUGINS: "no" },
      { GITWIRE_ENABLE_PLAYGROUND_PLUGINS: "FALSE" },
    ]) {
      expect(playgroundPluginsEnabled(env)).toBe(false);
    }
  });

  it("both gates accept explicit operator opt-in (case-insensitive)", () => {
    for (const v of ["true", "1", "YES", "True"]) {
      expect(repoPluginsEnabled({ GITWIRE_ENABLE_REPO_PLUGINS: v })).toBe(true);
      expect(playgroundPluginsEnabled({ GITWIRE_ENABLE_PLAYGROUND_PLUGINS: v })).toBe(true);
    }
  });

  it("the two gates are independent", () => {
    const env = { GITWIRE_ENABLE_REPO_PLUGINS: "true" };
    expect(repoPluginsEnabled(env)).toBe(true);
    expect(playgroundPluginsEnabled(env)).toBe(false);
  });
});

describe("repository plugin loading is contained before fetch or execution (#425)", () => {
  it("default-off: plugin sources are never fetched and loadPlugins is never called", async () => {
    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 });
    expect(result).toEqual([]);
    expect(mockGetPluginsForRepo).not.toHaveBeenCalled();
    expect(mockLoadPlugins).not.toHaveBeenCalled();
    // Rule evaluation still ran, with empty plugin filters.
    expect(mockEvaluateRules).toHaveBeenCalledWith(expect.anything(), expect.anything(), {});
  });

  it("operator opt-in: fetching and loading proceed unchanged", async () => {
    process.env.GITWIRE_ENABLE_REPO_PLUGINS = "true";
    await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 });
    expect(mockGetPluginsForRepo).toHaveBeenCalledWith("acme/widgets");
    expect(mockLoadPlugins).toHaveBeenCalledTimes(1);
  });
});

describe("playground plugin execution is rejected unless the operator opted in (#425)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter);

  const pluginBody = {
    expression: "true",
    context: {},
    plugins: [{ source: "module.exports = { evil: () => 1 }", filename: "evil.js" }],
  };

  it("default-off: 400 with an explicit operator-containment message, loader untouched", async () => {
    const res = await supertest(app).post("/api/config/playground").send(pluginBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disabled on this deployment/i);
    expect(mockLoadPlugins).not.toHaveBeenCalled();
  });

  it("operator opt-in: the request proceeds to plugin loading", async () => {
    process.env.GITWIRE_ENABLE_PLAYGROUND_PLUGINS = "true";
    const res = await supertest(app).post("/api/config/playground").send(pluginBody);
    expect(res.status).not.toBe(400);
    expect(mockLoadPlugins).toHaveBeenCalledTimes(1);
  });

  it("requests without plugins are unaffected by the gate", async () => {
    const res = await supertest(app).post("/api/config/playground").send({ expression: "true", context: {} });
    expect(res.status).toBe(200);
    expect(mockLoadPlugins).not.toHaveBeenCalled();
  });
});
