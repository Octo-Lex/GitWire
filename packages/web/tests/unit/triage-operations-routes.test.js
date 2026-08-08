// tests/unit/triage-operations-routes.test.js
// Tests for the triage operator API and /health workflow extension.
// Covers Commit 3 acceptance cases 1-17.

import { jest } from "@jest/globals";

// ── Mock queue state (controlled per-test) ──────────────────────────────────
const mockFailedJobs = [];
const mockActiveJobs = [];
const mockWaitingJobs = [];
const mockJobMap = new Map();
const mockQueueReadOk = { value: true }; // toggle to simulate queue unavailability

const triageQueue = {
  getFailed: jest.fn(async () => [...mockFailedJobs]),
  getActive: jest.fn(async () => [...mockActiveJobs]),
  getWaiting: jest.fn(async () => [...mockWaitingJobs]),
  getJob: jest.fn(async (id) => mockJobMap.get(id) ?? null),
};

function makeFailedJob(overrides = {}) {
  const id = String(overrides.id ?? Math.floor(Math.random() * 100000));
  const job = {
    id,
    name: overrides.name ?? "triage-issue",
    queueName: "triage",
    failedReason: overrides.failedReason ?? "provider_auth",
    finishedOn: overrides.finishedOn ?? Date.now(),
    attempts: overrides.attempts ?? 1,
    data: {
      payload: overrides.payload ?? {
        action: "opened",
        installation: { id: 11111 },
        repository: { id: 999, full_name: "org/repo" },
        issue: { id: 555, number: 42 },
      },
      gitwireFailure: overrides.gitwireFailure ?? {
        failureClass: "provider_auth",
        retryable: false,
        statusCode: 401,
        safeMessage: "LLM provider rejected authentication",
        firstFailedAt: "2026-08-06T14:20:42Z",
        latestFailedAt: "2026-08-06T14:20:42Z",
        attempts: 1,
      },
    },
    retry: jest.fn(async () => {}),
  };
  mockJobMap.set(id, job);
  if (overrides.addToFailed !== false) mockFailedJobs.push(job);
  return job;
}

// ── Mock modules ────────────────────────────────────────────────────────────
await jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn(), eval: jest.fn() },
  createWorker: jest.fn(),
  QUEUES: { TRIAGE: "triage" },
  triageQueue,
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: jest.fn(async () => ({ rows: [] })) },
}));

const mockLogDecision = jest.fn().mockResolvedValue(undefined);
await jest.unstable_mockModule("../../src/services/decisionLogService.js", () => ({
  logDecision: mockLogDecision,
}));

// authorize mock — default allow, toggle per-test to simulate deny
const mockAuthorize = jest.fn().mockResolvedValue({
  allowed: true, code: "permission_granted", principalId: "test-principal-uuid",
});
await jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
}));

// isOperationComplete mock — default false (not complete), toggle per-test
const mockIsOperationComplete = jest.fn().mockResolvedValue(false);
await jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  isOperationComplete: mockIsOperationComplete,
  buildTriageOperationKey: jest.fn(({ targetType, repoId, targetId, action }) =>
    `repo:${repoId}:${targetType}:${targetId}:${action}`),
}));

// ── Import the app after mocks are set up ────────────────────────────────────
const express = (await import("express")).default;
const supertest = (await import("supertest")).default;

// Build a minimal app with just the triage routes (bypassing full app setup)
const { triageOperationsRouter } = await import("../../src/routes/triageOperations.js");
const { getTriageStatusSummary, getTriageHealthBlock, sanitizeFailedJob } =
  await import("../../src/services/triageStatusService.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulate apiKeyAuth + authContext having run
  app.use((req, _res, next) => {
    req.auth = { principalId: "test-principal-uuid", principalType: "service" };
    req.authDecisionCode = "allowed";
    next();
  });
  app.use("/api/triage", triageOperationsRouter);
  // Minimal error handler
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  mockFailedJobs.length = 0;
  mockActiveJobs.length = 0;
  mockWaitingJobs.length = 0;
  mockJobMap.clear();
  jest.clearAllMocks();
  mockIsOperationComplete.mockResolvedValue(false);
  mockLogDecision.mockResolvedValue(undefined);
  mockAuthorize.mockResolvedValue({ allowed: true, code: "permission_granted", principalId: "test-principal-uuid" });
  triageQueue.getFailed.mockImplementation(async () => [...mockFailedJobs]);
  triageQueue.getActive.mockImplementation(async () => [...mockActiveJobs]);
  triageQueue.getWaiting.mockImplementation(async () => [...mockWaitingJobs]);
});

