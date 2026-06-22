// packages/executor-service/src/server.js
// HTTP server (v0.23.0 Task 2 + Task 5).
//
// createServer() returns a Node http.Server. Two routes:
//   GET  /health        — liveness + readiness (Task 2)
//   POST /v1/validate   — isolated validator execution (Task 5)
//
// The probe is injectable so tests don't shell out for real; production passes
// probeRuntime directly.

import { createServer as httpCreateServer } from "node:http";
import { buildHealthResponse } from "./health.js";
import { probeRuntime as defaultProbe } from "./runtimeProbe.js";
import { runValidatorJob } from "./validatorRunner.js";

/**
 * Build an HTTP server for the executor service.
 *
 * @param {object} opts
 * @param {object} opts.config - frozen config from loadExecutorServiceConfig()
 * @param {() => {reachable: boolean, container_runtime: string|null, runtime_version: string|null}} [opts.probe]
 *        Optional probe override (tests). Defaults to the real probeRuntime.
 * @returns {import("node:http").Server}
 */
export function createServer({ config, probe = defaultProbe }) {
  return httpCreateServer(async (req, res) => {
    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      const probeResult = probe();
      const body = buildHealthResponse({ config, probeResult });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // ── POST /v1/validate ──────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/v1/validate") {
      // Auth: require the shared bearer token. The network boundary (private
      // compose network only, not exposed externally) is the primary defense;
      // the token is a second layer. Missing token in config → refuse all
      // validates (fail-closed).
      if (!config.service_token) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ overall: "inconclusive", inconclusive_reason: "executor_error", inconclusive_detail: "service token not configured" }));
        return;
      }
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${config.service_token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      // Parse JSON body with a size cap (defense against oversized payloads).
      let body;
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > 16 * 1024 * 1024) { // 16 MB cap
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "payload_too_large" }));
            return;
          }
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      // Enrich config with the probe result so the report carries
      // container_runtime + runtime_version from a live probe.
      const probeResult = probe();
      const enrichedConfig = {
        ...config,
        executor_service_instance_id: config.executor_service_instance_id || getInstanceId(),
        container_runtime: probeResult.container_runtime,
        runtime_version: probeResult.runtime_version,
      };

      // Run the validator job and return the report.
      try {
        const report = await runValidatorJob({ request: body, config: enrichedConfig });
        // Merge runtime_version/container_runtime into the report (the runner
        // leaves them null because it doesn't probe; the route does).
        if (report.overall !== "inconclusive") {
          report.container_runtime = probeResult.container_runtime;
          report.runtime_version = probeResult.runtime_version;
          // Recompute the hash since we added runtime fields post-runner.
          // Importing inline to avoid a cycle at module load.
          const { computeExecutorReportHash, buildExecutorReportRef } = await import("./executorReportHash.js");
          delete report.executor_report_hash;
          delete report.executor_report_ref;
          report.executor_report_hash = computeExecutorReportHash(report);
          report.executor_report_ref = buildExecutorReportRef(report.executor_report_hash);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({
          overall: "inconclusive",
          inconclusive_reason: "executor_error",
          inconclusive_detail: err?.message || "unknown executor error",
          executor_service_id: config.executor_service_id,
          executor_service_version: config.executor_service_version,
        }));
      }
      return;
    }

    // ── 404 for anything else ──────────────────────────────────────────────
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}

// Per-process instance id (matches health.js's INSTANCE_ID pattern).
// Lazy so it's only generated if a validate request arrives before /health.
import { randomUUID } from "node:crypto";
let _instanceId = null;
function getInstanceId() {
  if (!_instanceId) _instanceId = randomUUID();
  return _instanceId;
}
