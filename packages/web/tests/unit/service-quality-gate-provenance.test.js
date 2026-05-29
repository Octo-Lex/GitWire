// tests/unit/service-quality-gate-provenance.test.js
// Unit tests verifying that evaluateGatesForRepo respects config provenance.
//
// The quality gate service must only evaluate gates when the repo has opted in:
//   - DB gates (explicitly created via dashboard)
//   - Config file gates (user wrote quality_gates in .gitwire.yml)
//   - DEFAULT_CONFIG gates must NEVER trigger evaluation
//
// This contract depends on two provenance signals:
//   - config._explicitKeys: set by parseConfig() in @gitwire/rules
//   - config._meta.layers: set by configService.js

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockGetConfig = jest.fn();
const mockEvaluateAllGates = jest.fn();

// Mock all dependencies before importing qualityGateService
await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

await jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfig,
}));

await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { get: jest.fn(), del: jest.fn(), setex: jest.fn() },
}));

await jest.unstable_mockModule("@gitwire/rules", () => ({
  evaluateAllGates: mockEvaluateAllGates,
  getRequiredMetrics: jest.fn(() => []),
  formatGateSummary: jest.fn(() => ""),
}));

const { evaluateGatesForRepo } = await import("../../src/services/qualityGateService.js");

describe("evaluateGatesForRepo — provenance contract", function () {

  beforeEach(function () {
    jest.clearAllMocks();

    // Default: no config file, no DB gates, no metrics
    mockGetConfig.mockResolvedValue({
      _meta: { layers: { defaults: true, org: false, repo: false, db: false } },
      quality_gates: { default: { conditions: [], block_on_fail: true } },
    });

    // getGatesForRepo queries DB — return empty by default
    // The query is: SELECT * FROM quality_gates WHERE repo_id = $1
    mockQuery.mockResolvedValue({ rows: [] });

    // fetchMetrics queries DB — return empty metrics
    // evaluateAllGates — return empty by default
    mockEvaluateAllGates.mockReturnValue([]);
  });

  // Helper: make mockQuery return DB gates for getGatesForRepo
  // and handle gate persistence (getGate, saveGate, saveEvaluation)
  function mockDBGates(gates) {
    mockQuery.mockImplementation((sql) => {
      const s = sql.toLowerCase();
      if (s.includes("quality_gates") && s.includes("repo_id") && s.includes("select") && !s.includes("and name")) {
        return { rows: gates };
      }
      if (s.includes("quality_gates") && s.includes("select") && s.includes("and name")) {
        return { rows: [] }; // getGate: not found → will auto-create
      }
      if (s.includes("insert into quality_gates")) {
        return { rows: [{ id: 999 }] }; // saveGate
      }
      if (s.includes("insert into quality_gate_evaluations")) {
        return { rows: [] }; // saveEvaluation
      }
      // Metrics queries (ci_runs, issues, pull_requests, etc.)
      return { rows: [{ total: 0, failed: 0 }] };
    });
  }

  // ── Scenario 1: No config file, no DB gates → skip ─────────────────────

  it("returns empty array when no DB gates and no config file", async function () {
    mockDBGates([]);
    mockGetConfig.mockResolvedValue({
      _meta: { layers: { defaults: true, org: false, repo: false, db: false } },
      quality_gates: { default: { conditions: [{ metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 }], block_on_fail: true } },
    });

    const result = await evaluateGatesForRepo(123, "acme/app");

    expect(result).toEqual([]);
    expect(mockEvaluateAllGates).not.toHaveBeenCalled();
  });

  // ── Scenario 2: Config file WITH quality_gates, no DB gates → evaluate ──

  it("evaluates config gates when user wrote quality_gates in .gitwire.yml", async function () {
    mockDBGates([]);
    mockGetConfig.mockResolvedValue({
      _meta: { layers: { defaults: true, org: false, repo: true, db: false } },
      _explicitKeys: ["version", "quality_gates"],
      quality_gates: {
        "my-gate": { conditions: [{ metric: "readiness_score", operator: ">=", threshold: 80 }], block_on_fail: true },
      },
    });
    mockEvaluateAllGates.mockReturnValue([
      { name: "my-gate", result: "passed", passed: 1, failed: 0, total: 1, score: 100, block_on_fail: true },
    ]);

    const result = await evaluateGatesForRepo(123, "acme/app");

    expect(mockEvaluateAllGates).toHaveBeenCalled();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("my-gate");
  });

  // ── Scenario 3: Config file WITHOUT quality_gates, no DB gates → skip ──

  it("returns empty array when config file exists but has no quality_gates", async function () {
    mockDBGates([]);
    mockGetConfig.mockResolvedValue({
      _meta: { layers: { defaults: true, org: false, repo: true, db: false } },
      _explicitKeys: ["version", "triage"],
      quality_gates: { default: { conditions: [], block_on_fail: true } },
    });

    const result = await evaluateGatesForRepo(123, "acme/app");

    expect(result).toEqual([]);
    expect(mockEvaluateAllGates).not.toHaveBeenCalled();
  });

  // ── Scenario 4: DB gates exist → evaluate regardless of config ──────────

  it("evaluates DB gates even without config file", async function () {
    mockDBGates([
      { name: "ci-gate", conditions: [{ metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 }], block_on_fail: true },
    ]);
    mockGetConfig.mockResolvedValue({
      _meta: { layers: { defaults: true, org: false, repo: false, db: false } },
      quality_gates: {},
    });
    mockEvaluateAllGates.mockReturnValue([
      { name: "ci-gate", result: "passed", passed: 1, failed: 0, total: 1, score: 100, block_on_fail: true },
    ]);

    const result = await evaluateGatesForRepo(123, "acme/app");

    expect(mockEvaluateAllGates).toHaveBeenCalled();
    expect(result.length).toBe(1);
  });
});
