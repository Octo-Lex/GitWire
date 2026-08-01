// tests/unit/gp02-route-cas-conflict.test.js
// Tests that GP-02 route handlers return HTTP 409 on CAS conflicts.
// Uses Express directly with mocked service layer.

import { jest } from "@jest/globals";

const mockSelectVersion = jest.fn();
const mockSubmitChangeRequest = jest.fn();

jest.unstable_mockModule("../../src/services/governedPolicyService.js", () => ({
  createChangeRequest: jest.fn(),
  createVersion: jest.fn(),
  selectVersion: mockSelectVersion,
  submitChangeRequest: mockSubmitChangeRequest,
  getChangeRequest: jest.fn(),
  listChangeRequests: jest.fn(),
  getVersions: jest.fn(),
  getTransitionEvents: jest.fn(),
}));

jest.unstable_mockModule("../../src/services/auth/observeAdopt.js", () => ({
  observeAuthorize: jest.fn(async () => ({ allowed: true, code: "allowed" })),
  authoritativePrincipalId: jest.fn(() => "test-principal-id"),
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: express } = await import("express");
const http = await import("node:http");

const { governedPolicyRouter } = await import("../../src/routes/governedPolicy.js");

// Helper: start an Express app on a random port, make HTTP requests, shut down
async function withTestServer(handler, fn) {
  const app = express();
  app.use(express.json());
  app.use("/api/policy", governedPolicyRouter);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try {
    return await fn("http://127.0.0.1:" + port);
  } finally {
    await new Promise(r => server.close(r));
  }
}

describe("GP-02 CAS conflict routing", () => {
  beforeEach(() => {
    mockSelectVersion.mockClear();
    mockSubmitChangeRequest.mockClear();
  });

  it("select-version returns 409 on CAS failure", async () => {
    mockSelectVersion.mockRejectedValueOnce(new Error("CAS failed — revision mismatch"));

    await withTestServer(null, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/test-id/select-version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ versionId: "v1" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("concurrently");
    });
  });

  it("submit returns 409 on CAS failure", async () => {
    mockSubmitChangeRequest.mockRejectedValueOnce(new Error("CAS failed — revision mismatch"));

    await withTestServer(null, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/test-id/submit", {
        method: "POST",
        headers: { Authorization: "Bearer test" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("concurrently");
    });
  });

  it("select-version returns 400 on non-CAS error", async () => {
    mockSelectVersion.mockRejectedValueOnce(new Error("not found"));

    await withTestServer(null, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/test-id/select-version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
        body: JSON.stringify({ versionId: "v1" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("submit returns 400 on non-CAS error", async () => {
    mockSubmitChangeRequest.mockRejectedValueOnce(new Error("no version selected"));

    await withTestServer(null, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/test-id/submit", {
        method: "POST",
        headers: { Authorization: "Bearer test" },
      });
      expect(res.status).toBe(400);
    });
  });
});
