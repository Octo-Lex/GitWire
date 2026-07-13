// HTTP-level tests for POST /v1/validate (v0.23.0 Task 5, step 5-6).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer } from "../src/server.js";
import { _setCmdRunnerForTests, _setImageInspectorForTests } from "../src/validatorRunner.js";

const REF = "registry.example.com/v@sha256:" + "a".repeat(64);
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig() {
  return {
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    executor_service_instance_id: "test-instance",
    deployment_mode: "compose-local",
    port: 0,
    service_token: "secret-token",
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
    validatorIdentityComplete: () => true,
  };
}

function successRunner() {
  return () => ({ ok: true, stdout: "ok", stderr: "", code: 0 });
}
function matchingInspector() {
  return () => ({ ok: true, digest: DIGEST, hash: "sha256:" + "b".repeat(64) });
}

function makeRequestBody(overrides = {}) {
  return {
    request_id: "req-1",
    files: [{ path: "package.json", content: "{}" }],
    commands: ["lint"],
    limits: { wall_clock_ms: 5000, memory_mb: 256, pids_limit: 32, output_bytes: 65536 },
    validator_image_ref: REF,
    validator_image_digest: DIGEST,
    expected_executor_policy: { network_disabled: true, non_root: true, read_only_rootfs: true, resource_limits: true },
    ...overrides,
  };
}

describe("POST /v1/validate — auth", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }) });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    _setCmdRunnerForTests(successRunner());
    _setImageInspectorForTests(matchingInspector());
  });
  afterAll(async () => {
    _setCmdRunnerForTests(null);
    _setImageInspectorForTests(null);
    if (server) await new Promise(r => server.close(r));
  });

  it("rejects requests without Authorization (401)", async () => {
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeRequestBody()),
    });
    expect(r.status).toBe(401);
  });

  it("rejects requests with wrong token (401)", async () => {
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify(makeRequestBody()),
    });
    expect(r.status).toBe(401);
  });

  it("accepts requests with correct bearer token", async () => {
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeRequestBody()),
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /v1/validate — pass path", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }) });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    _setCmdRunnerForTests(successRunner());
    _setImageInspectorForTests(matchingInspector());
  });
  afterAll(async () => {
    _setCmdRunnerForTests(null);
    _setImageInspectorForTests(null);
    if (server) await new Promise(r => server.close(r));
  });

  it("returns 200 + overall=pass + executor_report_hash when commands succeed", async () => {
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeRequestBody()),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.overall).toBe("pass");
    expect(body.executor_report_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.report_schema_version).toBe(1);
    expect(body.container_runtime).toBe("docker");
    expect(body.runtime_version).toBe("29.5.0");
  });
});

describe("POST /v1/validate — inconclusive path", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }) });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    _setCmdRunnerForTests(null);
    _setImageInspectorForTests(null);
    if (server) await new Promise(r => server.close(r));
  });

  it("returns 200 + overall=inconclusive + validator_image_ref_mismatch when request ref differs", async () => {
    _setCmdRunnerForTests(successRunner());
    _setImageInspectorForTests(matchingInspector());
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeRequestBody({ validator_image_ref: "other@sha256:" + "z".repeat(64) })),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.overall).toBe("inconclusive");
    expect(body.inconclusive_reason).toBe("validator_image_ref_mismatch");
  });
});

describe("POST /v1/validate — malformed body", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true }) });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { if (server) await new Promise(r => server.close(r)); });

  it("returns 400 on invalid JSON", async () => {
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: "not json{",
    });
    expect(r.status).toBe(400);
  });
});

// Task 8D: repo-aware command descriptor path through the HTTP layer.
describe("POST /v1/validate — command_descriptors (Task 8D)", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }) });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    _setCmdRunnerForTests(successRunner());
    _setImageInspectorForTests(matchingInspector());
  });
  afterAll(async () => {
    _setCmdRunnerForTests(null);
    _setImageInspectorForTests(null);
    if (server) await new Promise(r => server.close(r));
  });

  it("accepts command_descriptors and returns executed_argv in the receipt", async () => {
    const descriptor = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      argv: ["npx", "--no-install", "eslint", "app.js"],
      target_paths: ["app.js"],
      network: "disabled",
      requires_shell: false,
      policy_status: "pending_executor_validation",
    };
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeRequestBody({
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: descriptor },
      })),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.overall).toBe("pass");
    expect(body.command_results).toHaveLength(1);
    expect(body.command_results[0].command_source).toBe("ci_workflow_descriptor");
    expect(body.command_results[0].executed_argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(body.command_results[0].target_paths).toEqual(["app.js"]);
    expect(body.executor_report_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects an unsafe descriptor fail-closed (overall not pass)", async () => {
    const descriptor = {
      command_id: "repo_lint",
      semantic_id: "lint_result",
      source: "ci_workflow",
      argv: ["npx", "eslint", "app.js"], // missing --no-install
      target_paths: ["app.js"],
      network: "disabled",
      requires_shell: false,
      policy_status: "pending_executor_validation",
    };
    const r = await fetch(`${baseUrl}/v1/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeRequestBody({
        commands: ["repo_lint"],
        command_descriptors: { repo_lint: descriptor },
      })),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.overall).not.toBe("pass");
    expect(body.command_results[0].status).toBe("rejected");
    expect(body.command_results[0].policy_reasons.join("; ")).toMatch(/--no-install/);
  });
});
