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
const mockJobCounts = { failed: null }; // when set, returned by getJobCounts

const triageQueue = {
  getFailed: jest.fn(async () => [...mockFailedJobs]),
  getActive: jest.fn(async () => [...mockActiveJobs]),
  getWaiting: jest.fn(async () => [...mockWaitingJobs]),
  getJob: jest.fn(async (id) => mockJobMap.get(id) ?? null),
  getJobCounts: jest.fn(async () =>
    mockJobCounts.failed !== null
      ? { failed: mockJobCounts.failed, active: mockActiveJobs.length, waiting: mockWaitingJobs.length }
      : null,
  ),
};

// GitHub current-target mock (TD-01 retry re-read)
const mockGitHubTarget = { value: { state: "open", id: 555, number: 42, title: "Fresh title" } };
const mockGitHubError = { value: null }; // set to an Error to simulate read failure
const mockGitHubRequest = jest.fn(async () => {
  if (mockGitHubError.value) throw mockGitHubError.value;
  return { data: mockGitHubTarget.value };
});
const mockGetInstallationClient = jest.fn(async () => ({ request: mockGitHubRequest }));

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
      ...(overrides.disposition ? { gitwireDisposition: overrides.disposition } : {}),
    },
    retry: jest.fn(async () => {}),
    updateData: jest.fn(async function (d) { this.data = d; }),
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

// GitHub mocks (TD-01 retry current-target re-read)
await jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: mockGetInstallationClient,
}));
await jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: (c) => c,
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
  mockJobCounts.failed = null;
  mockGitHubTarget.value = { state: "open", id: 555, number: 42, title: "Fresh title" };
  mockGitHubError.value = null;
  jest.clearAllMocks();
  mockIsOperationComplete.mockResolvedValue(false);
  mockLogDecision.mockResolvedValue(undefined);
  mockAuthorize.mockResolvedValue({ allowed: true, code: "permission_granted", principalId: "test-principal-uuid" });
  triageQueue.getFailed.mockImplementation(async () => [...mockFailedJobs]);
  triageQueue.getActive.mockImplementation(async () => [...mockActiveJobs]);
  triageQueue.getWaiting.mockImplementation(async () => [...mockWaitingJobs]);
  triageQueue.getJobCounts.mockImplementation(async () =>
    mockJobCounts.failed !== null
      ? { failed: mockJobCounts.failed, active: mockActiveJobs.length, waiting: mockWaitingJobs.length }
      : null,
  );
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
      "disposition",
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
    // Must only contain: status, counts, and timestamps — nothing identifying
    expect(Object.keys(block).sort()).toEqual([
      "actionable_failed_count",
      "disposed_failed_count",
      "failed_count",
      "oldest_actionable_failure_at",
      "oldest_failure_at",
      "status",
    ]);
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

