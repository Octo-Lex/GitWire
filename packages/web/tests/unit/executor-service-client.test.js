// Tests for the executor-service HTTP client (v0.23.0 Task 3).
//
// The client wraps GET /health and POST /v1/validate.
// Tests inject a fake fetch via _setFetchForTests so no real network is hit.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  fetchExecutorServiceHealth,
  postValidate,
  _setFetchForTests,
} from "../../src/lib/executorServiceClient.js";

function makeHealthResponse(overrides = {}) {
  return {
    status: "ok",
    executor_service_id: "executor-service",
    executor_service_version: "1.0.0",
    executor_service_instance_id: "test-instance-id",
    deployment_mode: "compose-local",
    container_runtime: "docker",
    runtime_version: "29.5.0",
    validator_image_ref: "registry.example.com/v@sha256:" + "a".repeat(64),
    validator_image_digest: "sha256:" + "a".repeat(64),
    ready: true,
    ...overrides,
  };
}

// Build a fake fetch that responds with the given JSON body + status.
function fakeFetch(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("fetchExecutorServiceHealth — success path", () => {
  beforeEach(() => _setFetchForTests(fakeFetch(makeHealthResponse())));
  afterEach(() => _setFetchForTests(null));

  it("returns the parsed health body", async () => {
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.executor_service_id).toBe("executor-service");
    expect(r.ready).toBe(true);
  });

  it("preserves all 10 documented fields", async () => {
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    for (const f of [
      "status", "executor_service_id", "executor_service_version",
      "executor_service_instance_id", "deployment_mode",
      "container_runtime", "runtime_version",
      "validator_image_ref", "validator_image_digest", "ready",
    ]) {
      expect(r).toHaveProperty(f);
    }
  });
});

