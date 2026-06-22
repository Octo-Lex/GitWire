// packages/executor-service/src/server.js
// HTTP server (v0.23.0 Task 2, step 6b).
//
// createServer() returns a Node http.Server. v0.23.0 wires exactly one route
// (GET /health) to buildHealthResponse(). POST /v1/validate is explicitly
// Task 5, not this PR.
//
// The probe is injectable so tests don't shell out for real; production passes
// probeRuntime directly.

import { createServer as httpCreateServer } from "node:http";
import { buildHealthResponse } from "./health.js";
import { probeRuntime as defaultProbe } from "./runtimeProbe.js";

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
  return httpCreateServer((req, res) => {
    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      const probeResult = probe();
      const body = buildHealthResponse({ config, probeResult });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // ── 404 for anything else (intentionally minimal v0.23.0 surface) ──────
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