// ── TD-01: disposition persistence + audit ──────────────────────────────────
describe("TD-01 POST /api/triage/failures/:jobId/disposition", () => {
  it("sets each of the four states with audit + persisted metadata", async () => {
    for (const state of ["unresolved", "recovered", "superseded", "dismissed"]) {
      const job = makeFailedJob({ disposition: state === "unresolved" ? undefined : { state: "unresolved", reason: "was unresolved", at: "2026-01-01T00:00:00Z" } });
      const app = buildApp();
      const res = await supertest(app)
        .post(`/api/triage/failures/${job.id}/disposition`)
        .send({ state, reason: `operator accepts ${state}`, actor: "attacker" });
      expect(res.statusCode).toBe(200);
      expect(res.body.disposition.state).toBe(state);
      // Persisted on retained job data — never deleted
      expect(job.data.gitwireDisposition.state).toBe(state);
      expect(job.data.gitwireDisposition.reason).toBe(`operator accepts ${state}`);
      expect(job.data.gitwireDisposition.principalId).toBe("test-principal-uuid");
      // Audited: source triage-disposition, principal from req.auth
      const call = mockLogDecision.mock.calls.find((c) => c[0]?.source === "triage-disposition" && c[0]?.decision === `disposition-${state}`);
      expect(call).toBeTruthy();
      expect(call[0].principalId).toBe("test-principal-uuid");
      expect(call[0].principalId).not.toBe("attacker");
      expect(mockFailedJobs).toContain(job); // still retained in failed set
    }
  });

  it("rejects invalid state → 400", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/disposition`).send({ state: "vanished", reason: "some reason" });
    expect(res.statusCode).toBe(400);
    expect(job.data.gitwireDisposition).toBeUndefined();
  });

  it("rejects missing or too-short reason → 400", async () => {
    const job = makeFailedJob();
    const app = buildApp();
    const r1 = await supertest(app).post(`/api/triage/failures/${job.id}/disposition`).send({ state: "dismissed", reason: "" });
    const r2 = await supertest(app).post(`/api/triage/failures/${job.id}/disposition`).send({ state: "dismissed", reason: "ok" });
    expect(r1.statusCode).toBe(400);
    expect(r2.statusCode).toBe(400);
  });

  it("unknown job → 404; denied authorization → 403", async () => {
    const app = buildApp();
    const r404 = await supertest(app).post("/api/triage/failures/424242/disposition").send({ state: "dismissed", reason: "not found test" });
    expect(r404.statusCode).toBe(404);

    const job = makeFailedJob();
    mockAuthorize.mockResolvedValue({ allowed: false, code: "permission_missing" });
    const r403 = await supertest(app).post(`/api/triage/failures/${job.id}/disposition`).send({ state: "dismissed", reason: "deny test" });
    expect(r403.statusCode).toBe(403);
    expect(job.data.gitwireDisposition).toBeUndefined();
  });
});

// ── TD-01: disposition filter on the failure list ───────────────────────────
describe("TD-01 GET /api/triage/failures?disposition=", () => {
  it("filters by disposition state and reports it per entry", async () => {
    makeFailedJob({ id: "a1", gitwireFailure: { failureClass: "invalid_provider_response", retryable: true, safeMessage: "malformed JSON", firstFailedAt: "2026-08-06T14:20:42Z" } });
    makeFailedJob({ id: "a2", disposition: { state: "dismissed", reason: "handled already", at: "2026-09-01T00:00:00Z" } });
    makeFailedJob({ id: "a3", disposition: { state: "superseded", reason: "PR merged", at: "2026-09-01T00:00:00Z" } });

    const app = buildApp();
    const open = await supertest(app).get("/api/triage/failures?disposition=unresolved");
    expect(open.body.data.map((d) => d.job_id)).toEqual(["a1"]);
    expect(open.body.data[0].disposition.state).toBe("unresolved");

    const dismissed = await supertest(app).get("/api/triage/failures?disposition=dismissed");
    expect(dismissed.body.data.map((d) => d.job_id)).toEqual(["a2"]);
    expect(dismissed.body.data[0].disposition.reason).toBe("handled already");

    // retryable_now flips to false for disposed entries
    const r = await supertest(app).get("/api/triage/failures");
    const byId = Object.fromEntries(r.body.data.map((d) => [d.job_id, d]));
    expect(byId.a1.retryable_now).toBe(true);
    expect(byId.a2.retryable_now).toBe(false);
    expect(byId.a3.retryable_now).toBe(false);
  });
});

// ── TD-01: health semantics — actionable counts only ────────────────────────
describe("TD-01 health: actionable vs disposed counts", () => {
  it("mixed backlog: degraded iff unresolved present; counts split", async () => {
    makeFailedJob({ id: "h1", gitwireFailure: { failureClass: "x", safeMessage: "m", firstFailedAt: "2026-08-20T00:00:00Z" } });
    makeFailedJob({ id: "h2", disposition: { state: "dismissed", reason: "done", at: "2026-09-01T00:00:00Z" } });
    makeFailedJob({ id: "h3", disposition: { state: "superseded", reason: "merged", at: "2026-09-01T00:00:00Z" } });

    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("degraded");
    expect(block.failed_count).toBe(3);
    expect(block.actionable_failed_count).toBe(1);
    expect(block.disposed_failed_count).toBe(2);
    expect(block.oldest_actionable_failure_at).toBe("2026-08-20T00:00:00.000Z");
  });

  it("fully disposed backlog → healthy with retained history", async () => {
    makeFailedJob({ id: "d1", disposition: { state: "dismissed", reason: "done", at: "2026-09-01T00:00:00Z" } });
    makeFailedJob({ id: "d2", disposition: { state: "recovered", reason: "later success", at: "2026-09-01T00:00:00Z" } });
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("healthy");
    expect(block.failed_count).toBe(2);
    expect(block.actionable_failed_count).toBe(0);
    expect(block.disposed_failed_count).toBe(2);
    expect(block.oldest_actionable_failure_at).toBeNull();
  });

  it("default-absent disposition is unresolved (fail-safe)", async () => {
    makeFailedJob(); // no gitwireDisposition at all
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("degraded");
    expect(block.actionable_failed_count).toBe(1);
  });

  it("malformed disposition metadata is unresolved (fail-safe)", async () => {
    makeFailedJob({ disposition: { state: "banana" } });
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.status).toBe("degraded");
    expect(block.actionable_failed_count).toBe(1);
  });

  it("bounded window: failures beyond the inspection bound count as actionable", async () => {
    // 501 unresolved failures; the inspection window returns only 500.
    for (let i = 0; i < 501; i++) {
      makeFailedJob({ id: `w${i}`, addToFailed: false });
    }
    const all = [...mockJobMap.values()];
    mockFailedJobs.push(...all.slice(0, 500)); // simulate the 500-job window
    mockJobCounts.failed = 501; // true total from the counter

    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.failed_count).toBe(501);
    expect(block.actionable_failed_count).toBe(501); // fail-safe: uninspected = actionable
    expect(block.disposed_failed_count).toBe(0);
    expect(block.status).toBe("degraded");
  });

  it("bounded window: 500 backlog with 499 disposed still degrades (1 actionable at the bound)", async () => {
    for (let i = 0; i < 500; i++) {
      makeFailedJob({
        id: `b${i}`,
        addToFailed: false,
        disposition: i === 0 ? undefined : { state: "dismissed", reason: "bulk evidence", at: "2026-09-01T00:00:00Z" },
      });
    }
    mockFailedJobs.push(...[...mockJobMap.values()]);
    mockJobCounts.failed = 500;

    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.failed_count).toBe(500);
    expect(block.actionable_failed_count).toBe(1);
    expect(block.disposed_failed_count).toBe(499);
    expect(block.status).toBe("degraded");
  });

  it("counter unavailable → falls back to window length (legacy behavior)", async () => {
    mockJobCounts.failed = null; // getJobCounts returns null
    makeFailedJob();
    const block = await getTriageHealthBlock({ timeoutMs: 1000 });
    expect(block.failed_count).toBe(1);
    expect(block.actionable_failed_count).toBe(1);
  });

  it("operator status summary carries the same actionable semantics", async () => {
    makeFailedJob({ disposition: { state: "superseded", reason: "merged", at: "2026-09-01T00:00:00Z" } });
    const summary = await getTriageStatusSummary({ timeoutMs: 1000 });
    expect(summary.status).toBe("healthy");
    expect(summary.failed_count).toBe(1);
    expect(summary.actionable_failed_count).toBe(0);
    expect(summary.disposed_failed_count).toBe(1);
  });
});

// ── TD-01: retry operates on the CURRENT target ─────────────────────────────
describe("TD-01 retry current-target semantics", () => {
  it("disposed failures refuse retry → 409 for all non-unresolved states", async () => {
    for (const state of ["recovered", "superseded", "dismissed"]) {
      const job = makeFailedJob({ disposition: { state, reason: "closed out", at: "2026-09-01T00:00:00Z" } });
      const app = buildApp();
      const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "try again" });
      expect(res.statusCode).toBe(409);
      expect(job.retry).not.toHaveBeenCalled();
    }
  });

  it("open target: refreshes the retained payload with the fresh GitHub object, then requeues", async () => {
    const job = makeFailedJob();
    mockGitHubTarget.value = { state: "open", id: 555, number: 42, title: "Retitled after failure", body: "current body" };
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "provider restored" });
    expect(res.statusCode).toBe(202);
    expect(job.retry).toHaveBeenCalled();
    // The re-read happened against the live GitHub route
    expect(mockGitHubRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      expect.objectContaining({ owner: "org", repo: "repo", issue_number: 42 }),
    );
    // The retained payload now carries the CURRENT target object
    expect(job.updateData).toHaveBeenCalled();
    expect(job.data.payload.issue.title).toBe("Retitled after failure");
    // The retry decision records the re-read
    const call = mockLogDecision.mock.calls.find((c) => c[0]?.source === "triage-retry");
    expect(call[0].conditions).toContainEqual({ check: "current_target_reread", result: "open" });
  });

  it("closed issue → superseded, not retried", async () => {
    const job = makeFailedJob();
    mockGitHubTarget.value = { state: "closed", id: 555, number: 42 };
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "check target" });
    expect(res.statusCode).toBe(200);
    expect(res.body.queued).toBe(false);
    expect(res.body.superseded).toBe(true);
    expect(job.retry).not.toHaveBeenCalled();
    expect(job.data.gitwireDisposition.state).toBe("superseded");
    expect(job.data.gitwireDisposition.reason).toContain("closed");
    const call = mockLogDecision.mock.calls.find((c) => c[0]?.source === "triage-disposition");
    expect(call[0].decision).toBe("disposition-superseded");
  });

  it("merged PR → superseded, not retried", async () => {
    const job = makeFailedJob({
      payload: {
        action: "opened",
        installation: { id: 11111 },
        repository: { id: 999, full_name: "org/repo" },
        pull_request: { id: 777, number: 43, additions: 10, deletions: 2 },
      },
    });
    mockGitHubTarget.value = { state: "closed", merged: true, id: 777, number: 43 };
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "check target" });
    expect(res.statusCode).toBe(200);
    expect(res.body.superseded).toBe(true);
    expect(job.retry).not.toHaveBeenCalled();
    expect(job.data.gitwireDisposition.reason).toContain("merged");
  });

  it("deleted target (404) → superseded", async () => {
    const job = makeFailedJob();
    mockGitHubError.value = Object.assign(new Error("Not Found"), { status: 404 });
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "check target" });
    expect(res.statusCode).toBe(200);
    expect(res.body.superseded).toBe(true);
    expect(job.data.gitwireDisposition.state).toBe("superseded");
    expect(job.data.gitwireDisposition.reason).toContain("no longer exists");
  });

  it("GitHub read failure (5xx) → 503, disposition stays unresolved", async () => {
    const job = makeFailedJob();
    mockGitHubError.value = Object.assign(new Error("Server Error"), { status: 500 });
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "check target" });
    expect(res.statusCode).toBe(503);
    expect(job.retry).not.toHaveBeenCalled();
    expect(job.data.gitwireDisposition).toBeUndefined(); // still unresolved
  });

  it("installation client unavailable → 503, disposition stays unresolved", async () => {
    const job = makeFailedJob();
    mockGetInstallationClient.mockRejectedValue(new Error("installation not found"));
    const app = buildApp();
    const res = await supertest(app).post(`/api/triage/failures/${job.id}/retry`).send({ reason: "check target" });
    expect(res.statusCode).toBe(503);
    expect(job.data.gitwireDisposition).toBeUndefined();
  });
});
