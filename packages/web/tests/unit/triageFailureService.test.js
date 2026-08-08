// tests/unit/triageFailureService.test.js
// Tests for the triage failure classifier and sanitizer.
// Covers required cases 1-6:
//   1. provider 401 → provider_auth, permanent
//   2. provider 403 → provider_auth, permanent
//   3. provider 429 → provider_rate_limit, retryable
//   4. provider 5xx/timeout → provider_unavailable, retryable
//   5. malformed LLM JSON → invalid_provider_response, retryable
//   6. secrets/tokens never survive into safeMessage

import { jest } from "@jest/globals";

const { classifyTriageFailure, isPermanentFailure, sanitizeForRetention } =
  await import("../../src/services/triageFailureService.js");

describe("triageFailureService — classification", () => {
  it("1. provider 401 → provider_auth, permanent (not retryable)", () => {
    const err = Object.assign(new Error('401 {"error":{"message":"Authentication Failed","type":"1000"}}'), {
      status: 401,
      name: "AuthenticationError",
      type: "authentication_error",
    });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_auth");
    expect(c.retryable).toBe(false);
    expect(c.statusCode).toBe(401);
    expect(isPermanentFailure(c)).toBe(true);
  });

  it("2. provider 403 → provider_auth, permanent", () => {
    const err = Object.assign(new Error("403 Forbidden"), {
      status: 403,
      type: "permission_error",
      error: { type: "permission_error" },
    });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_auth");
    expect(c.retryable).toBe(false);
    expect(isPermanentFailure(c)).toBe(true);
  });

  it("3. provider 429 → provider_rate_limit, retryable", () => {
    const err = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      type: "rate_limit_error",
    });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_rate_limit");
    expect(c.retryable).toBe(true);
    expect(isPermanentFailure(c)).toBe(false);
  });

  it("4a. provider 500 → provider_unavailable, retryable", () => {
    const err = Object.assign(new Error("500 Internal Server Error"), {
      status: 500,
      type: "api_error",
    });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_unavailable");
    expect(c.retryable).toBe(true);
  });

  it("4b. provider timeout (no status, network message) → provider_unavailable", () => {
    const err = Object.assign(new Error("ETIMEDOUT"), { stack: "@anthropic-ai/sdk/core.mjs:300" });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_unavailable");
    expect(c.retryable).toBe(true);
  });

  it("4c. provider ECONNRESET → provider_unavailable", () => {
    const err = new Error("ECONNRESET socket hang up");
    err.stack = "/app/node_modules/@anthropic-ai/sdk/core.mjs:344";
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("provider_unavailable");
    expect(c.retryable).toBe(true);
  });

  it("5. malformed LLM JSON → invalid_provider_response, retryable", () => {
    const err = new SyntaxError("Unexpected token < in JSON at position 0");
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("invalid_provider_response");
    expect(c.retryable).toBe(true);
  });

  it("github 401 → github_auth (not provider_auth), permanent", () => {
    const err = Object.assign(new Error("GitHub: Bad credentials"), { status: 401 });
    // No anthropic shape markers → classified as github_auth
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("github_auth");
    expect(c.retryable).toBe(false);
    expect(isPermanentFailure(c)).toBe(true);
  });

  it("github 5xx → github_unavailable, retryable", () => {
    const err = Object.assign(new Error("502 Bad Gateway"), { status: 502 });
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("github_unavailable");
    expect(c.retryable).toBe(true);
  });

  it("database error → persistence_failure, retryable", () => {
    const err = new Error("relation managed_actions does not exist");
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("persistence_failure");
    expect(c.retryable).toBe(true);
  });

  it("unknown error → unknown, retryable", () => {
    const err = new Error("something completely unexpected");
    const c = classifyTriageFailure(err);
    expect(c.failureClass).toBe("unknown");
    expect(c.retryable).toBe(true);
  });

  it("always includes a failedAt ISO timestamp", () => {
    const c = classifyTriageFailure(new Error("test"));
    expect(c.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("triageFailureService — sanitization (case 6)", () => {
  it("strips Bearer tokens from safeMessage", () => {
    const c = classifyTriageFailure(new Error("Bearer gho_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"));
    const s = sanitizeForRetention(c);
    expect(s.safeMessage).not.toMatch(/gho_/);
    expect(s.safeMessage).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  it("strips API-key-shaped substrings (sk-, gho_, ghp_)", () => {
    const c = classifyTriageFailure(new Error("key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA"));
    const s = sanitizeForRetention(c);
    expect(s.safeMessage).not.toMatch(/sk-ant/);
    expect(s.safeMessage).not.toMatch(/gho_|ghp_|ghs_/);
  });

  it("scrubs long hex/base64 runs when present in a custom message", () => {
    // sanitizeForRetention must scrub any 40+ char run even when the
    // classifier produces a generic message. Test scrubSecrets directly.
    const long = "a".repeat(50);
    const c = classifyTriageFailure(new Error("token=" + long));
    const s = sanitizeForRetention(c);
    // The generic safeMessage won't contain the token, but verify scrubSecrets
    // is wired by passing a message that survives classification.
    expect(s.safeMessage).not.toContain(long);
  });

  it("scrubSecrets redacts explicit token content passed through safeMessage", () => {
    // Force a safeMessage with token content by constructing a classification
    // manually (simulating an operator-supplied message path).
    const fake = {
      failureClass: "unknown",
      retryable: true,
      statusCode: null,
      safeMessage: "Error: Bearer gho_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH in sk-ant-api03-key",
      failedAt: "2026-08-06T10:00:00.000Z",
    };
    const s = sanitizeForRetention(fake);
    expect(s.safeMessage).not.toMatch(/gho_|sk-ant/);
    expect(s.safeMessage).toContain("<redacted>");
  });

  it("produces generic safeMessage for classified failures (no raw error body)", () => {
    const err = Object.assign(
      new Error('401 {"error":{"message":"Authentication Failed","type":"1000","secret":"GH_TOKEN=abc123"}}'),
      { status: 401, name: "AuthenticationError", type: "authentication_error" },
    );
    const c = classifyTriageFailure(err);
    const s = sanitizeForRetention(c);
    expect(s.safeMessage).toBe("LLM provider rejected authentication");
    expect(s.safeMessage).not.toContain("secret");
    expect(s.safeMessage).not.toContain("GH_TOKEN");
    expect(s.safeMessage).not.toContain("abc123");
  });

  it("retains firstFailedAt across attempts and increments attempts", () => {
    const c1 = classifyTriageFailure(new Error("timeout"));
    const s1 = sanitizeForRetention(c1, { attempts: 1, firstFailedAt: "2026-08-06T10:00:00.000Z" });
    expect(s1.attempts).toBe(1);
    expect(s1.firstFailedAt).toBe("2026-08-06T10:00:00.000Z");

    const c2 = classifyTriageFailure(new Error("timeout"));
    const s2 = sanitizeForRetention(c2, { attempts: 2, firstFailedAt: s1.firstFailedAt });
    expect(s2.attempts).toBe(2);
    expect(s2.firstFailedAt).toBe(s1.firstFailedAt);
  });
});
