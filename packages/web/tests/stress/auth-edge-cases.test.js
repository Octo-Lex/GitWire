// tests/stress/auth-edge-cases.test.js
// Stress Test: Authentication edge cases
//
// Each test deliberately sends missing or invalid auth headers and verifies
// the server rejects with 401. These operations use raw httpOperation
// descriptors (NOT apiContractedOperation) because the entire point is that
// the normal bearer-token attachment must NOT happen.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { httpOperation, runContractedOperation } from "./burst-runner.js";
import { BASE_URL, API_KEY } from "../helpers.js";
import { sleep } from "./stress-helpers.js";

/**
 * Build a raw auth-negative operation descriptor: a request with deliberately
 * invalid/missing auth, wrapped in httpOperation for transport classification,
 * with a responseContract expecting 401.
 */
function authNegativeOp(url, headers = {}, expectedStatus = 401) {
  return {
    kind: "auth-negative",
    method: "GET",
    run: () => httpOperation({
      method: "GET",
      bodyMode: "auto",
      execute: () => fetch(url, { headers: { "Content-Type": "application/json", ...headers } }),
    }),
    responseContract: { expectedStatuses: [expectedStatus] },
  };
}

describe("Auth Edge Cases", () => {
  beforeEach(async () => { await sleep(200); });

  it("No Authorization header → 401", async () => {
    const result = await runContractedOperation(authNegativeOp(`${BASE_URL}/api/repos`));
    expect(result.http).toBe("expected");
    expect(result.assertion).toBe("not_run");
    expect(result.status).toBe(401);
  });

  it("Empty Bearer token → 401", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos`, { Authorization: "Bearer " })
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });

  it("Bearer with random string → 401", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos`, { Authorization: "Bearer not-a-real-key-at-all-12345" })
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });

  it("Basic auth instead of Bearer → 401", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos`, { Authorization: "Basic dXNlcjpwYXNz" })
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });

  it("API key in query string → 401 (header only)", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos?api_key=test`)
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });

  it("/health and /webhooks/github require no auth", async () => {
    // /health: no auth needed, expect 200
    const healthResult = await runContractedOperation({
      kind: "no-auth-health",
      method: "GET",
      run: () => httpOperation({
        method: "GET", bodyMode: "none",
        execute: () => fetch(`${BASE_URL}/health`),
      }),
      responseContract: { expectedStatuses: [200] },
    });
    expect(healthResult.http).toBe("expected");

    // /webhooks/github POST: no auth, should NOT get 401
    const webhookResult = await runContractedOperation({
      kind: "no-auth-webhook",
      method: "POST",
      run: () => httpOperation({
        method: "POST", bodyMode: "auto",
        execute: () => fetch(`${BASE_URL}/webhooks/github`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      }),
      responseContract: { assert: ({ status }) => status !== 401 ? { passed: true } : { passed: false, code: "UNEXPECTED_401", message: "Webhook endpoint should not require auth" } },
    });
    expect(webhookResult.assertion).toBe("passed");
  });

  it("Sequential authed + unauthed: authed=200/429, unauthed=401", async () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const authed = i % 2 === 0;
      if (authed) {
        const r = await runContractedOperation({
          kind: "authed",
          method: "GET",
          run: () => httpOperation({
            method: "GET", bodyMode: "auto",
            execute: () => fetch(`${BASE_URL}/api/repos`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
          }),
          responseContract: { expectedStatuses: [200, 429] },
        });
        results.push({ authed, http: r.http });
      } else {
        const r = await runContractedOperation(authNegativeOp(`${BASE_URL}/api/repos`));
        results.push({ authed, http: r.http, status: r.status });
      }
      await sleep(100);
    }
    const authedStatuses = results.filter(r => r.authed).map(r => r.http);
    const unauthedStatuses = results.filter(r => !r.authed).map(r => r.status);
    authedStatuses.forEach(h => expect(["expected"]).toContain(h === "expected" ? "expected" : "unexpected"));
    unauthedStatuses.forEach(s => expect(s).toBe(401));
  });

  it("Very long API key → 401", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos`, { Authorization: `Bearer ${"A".repeat(10000)}` })
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });

  it("Special characters in API key → 401", async () => {
    const result = await runContractedOperation(
      authNegativeOp(`${BASE_URL}/api/repos`, { Authorization: "Bearer <script>alert(1)</script>" })
    );
    expect(result.http).toBe("expected");
    expect(result.status).toBe(401);
  });
});
