// tests/gates.test.js
// Quality gate evaluation tests — pure logic, no I/O.

import {
  evaluateCondition,
  evaluateGate,
  evaluateAllGates,
  getRequiredMetrics,
  formatGateSummary,
} from "../src/gates.js";

describe("evaluateCondition", () => {
  it("evaluates < operator", () => {
    expect(evaluateCondition(0.1, "<", 0.3)).toEqual({
      passed: true, actual: 0.1, operator: "<", threshold: 0.3,
    });
    expect(evaluateCondition(0.5, "<", 0.3)).toEqual({
      passed: false, actual: 0.5, operator: "<", threshold: 0.3,
    });
  });

  it("evaluates <= operator", () => {
    expect(evaluateCondition(0.3, "<=", 0.3).passed).toBe(true);
    expect(evaluateCondition(0.29, "<=", 0.3).passed).toBe(true);
    expect(evaluateCondition(0.31, "<=", 0.3).passed).toBe(false);
  });

  it("evaluates > operator", () => {
    expect(evaluateCondition(0.5, ">", 0.3).passed).toBe(true);
    expect(evaluateCondition(0.1, ">", 0.3).passed).toBe(false);
  });

  it("evaluates >= operator", () => {
    expect(evaluateCondition(0.3, ">=", 0.3).passed).toBe(true);
    expect(evaluateCondition(0.31, ">=", 0.3).passed).toBe(true);
    expect(evaluateCondition(0.29, ">=", 0.3).passed).toBe(false);
  });

  it("evaluates == operator", () => {
    expect(evaluateCondition(5, "==", 5).passed).toBe(true);
    expect(evaluateCondition(5, "==", 6).passed).toBe(false);
  });

  it("evaluates != operator", () => {
    expect(evaluateCondition(5, "!=", 6).passed).toBe(true);
    expect(evaluateCondition(5, "!=", 5).passed).toBe(false);
  });

  it("returns false for unknown operator", () => {
    expect(evaluateCondition(5, "??", 3).passed).toBe(false);
  });
});

describe("evaluateGate", () => {
  const gate = {
    conditions: [
      { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 },
      { metric: "triage_coverage", operator: ">=", threshold: 0.5 },
      { metric: "readiness_score", operator: ">=", threshold: 40 },
    ],
    block_on_fail: true,
  };

  it("passes when all conditions pass", () => {
    const metrics = {
      ci_failure_rate_7d: 0.1,
      triage_coverage: 0.8,
      readiness_score: 65,
    };
    const result = evaluateGate(gate, metrics);
    expect(result.result).toBe("passed");
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.score).toBe(100);
  });

  it("fails when any condition fails", () => {
    const metrics = {
      ci_failure_rate_7d: 0.5, // FAILS: 0.5 < 0.3 is false
      triage_coverage: 0.8,
      readiness_score: 65,
    };
    const result = evaluateGate(gate, metrics);
    expect(result.result).toBe("failed");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.score).toBe(67);
  });

  it("fails all conditions when metrics are empty", () => {
    const result = evaluateGate(gate, {});
    expect(result.result).toBe("failed");
    expect(result.passed).toBe(0);
    expect(result.conditions[0].actual).toBeNull();
  });

  it("handles single-condition gate", () => {
    const simple = {
      conditions: [{ metric: "open_issues", operator: "<=", threshold: 10 }],
    };
    expect(evaluateGate(simple, { open_issues: 5 }).result).toBe("passed");
    expect(evaluateGate(simple, { open_issues: 15 }).result).toBe("failed");
  });

  it("handles empty conditions (passes by default)", () => {
    const result = evaluateGate({ conditions: [] }, {});
    expect(result.result).toBe("passed");
    expect(result.score).toBe(100);
  });

  it("handles null metric value", () => {
    const result = evaluateGate(
      { conditions: [{ metric: "ci_failure_rate_7d", operator: "<", threshold: 0.5 }] },
      { ci_failure_rate_7d: null }
    );
    expect(result.result).toBe("failed");
  });
});