describe("fetchExecutorServiceHealth — URL + auth wiring", () => {
  let capturedUrl, capturedInit;
  beforeEach(() => {
    capturedUrl = null;
    capturedInit = null;
    _setFetchForTests(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, status: 200, json: async () => makeHealthResponse() };
    });
  });
  afterEach(() => _setFetchForTests(null));

  it("calls GET <url>/health", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedUrl).toBe("http://executor:3003/health");
  });

  it("uses method GET", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.method).toBe("GET");
  });

  it("sends the bearer token when provided", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003", token: "secret" });
    expect(capturedInit.headers.Authorization).toBe("Bearer secret");
  });

  it("omits Authorization when no token is set", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.headers.Authorization).toBeUndefined();
  });

  it("sets a bounded timeout (AbortSignal, not infinite)", async () => {
    await fetchExecutorServiceHealth({ url: "http://executor:3003" });
    expect(capturedInit.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchExecutorServiceHealth — failure modes", () => {
  afterEach(() => _setFetchForTests(null));

  it("returns reachable:false shape on non-200 (e.g. 503)", async () => {
    _setFetchForTests(fakeFetch({}, 503));
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  // P2 #1 lock-in: HTTP 200 with ready:false MUST NOT be reachable for proof.
  // The service's `ready` is the load-bearing readiness signal (runtime
  // reachable AND validator identity complete). Treating a live-but-unready
  // service as reachable would let probeExecutorService report a backend as
  // reachable when it cannot actually produce validator evidence.
  it("returns reachable:false on HTTP 200 + ready:false (live but unready)", async () => {
    _setFetchForTests(fakeFetch(makeHealthResponse({ ready: false }), 200));
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("returns reachable:true on HTTP 200 + ready:true", async () => {
    _setFetchForTests(fakeFetch(makeHealthResponse({ ready: true }), 200));
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(true);
  });

  it("preserves why ready=false in the detail when the body explains it", async () => {
    // The service's /health body doesn't currently carry an explicit reason
    // field, but the client should not crash trying to surface one — and
    // when one is present, it should propagate so operators can diagnose.
    _setFetchForTests(fakeFetch({ ...makeHealthResponse(), ready: false, detail: "validator identity incomplete" }, 200));
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
    // detail is optional; if present, it tells operators why ready=false.
    expect(typeof r.detail).toBe("string");
    expect(r.detail.length).toBeGreaterThan(0);
  });

  it("returns reachable:false shape on network error (fetch rejects)", async () => {
    _setFetchForTests(async () => { throw new Error("ECONNREFUSED"); });
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("returns reachable:false shape on abort/timeout", async () => {
    _setFetchForTests(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(r.reachable).toBe(false);
  });

  it("never throws — always returns a shaped object (probe contract)", async () => {
    _setFetchForTests(async () => { throw new Error("boom"); });
    // The function must not reject even when fetch throws; it returns a
    // reachable:false object so the probe contract holds.
    const r = await fetchExecutorServiceHealth({ url: "http://x:3003" });
    expect(typeof r).toBe("object");
    expect(r.reachable).toBe(false);
  });
});

describe("fetchExecutorServiceHealth — seam safety", () => {
  it("_setFetchForTests(null) restores real fetch (does not throw on shape)", () => {
    _setFetchForTests(null);
    // We can't assert the real result (no service in unit tests), only that
    // the function returns a shaped object rather than crashing the module.
    // Use a deliberately-bad URL so the real fetch fails fast, then verify
    // the function returns reachable=false instead of throwing.
    return expect(
      fetchExecutorServiceHealth({ url: "http://127.0.0.1:1" })
    ).resolves.toMatchObject({ reachable: false });
  });
});

// ── postValidate (Task 5) ───────────────────────────────────────────────────

describe("postValidate — success path", () => {
  const validateResponse = {
    report_schema_version: 1,
    executor_service_id: "executor-service",
    overall: "pass",
    executor_report_hash: "sha256:" + "a".repeat(64),
    aggregate_exit_status: 0,
    command_results: [{ command: "lint", exit_status: 0 }],
  };

  beforeEach(() => _setFetchForTests(fakeFetch(validateResponse, 200)));
  afterEach(() => _setFetchForTests(null));

  it("returns the parsed validate response", async () => {
    const r = await postValidate({ url: "http://x:3003", token: "t", body: { commands: ["lint"] } });
    expect(r.overall).toBe("pass");
    expect(r.executor_report_hash).toMatch(/^sha256:/);
  });
});

describe("postValidate — URL + auth + method wiring", () => {
  let capturedUrl, capturedInit;
  beforeEach(() => {
    capturedUrl = null; capturedInit = null;
    _setFetchForTests(async (url, init) => {
      capturedUrl = url; capturedInit = init;
      return { ok: true, status: 200, json: async () => ({ overall: "pass" }) };
    });
  });
  afterEach(() => _setFetchForTests(null));

  it("calls POST <url>/v1/validate", async () => {
    await postValidate({ url: "http://executor:3003", token: "t", body: {} });
    expect(capturedUrl).toBe("http://executor:3003/v1/validate");
  });

  it("uses method POST", async () => {
    await postValidate({ url: "http://executor:3003", token: "t", body: {} });
    expect(capturedInit.method).toBe("POST");
  });

  it("sends the bearer token", async () => {
    await postValidate({ url: "http://executor:3003", token: "secret", body: {} });
    expect(capturedInit.headers.Authorization).toBe("Bearer secret");
  });

  it("sends the body as JSON", async () => {
    const body = { commands: ["lint"], files: [] };
    await postValidate({ url: "http://executor:3003", token: "t", body });
    expect(capturedInit.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(capturedInit.body)).toEqual(body);
  });
});

describe("postValidate — failure modes", () => {
  afterEach(() => _setFetchForTests(null));

  it("returns inconclusive on non-200 (e.g. 401)", async () => {
    _setFetchForTests(fakeFetch({}, 401));
    const r = await postValidate({ url: "http://x:3003", token: "t", body: {} });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("executor_error");
  });

  it("returns inconclusive on network error (fetch rejects)", async () => {
    _setFetchForTests(async () => { throw new Error("ECONNREFUSED"); });
    const r = await postValidate({ url: "http://x:3003", token: "t", body: {} });
    expect(r.overall).toBe("inconclusive");
    expect(r.inconclusive_reason).toBe("executor_error");
  });

  it("never throws — always returns a shaped object", async () => {
    _setFetchForTests(async () => { throw new Error("boom"); });
    const r = await postValidate({ url: "http://x:3003", token: "t", body: {} });
    expect(r.overall).toBe("inconclusive");
  });
});
