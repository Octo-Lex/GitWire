// src/lib/pluginSandboxClient.js
// #425 isolation boundary — app side. Delegates plugin-dependent evaluation
// to the executor service's disposable sandbox (POST /v1/plugin-eval).
//
// The app NEVER imports plugin source, never constructs callable plugin
// functions, and never proxies individual filter calls: the whole evaluation
// crosses the boundary and only a serialized result comes back.
//
// FAIL-CLOSED: every failure mode (URL unconfigured, network error, non-pass
// report, malformed report, evaluation error inside the sandbox) surfaces as
// a typed PluginEvaluationError. Callers must treat it as "evaluation
// failed" — never fall back to in-process plugin execution (which no longer
// exists in this package at all).

export class PluginEvaluationError extends Error {
  constructor(reason, detail) {
    super(`Plugin evaluation failed (${reason}): ${detail || ""}`);
    this.name = "PluginEvaluationError";
    this.reason = reason;
  }
}

const DEFAULT_TIMEOUT_MS = 30000; // sandbox 10s wall clock + kill(5s) + rm(5s) + transport overhead

/**
 * Delegate a complete plugin-dependent evaluation to the sandbox.
 *
 * @param {object} payload - fixed-shape request (kind custom_rules: ctx,
 *   config, plugin_sources; kind playground: expression, context,
 *   expressions, plugin_sources).
 * @returns {Promise<object>} the sandbox report: { overall, evaluation_ok,
 *   result, evaluation_error, isolation, ... }
 * @throws {PluginEvaluationError} on any failure — no fallback exists.
 */
export async function evaluateViaPluginSandbox(payload) {
  const base = process.env.GITWIRE_EXECUTOR_SERVICE_URL;
  if (!base) {
    throw new PluginEvaluationError("executor_service_url_not_configured",
      "GITWIRE_EXECUTOR_SERVICE_URL is not set");
  }
  const token = process.env.GITWIRE_EXECUTOR_SERVICE_TOKEN;

  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + "/v1/plugin-eval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PluginEvaluationError("executor_unreachable", err?.message || String(err));
  }

  if (res.status === 401) throw new PluginEvaluationError("executor_unauthorized", "executor rejected the service token");
  if (res.status !== 200) {
    throw new PluginEvaluationError("executor_http_error", `HTTP ${res.status}`);
  }

  let report;
  try {
    report = await res.json();
  } catch {
    throw new PluginEvaluationError("malformed_report", "executor response is not JSON");
  }
  if (!report || report.overall !== "pass" || typeof report.evaluation_ok !== "boolean") {
    throw new PluginEvaluationError(
      report?.fail_reason || "sandbox_failure",
      report?.fail_detail || "sandbox round trip did not pass",
    );
  }
  return report;
}