// ── Status endpoint (cases 1-2) ─────────────────────────────────────────────
describe("GET /api/triage/status", () => {
  it("1. healthy queue → status healthy", async () => {
    const app = buildApp();
    const res = await supertest(app).get("/api/triage/status");
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.status).toBe("healthy");
    expect(body.failed_count).toBe(0);
  });

  it("2. one retained failed job → status degraded", async () => {
    makeFailedJob();
    const app = buildApp();
    const res = await supertest(app).get("/api/triage/status" );
    const body = res.body;
    expect(body.status).toBe("degraded");
    expect(body.failed_count).toBe(1);
    expect(body.oldest_failure_at).toBeTruthy();
  });
});

// ── Failure listing (cases 3-4) ─────────────────────────────────────────────
describe("GET /api/triage/failures", () => {
  it("3. failure list contains only sanitized fields", async () => {
    makeFailedJob({
      payload: {
        action: "opened",
        repository: { id: 999, full_name: "org/repo" },
        issue: { id: 555, number: 42, body: "SECRET: gho_AAAABBBBCCCC" },
      },
    });
    const app = buildApp();
    const res = await supertest(app).get("/api/triage/failures" );
    const body = res.body;
    expect(body.data).toHaveLength(1);
    const entry = body.data[0];

    // Must contain only the safe fields
    const allowedKeys = new Set([
      "job_id", "job_name", "repository", "target_type", "target_number",
      "failure_class", "safe_message", "failed_at", "attempts", "retryable_now",
    ]);
    for (const key of Object.keys(entry)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Must NOT contain raw payload or secret content
    expect(JSON.stringify(entry)).not.toContain("gho_");
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(entry.repository).toBe("org/repo");
    expect(entry.failure_class).toBe("provider_auth");
  });

  it("4. limit and repo filtering work", async () => {
    makeFailedJob({ payload: { action: "opened", repository: { id: 1, full_name: "org/a" }, issue: { id: 1, number: 1 } } });
    makeFailedJob({ payload: { action: "opened", repository: { id: 2, full_name: "org/b" }, issue: { id: 2, number: 2 } } });
    makeFailedJob({ payload: { action: "opened", repository: { id: 3, full_name: "org/a" }, issue: { id: 3, number: 3 } } });

    const app = buildApp();

    // Repo filter
    const resRepo = await supertest(app).get("/api/triage/failures?repo=org/a" );
    const bodyRepo = resRepo.body;
    expect(bodyRepo.data).toHaveLength(2);
    expect(bodyRepo.data.every((d) => d.repository === "org/a")).toBe(true);

    // Limit
    const resLimit = await supertest(app).get("/api/triage/failures?limit=1" );
    const bodyLimit = resLimit.body;
    expect(bodyLimit.data).toHaveLength(1);
  });
});

// ── Safe retry (cases 5-13) ──────────────────────────────────────────────────
describe("POST /api/triage/failures/:jobId/retry", () => {
  it("5. valid failed job retry → 202", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "Credential restored and validated" });
    expect(res.statusCode).toBe(202);
    const body = res.body;
    expect(body.queued).toBe(true);
    expect(job.retry).toHaveBeenCalled();
  });

  it("6. unknown job → 404", async () => {
    const app = buildApp();
    const res = await supertest(app).post("/api/triage/failures/99999/retry").send({ reason: "test reason" });
    expect(res.statusCode).toBe(404);
  });

  it("7. non-failed job → 409", async () => {
    // Job exists but is NOT failed (no failedReason, finishedOn null)
    const job = {
      id: "777",
      name: "triage-issue",
      queueName: "triage",
      failedReason: undefined,
      finishedOn: null,
      data: { payload: { action: "opened", repository: { id: 1, full_name: "o/r" }, issue: { id: 1, number: 1 } } },
      retry: jest.fn(),
    };
    mockJobMap.set("777", job);

    const app = buildApp();
    const res = await supertest(app).post("/api/triage/failures/777/retry").send({ reason: "test reason here" });
    expect(res.statusCode).toBe(409);
  });

  it("8. completed operation → 409", async () => {
    const job = makeFailedJob();
    mockIsOperationComplete.mockResolvedValue(true); // operation already complete

    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "test reason" });
    expect(res.statusCode).toBe(409);
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("9. malformed historical payload → 422", async () => {
    const job = {
      id: "888",
      name: "triage-issue",
      queueName: "triage",
      failedReason: "error",
      finishedOn: Date.now(),
      data: {}, // no payload
      retry: jest.fn(),
    };
    mockJobMap.set("888", job);

    const app = buildApp();
    const res = await supertest(app).post("/api/triage/failures/888/retry").send({ reason: "test reason" });
    expect(res.statusCode).toBe(422);
  });

  it("10. queue unavailable → 503 on failures endpoint", async () => {
    triageQueue.getFailed.mockRejectedValue(new Error("ECONNREFUSED"));
    const app = buildApp();
    const res = await supertest(app).get("/api/triage/failures" );
    expect(res.statusCode).toBe(503);
  });

  it("11. retry actor comes from req.auth, not request input", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    await supertest(app)
      .post(`/api/triage/failures/${job.id}/retry`)
      .send({ reason: "valid reason", actor: "attacker-controlled-id" }); // body actor must be ignored
    // logDecision should have been called with principalId from req.auth
    const retryCall = mockLogDecision.mock.calls.find(
      (c) => c[0]?.source === "triage-retry",
    );
    expect(retryCall).toBeTruthy();
    expect(retryCall[0].principalId).toBe("test-principal-uuid");
    expect(retryCall[0].principalId).not.toBe("attacker-controlled-id");
  });

  it("12. retry reason is recorded in the decision log", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "Credential rotated and validated at 14:42Z" });
    const retryCall = mockLogDecision.mock.calls.find(
      (c) => c[0]?.source === "triage-retry",
    );
    expect(retryCall).toBeTruthy();
    expect(retryCall[0].reason).toContain("Credential rotated and validated at 14:42Z");
  });

  it("13. retry does not clear or bypass the worker lifecycle guard", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "restored dependency" });
    expect(res.statusCode).toBe(202);
    // The route must NOT call isOperationComplete=true-and-skip; it only
    // preflight-checks and requeues. The worker is the final arbiter.
    // Verify: isOperationComplete was called (preflight) but the job.retry()
    // was still called (requeued), so the worker will re-check.
    expect(mockIsOperationComplete).toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalled();
  });

  it("rejects retry with no reason → 400", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "" });
    expect(res.statusCode).toBe(400);
  });

  it("denies retry when authorize() rejects → 403", async () => {
    const job = makeFailedJob();
    mockAuthorize.mockResolvedValue({ allowed: false, code: "permission_missing" });
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "valid reason" });
    expect(res.statusCode).toBe(403);
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("returns 422 when payload lacks authoritative installation/repository IDs", async () => {
    const job = {
      id: "666",
      name: "triage-issue",
      queueName: "triage",
      failedReason: "error",
      finishedOn: Date.now(),
      data: {
        payload: {
          action: "opened",
          repository: { id: 999, full_name: "org/repo" },
          issue: { id: 555, number: 42 },
        },
      },
      retry: jest.fn(),
    };
    mockJobMap.set("666", job);

    const app = buildApp();
    const res = await supertest(app).post("/api/triage/failures/666/retry").send({ reason: "valid reason" });
    expect(res.statusCode).toBe(422);
  });
});

