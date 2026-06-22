// HTTP-level smoke test for the executor service (v0.23.0 Task 2, step 6b).
//
// Verifies that createServer() returns an http.Server whose /health endpoint
// serves the buildHealthResponse() shape. Binds to an ephemeral port so the
// test doesn't collide with anything else.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer } from "../src/server.js";

// Use a fake command runner for the runtime probe so the test is deterministic
// regardless of whether Docker is installed in the test environment.
const fakeDockerVersion = () => ({
  ok: true,
  stdout: "Docker version 29.5.0, build 98f1464",
});

describe("executor service HTTP server — /health endpoint", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    // Use port 0 → OS picks an ephemeral free port.
    server = createServer({
      config: {
        executor_service_id: "executor-service",
        executor_service_version: "1.0.0",
        deployment_mode: "compose-local",
        port: 0,
        service_token: null,
        validator_image_ref: "r@sha256:" + "a".repeat(64),
        validator_image_digest: "sha256:" + "a".repeat(64),
        validatorIdentityComplete: () => true,
      },
      // Inject a probe that always returns reachable so the test is green
      // regardless of Docker presence in CI.
      probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it("GET /health returns 200", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
  });

  it("GET /health returns application/json", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("GET /health body has the documented shape", async () => {
    const r = await fetch(`${baseUrl}/health`);
    const body = await r.json();
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("executor_service_id", "executor-service");
    expect(body).toHaveProperty("deployment_mode", "compose-local");
    expect(body).toHaveProperty("container_runtime", "docker");
    expect(body).toHaveProperty("ready", true);
  });

  it("GET /unknown returns 404 (no other routes in v0.23.0)", async () => {
    const r = await fetch(`${baseUrl}/unknown`);
    expect(r.status).toBe(404);
  });
});
