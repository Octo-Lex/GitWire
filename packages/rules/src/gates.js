// @gitwire/rules — gates.js
// Quality gate evaluation engine.
//
// A quality gate is a named set of conditions: [{metric, operator, threshold}].
// Each condition compares a metric value against a threshold using the operator.
// The gate passes only if ALL conditions pass.
//
// This module is pure — no DB, no GitHub, no I/O.
// The metric values are fetched elsewhere and passed in as a flat object.

/**
 * Evaluate a single condition against a metric value.
 *
 * @param {number} actual - The computed metric value
 * @param {string} operator - Comparison operator: <, <=, >, >=, ==, !=
 * @param {number} threshold - The threshold to compare against
 * @returns {{ passed: boolean, actual: number, operator: string, threshold: number }}
 */
export function evaluateCondition(actual, operator, threshold) {
  let passed = false;
  switch (operator) {
    case "<":  passed = actual < threshold; break;
    case "<=": passed = actual <= threshold; break;
    case ">":  passed = actual > threshold; break;
    case ">=": passed = actual >= threshold; break;
    case "==": passed = actual === threshold; break;
    case "!=": passed = actual !== threshold; break;
    default:   passed = false;
  }
  return { passed, actual, operator, threshold };
}

/**
 * Evaluate a quality gate against a set of metric values.
 *
 * @param {object} gate - Gate definition: { conditions: [...], block_on_fail?: boolean }
 * @param {object} metrics - Flat key-value map: { ci_failure_rate_7d: 0.15, ... }
 * @returns {{
 *   result: 'passed' | 'failed',
 *   conditions: Array<{ metric: string, operator: string, threshold: number, actual: number, passed: boolean }>,
 *   passed: number,
 *   failed: number,
 *   total: number,
 *   score: number
 * }}
 */
export function evaluateGate(gate, metrics) {
  const conditions = (gate.conditions || []).map((cond) => {
    const actual = metrics[cond.metric];
    // If metric is missing/null, the condition auto-fails
    if (actual === undefined || actual === null) {
      return {
        metric: cond.metric,
        operator: cond.operator,
        threshold: cond.threshold,
        actual: null,
        passed: false,
      };
    }
    const result = evaluateCondition(actual, cond.operator, cond.threshold);
    return {
      metric: cond.metric,
      operator: cond.operator,
      threshold: cond.threshold,
      actual: result.actual,
      passed: result.passed,
    };
  });

  const passed = conditions.filter((c) => c.passed).length;
  const failed = conditions.filter((c) => !c.passed).length;
  const total = conditions.length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 100;

  return {
    result: failed === 0 ? "passed" : "failed",
    conditions,
    passed,
    failed,
    total,
    score,
  };
}

/**
 * Evaluate all quality gates for a repo config.
 *
 * @param {object} config - Full repo config (with quality_gates key)
 * @param {object} metrics - Flat metric values
 * @returns {Array<{ name: string, result: string, conditions: Array, score: number, block_on_fail: boolean }>}
 */
export function evaluateAllGates(config, metrics) {
  const gates = config.quality_gates || {};
  const results = [];

  for (const [name, gate] of Object.entries(gates)) {
    if (!gate || !Array.isArray(gate.conditions)) continue;

    const evaluation = evaluateGate(gate, metrics);
    results.push({
      name,
      result: evaluation.result,
      conditions: evaluation.conditions,
      passed: evaluation.passed,
      failed: evaluation.failed,
      total: evaluation.total,
      score: evaluation.score,
      block_on_fail: gate.block_on_fail !== false,
    });
  }

  return results;
}

/**
 * Get the list of all known metric names from a config's quality gates.
 *
 * @param {object} config - Full repo config
 * @returns {string[]} unique metric names
 */
export function getRequiredMetrics(config) {
  const gates = config.quality_gates || {};
  const metrics = new Set();

  for (const gate of Object.values(gates)) {
    if (!gate || !Array.isArray(gate.conditions)) continue;
    for (const cond of gate.conditions) {
      if (cond.metric) metrics.add(cond.metric);
    }
  }

  return [...metrics];
}

/**
 * Format a gate evaluation result as a human-readable summary (markdown).
 *
 * @param {object} evalResult - Result from evaluateGate or evaluateAllGates
 * @param {string} gateName - Gate name for the header
 * @returns {string} markdown summary
 */
export function formatGateSummary(evalResult, gateName) {
  const lines = [];
  const icon = evalResult.result === "passed" ? "✅" : "❌";

  lines.push("### " + icon + " Quality Gate: **" + gateName + "**");
  lines.push("");
  lines.push("**Result:** " + evalResult.result.toUpperCase());
  lines.push("**Score:** " + evalResult.score + "% (" + evalResult.passed + "/" + evalResult.total + " conditions passed)");
  lines.push("");
  lines.push("| Metric | Condition | Threshold | Actual | Status |");
  lines.push("|--------|-----------|-----------|--------|--------|");

  for (const cond of evalResult.conditions) {
    const status = cond.passed ? "✅ Pass" : "❌ Fail";
    const actual = cond.actual !== null && cond.actual !== undefined
      ? formatMetricValue(cond.metric, cond.actual)
      : "N/A";
    lines.push("| " + cond.metric + " | " + cond.operator + " | " + cond.threshold + " | " + actual + " | " + status + " |");
  }

  return lines.join("\n");
}

/**
 * Format a metric value for display.
 */
function formatMetricValue(metric, value) {
  // Ratios (0-1) display as percentages
  if (metric.includes("rate") || metric.includes("coverage")) {
    return (value * 100).toFixed(1) + "%";
  }
  // Readiness score is already 0-100
  if (metric === "readiness_score") {
    return Math.round(value) + "/100";
  }
  // Time values
  if (metric.includes("time_hours")) {
    return value.toFixed(1) + "h";
  }
  // Default: number
  return String(value);
}
