// tests/unit/plugin-gate-containment.test.js
// #425 isolation contract, app side. Repository plugin loading and playground
// plugin execution are operator-gated and default-off; when enabled, the
// COMPLETE plugin-dependent evaluation is delegated to the executor's
// disposable sandbox — the app never executes plugin code (there is no
// loadPlugins import in packages/web at all, asserted statically below).
// Sandbox failure is fail-closed everywhere.

import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Controllable sandbox client (per test) ──────────────────────────────────
const sandbox = { report: null, error: null, calls: [] };

jest.unstable_mockModule("../../src/lib/pluginSandboxClient.js", () => ({
  PluginEvaluationError: class PluginEvaluationError extends Error {
    constructor(reason, detail) { super(`Plugin evaluation failed (${reason}): ${detail}`); this.reason = reason; }
  },
  evaluateViaPluginSandbox: async (payload) => {
    sandbox.calls.push(payload);
    if (sandbox.error) throw sandbox.error;
    return sandbox.report;
  },
}));

// ── customRulesService scaffolding (modeled on custom-rules-integrity) ─────
const mockEvaluateRules = jest.fn(() => []);
const mockGetConfigForRepo = jest.fn(async () => ({
  settings: { dry_run: true },
  custom_rules: { "rule-one": { when: "true", actions: [] } },
}));
const mockGetPluginsForRepo = jest.fn(async () => [
  { source: "module.exports = { evil: () => 1 }", filename: "evil.js" },
]);
const mockGetInstallationClient = jest.fn(async () => ({}));
const mockLogDecision = jest.fn(async () => ({}));

jest.unstable_mockModule("@gitwire/rules", () => ({
  evaluateRules: mockEvaluateRules,
  DEFAULT_CONFIG: {},
  validateConfig: jest.fn(() => ({ valid: true })),
}));
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
jest.unstable_mockModule("@gitwire/rules/expr", () => ({
  evaluateExpr: jest.fn(() => ({ value: true })),
  evaluateExprWithTrace: jest.fn(() => ({ value: true, trace: [] })),
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
  sandbox.report = { overall: "pass", evaluation_ok: true, result: [], evaluation_error: null };
  sandbox.error = null;
  sandbox.calls = [];
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

  it("both gates accept explicit operator opt-in (case-insensitive), independently", () => {
    for (const v of ["true", "1", "YES", "True"]) {
      expect(repoPluginsEnabled({ GITWIRE_ENABLE_REPO_PLUGINS: v })).toBe(true);
      expect(playgroundPluginsEnabled({ GITWIRE_ENABLE_PLAYGROUND_PLUGINS: v })).toBe(true);
    }
    const half = { GITWIRE_ENABLE_REPO_PLUGINS: "true" };
    expect(repoPluginsEnabled(half)).toBe(true);
    expect(playgroundPluginsEnabled(half)).toBe(false);
  });
});

describe("the app has no in-process plugin execution path (#425 structural)", () => {
  it("packages/web/src contains no loadPlugins import or @gitwire/rules/plugins reference", () => {
    const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("@gitwire/rules/plugins") || /\bloadPlugins\s*\(/.test(text)) {
            offenders.push(path.relative(srcRoot, full));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("repository rule evaluation (#425)", () => {
  it("default-off: plugin sources are never fetched; rules evaluate locally without plugins", async () => {
    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 });
    expect(result).toEqual([]);
    expect(mockGetPluginsForRepo).not.toHaveBeenCalled();
    expect(sandbox.calls.length).toBe(0);
    expect(mockEvaluateRules).toHaveBeenCalledWith(expect.anything(), expect.anything(), {});
  });

  it("operator opt-in: the whole evaluation is delegated to the sandbox with the plugin sources", async () => {
    process.env.GITWIRE_ENABLE_REPO_PLUGINS = "true";
    sandbox.report = { overall: "pass", evaluation_ok: true, result: [], evaluation_error: null };
    await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 });
    expect(mockGetPluginsForRepo).toHaveBeenCalledWith("acme/widgets");
    expect(sandbox.calls.length).toBe(1);
    expect(sandbox.calls[0].kind).toBe("custom_rules");
    expect(sandbox.calls[0].plugin_sources).toEqual([{ source: expect.any(String), filename: "evil.js" }]);
    // Local in-process evaluation never ran in the enabled path.
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("sandbox failure is fail-closed: the typed error propagates, never a silent continue", async () => {
    process.env.GITWIRE_ENABLE_REPO_PLUGINS = "true";
    sandbox.error = Object.assign(new Error("Plugin evaluation failed (executor_unreachable): sandbox down"), { name: "PluginEvaluationError", reason: "executor_unreachable" });
    await expect(evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 })).rejects.toThrow(/executor_unreachable/);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("evaluation error inside the sandbox is also fail-closed", async () => {
    process.env.GITWIRE_ENABLE_REPO_PLUGINS = "true";
    sandbox.report = { overall: "pass", evaluation_ok: false, result: null, evaluation_error: "plugin exploded" };
    await expect(evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 })).rejects.toThrow(/plugin exploded/);
  });
});

describe("playground (#425)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter);

  const pluginBody = {
    expression: "true",
    context: {},
    plugins: [{ source: "module.exports = { benign: () => 2 + 2 }", filename: "benign-probe.js" }],
  };

  it("default-off: 400 with the operator-containment message; the sandbox is never called", async () => {
    const res = await supertest(app).post("/api/config/playground").send(pluginBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disabled on this deployment/i);
    expect(sandbox.calls.length).toBe(0);
  });

  it("operator opt-in: evaluation is delegated and the serialized result returned", async () => {
    process.env.GITWIRE_ENABLE_PLAYGROUND_PLUGINS = "true";
    sandbox.report = { overall: "pass", evaluation_ok: true, result: { value: 4, trace: [] }, evaluation_error: null };
    const res = await supertest(app).post("/api/config/playground").send(pluginBody);
    expect(res.status).toBe(200);
    expect(res.body.evaluatedIn).toBe("plugin-sandbox");
    expect(res.body.result).toEqual({ value: 4, trace: [] });
    expect(sandbox.calls[0].kind).toBe("playground");
  });

  it("sandbox failure is a typed 502, never a local fallback", async () => {
    process.env.GITWIRE_ENABLE_PLAYGROUND_PLUGINS = "true";
    sandbox.error = Object.assign(new Error("unreachable"), { name: "PluginEvaluationError", reason: "executor_unreachable" });
    const res = await supertest(app).post("/api/config/playground").send(pluginBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/executor_unreachable/);
  });

  it("requests without plugins still evaluate locally (no untrusted code involved)", async () => {
    const res = await supertest(app).post("/api/config/playground").send({ expression: "true", context: {} });
    expect(res.status).toBe(200);
    expect(sandbox.calls.length).toBe(0);
  });
});