// ── /health workflow tests (cases 14-17) ────────────────────────────────────
describe("/health triage workflow block (cases 14-17)", () => {
  it("14. /health degraded when triage has unresolved failures", async () => {
    makeFailedJob();
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("degraded");
    expect(block.failed_count).toBe(1);
    // Anonymous-safe: only status, failed_count, oldest_failure_at
    expect(block.oldest_failure_at).toBeTruthy();
  });

  it("15. /health degraded (not hanging) when queue inspection times out", async () => {
    // Simulate timeout: getFailed never resolves within the bounded window
    triageQueue.getFailed.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const start = Date.now();
    const block = await getTriageHealthBlock({ timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(block.status).toBe("unknown");
    expect(elapsed).toBeLessThan(1000); // did not hang
  });

  it("16. anonymous /health leaks no repository, target, or error details", async () => {
    makeFailedJob({
      payload: {
        action: "opened",
        repository: { id: 999, full_name: "SecretOrg/SecretRepo" },
        issue: { id: 555, number: 77 },
      },
      gitwireFailure: {
        failureClass: "provider_auth",
        safeMessage: "LLM provider rejected authentication",
        firstFailedAt: "2026-08-06T14:20:37Z",
        attempts: 1,
      },
    });
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    const serialized = JSON.stringify(block);
    // Must NOT contain repo names, issue numbers, or error strings
    expect(serialized).not.toContain("SecretOrg");
    expect(serialized).not.toContain("SecretRepo");
    expect(serialized).not.toContain('"77"'); // issue number should not appear as a value
    expect(serialized).not.toContain("LLM provider");
    // Must only contain: status, failed_count, oldest_failure_at
    expect(Object.keys(block).sort()).toEqual(["failed_count", "oldest_failure_at", "status"]);
  });

  it("17. existing migration degradation behavior still works (status ok when no failures, no degradation)", async () => {
    // No failed jobs → triage healthy. The top-level health logic in app.js
    // combines this with deployment status; this test verifies the helper
    // returns healthy, and app.js logic (tested separately) preserves it.
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("healthy");
    expect(block.failed_count).toBe(0);
  });
});