describe("evaluateAllGates", () => {
  const config = {
    quality_gates: {
      default: {
        conditions: [
          { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 },
        ],
        block_on_fail: true,
      },
      strict: {
        conditions: [
          { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.1 },
          { metric: "triage_coverage", operator: ">=", threshold: 0.8 },
        ],
        block_on_fail: true,
      },
      informational: {
        conditions: [
          { metric: "readiness_score", operator: ">=", threshold: 70 },
        ],
        block_on_fail: false,
      },
    },
  };

  const metrics = {
    ci_failure_rate_7d: 0.15,
    triage_coverage: 0.6,
    readiness_score: 50,
  };

  it("evaluates all gates and returns results", () => {
    const results = evaluateAllGates(config, metrics);
    expect(results).toHaveLength(3);

    // default: 0.15 < 0.3 = PASS
    expect(results[0].name).toBe("default");
    expect(results[0].result).toBe("passed");

    // strict: 0.15 < 0.1 = FAIL, 0.6 >= 0.8 = FAIL
    expect(results[1].name).toBe("strict");
    expect(results[1].result).toBe("failed");
    expect(results[1].failed).toBe(2);

    // informational: 50 >= 70 = FAIL
    expect(results[2].name).toBe("informational");
    expect(results[2].result).toBe("failed");
    expect(results[2].block_on_fail).toBe(false);
  });

  it("returns empty array when no gates defined", () => {
    expect(evaluateAllGates({}, metrics)).toEqual([]);
    expect(evaluateAllGates({ quality_gates: {} }, metrics)).toEqual([]);
  });

  it("skips gates with invalid conditions", () => {
    const badConfig = {
      quality_gates: {
        broken: { conditions: "not an array" },
        ok: { conditions: [{ metric: "open_issues", operator: "<=", threshold: 10 }] },
      },
    };
    const results = evaluateAllGates(badConfig, { open_issues: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("ok");
    expect(results[0].result).toBe("passed");
  });
});

describe("getRequiredMetrics", () => {
  it("extracts unique metric names from all gates", () => {
    const config = {
      quality_gates: {
        a: { conditions: [{ metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 }] },
        b: { conditions: [
          { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.1 },
          { metric: "triage_coverage", operator: ">=", threshold: 0.5 },
        ]},
      },
    };
    const metrics = getRequiredMetrics(config);
    expect(metrics).toContain("ci_failure_rate_7d");
    expect(metrics).toContain("triage_coverage");
    expect(metrics).toHaveLength(2);
  });

  it("returns empty array when no gates", () => {
    expect(getRequiredMetrics({})).toEqual([]);
    expect(getRequiredMetrics({ quality_gates: {} })).toEqual([]);
  });
});

describe("formatGateSummary", () => {
  it("produces markdown summary for passed gate", () => {
    const evalResult = {
      result: "passed",
      conditions: [
        { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3, actual: 0.1, passed: true },
      ],
      passed: 1,
      failed: 0,
      total: 1,
      score: 100,
    };
    const md = formatGateSummary(evalResult, "default");
    expect(md).toContain("✅");
    expect(md).toContain("PASSED");
    expect(md).toContain("ci_failure_rate_7d");
    expect(md).toContain("10.0%"); // 0.1 * 100
  });

  it("produces markdown summary for failed gate", () => {
    const evalResult = {
      result: "failed",
      conditions: [
        { metric: "readiness_score", operator: ">=", threshold: 70, actual: 50, passed: false },
      ],
      passed: 0,
      failed: 1,
      total: 1,
      score: 0,
    };
    const md = formatGateSummary(evalResult, "strict");
    expect(md).toContain("❌");
    expect(md).toContain("FAILED");
    expect(md).toContain("50/100");
  });

  it("handles null actual value", () => {
    const evalResult = {
      result: "failed",
      conditions: [
        { metric: "heal_success_rate_7d", operator: ">=", threshold: 0.5, actual: null, passed: false },
      ],
      passed: 0, failed: 1, total: 1, score: 0,
    };
    const md = formatGateSummary(evalResult, "test");
    expect(md).toContain("N/A");
  });

  it("formats time metrics", () => {
    const evalResult = {
      result: "passed",
      conditions: [
        { metric: "avg_triage_time_hours", operator: "<=", threshold: 24, actual: 12.5, passed: true },
      ],
      passed: 1, failed: 0, total: 1, score: 100,
    };
    const md = formatGateSummary(evalResult, "test");
    expect(md).toContain("12.5h");
  });
});

describe("schema validation — quality_gates", () => {
  it("validates quality_gates config", async () => {
    const { validateConfig } = await import("../src/schema.js");

    // Valid config
    const valid = validateConfig({
      quality_gates: {
        my_gate: {
          conditions: [
            { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.5 },
          ],
          block_on_fail: true,
        },
      },
    });
    expect(valid.valid).toBe(true);

    // Invalid: conditions not array
    const bad1 = validateConfig({
      quality_gates: { g1: { conditions: "bad" } },
    });
    expect(bad1.valid).toBe(false);
    expect(bad1.errors[0]).toContain("conditions must be an array");

    // Invalid: bad operator
    const bad2 = validateConfig({
      quality_gates: {
        g2: { conditions: [{ metric: "x", operator: "~", threshold: 1 }] },
      },
    });
    expect(bad2.valid).toBe(false);
    expect(bad2.errors[0]).toContain("operator must be one of");

    // Invalid: threshold not number
    const bad3 = validateConfig({
      quality_gates: {
        g3: { conditions: [{ metric: "x", operator: "<", threshold: "high" }] },
      },
    });
    expect(bad3.valid).toBe(false);
    expect(bad3.errors[0]).toContain("threshold must be a number");
  });
});
