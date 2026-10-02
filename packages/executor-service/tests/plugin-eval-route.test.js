// HTTP-level tests for POST /v1/plugin-eval (#425 isolation boundary).

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { createServer } from "../src/server.js";
import { _setCmdRunnerForTests, _setImageInspectorForTests } from "../src/pluginSandboxRunner.js";

const REF = "registry.example.com/gitwire-plugin-sandbox";
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig(overrides = {}) {
  return {
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    deployment_mode: "compose-local",
    port: 0,
    service_token: "secret-token",
    plugin_sandbox_image_ref: REF,
    plugin_sandbox_image_digest: DIGEST,
    ...overrides,
  };
}

function successRunner(stdout = JSON.stringify({ ok: true, matched: [] })) {
  return (cmd) => {
    if (cmd[1] === "run") return { ok: true, stdout, stderr: "", code: 0, started: true, timed_out: false };
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
}

function matchingInspector() {
  return () => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] });
}

function makeBody(overrides = {}) {
  return {
    kind: "playground",
    expression: "1 + 1",
    context: {},
    plugin_sources: [],
    ...overrides,
  };
}

describe("POST /v1/plugin-eval", () => {
  let server, baseUrl;
  beforeAll(async () => {
    server = createServer({ config: makeConfig(), probe: () => ({ reachable: true, container_runtime: "docker", runtime_version: "29.5.0" }) });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    _setImageInspectorForTests(matchingInspector());
  });
  afterAll(async () => {
    _setCmdRunnerForTests(null);
    _setImageInspectorForTests(null);
    await new Promise((r) => server.close(r));
  });

  it("rejects requests without the service token", async () => {
    const res = await fetch(baseUrl + "/v1/plugin-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON", async () => {
    const res = await fetch(baseUrl + "/v1/plugin-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("refuses all evaluations when no service token is configured (fail-closed)", async () => {
    const bare = createServer({ config: makeConfig({ service_token: null }), probe: () => ({ reachable: false, container_runtime: null, runtime_version: null }) });
    await new Promise((r) => bare.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${bare.address().port}`;
    const res = await fetch(url + "/v1/plugin-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.fail_reason).toBe("executor_error");
    await new Promise((r) => bare.close(r));
  });

  it("returns the sandbox report for a valid request", async () => {
    _setCmdRunnerForTests(successRunner(JSON.stringify({ ok: true, result: { value: 2 } })));
    const res = await fetch(baseUrl + "/v1/plugin-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeBody()),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("pass");
    expect(body.result).toEqual({ value: 2 });
  });

  it("surfaces protocol violations as typed failures (never executed)", async () => {
    _setCmdRunnerForTests(successRunner());
    const res = await fetch(baseUrl + "/v1/plugin-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: JSON.stringify(makeBody({ argv: ["evil"] })),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("fail");
    expect(body.fail_reason).toBe("protocol_violation");
  });
});
