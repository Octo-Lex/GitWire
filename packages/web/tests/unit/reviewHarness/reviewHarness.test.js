// ReviewHarness boundary types (RI-9 Phase 8, Commit 1) — validation and
// execution invariants. No harness SDK is imported here: the boundary must
// stay GitWire-domain only.

import {
  validateReviewTask,
  makeReviewExecution,
  createReviewHarnessRegistry,
  ReviewHarnessError,
} from "../../../src/lib/reviewHarness/reviewHarness.js";

const VALID_TASK = {
  reviewInvocationId: "rinv-1",
  repositorySessionId: "sess-1",
  repository: { owner: "org", name: "repo" },
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  reviewRoot: { invocationId: "rinv-1", baseSha: "b".repeat(40), headSha: "a".repeat(40) },
  objective: "Review the changed files for correctness defects.",
  findingSchema: { name: "gitwire-findings", version: "2" },
  deadlineMs: 300000,
  budget: { maxTotalTokens: 100000, maxCostUsd: 1, maxToolCalls: 60 },
};

describe("validateReviewTask", () => {
  it("accepts a complete task", () => {
    expect(validateReviewTask(VALID_TASK)).toEqual({ ok: true, errors: [] });
  });

  it.each([
    ["reviewInvocationId", (t) => delete t.reviewInvocationId],
    ["repositorySessionId", (t) => delete t.repositorySessionId],
    ["repository", (t) => delete t.repository],
    ["baseSha", (t) => delete t.baseSha],
    ["headSha", (t) => delete t.headSha],
    ["reviewRoot", (t) => delete t.reviewRoot],
    ["objective", (t) => delete t.objective],
    ["findingSchema", (t) => delete t.findingSchema],
    ["deadlineMs", (t) => delete t.deadlineMs],
    ["budget", (t) => delete t.budget],
  ])("rejects a task missing %s", (_field, mutate) => {
    const task = JSON.parse(JSON.stringify(VALID_TASK));
    mutate(task);
    const { ok, errors } = validateReviewTask(task);
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes(_field))).toBe(true);
  });

  it("rejects invalid deadline and budget values", () => {
    expect(validateReviewTask({ ...VALID_TASK, deadlineMs: 0 }).ok).toBe(false);
    expect(validateReviewTask({ ...VALID_TASK, budget: { maxToolCalls: -1 } }).ok).toBe(false);
    expect(validateReviewTask(null).ok).toBe(false);
  });
});

describe("makeReviewExecution invariants", () => {
  const base = {
    status: "completed",
    requestedHarness: "pi",
    actualHarness: "pi",
    requestedProvider: "faketest",
    actualProvider: "faketest",
    requestedModel: "fake-reviewer",
    actualModel: "fake-reviewer",
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
    submission: { findings: [], approvalEvidenceComplete: false },
    terminationReason: "submitted",
  };

  it("builds a frozen completed execution", () => {
    const execution = makeReviewExecution(base);
    expect(execution.status).toBe("completed");
    expect(execution.submission).toBeDefined();
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.toolTrace)).toBe(true);
  });

  it("completed without submission is impossible", () => {
    const { submission, ...noSubmission } = base;
    expect(() => makeReviewExecution(noSubmission)).toThrow(ReviewHarnessError);
  });

  it("incomplete requires a terminationReason and tolerates no submission", () => {
    const execution = makeReviewExecution({
      ...base,
      status: "incomplete",
      terminationReason: "deadline_exceeded",
      submission: undefined,
    });
    expect(execution.submission).toBeUndefined();
    expect(() =>
      makeReviewExecution({ ...base, status: "incomplete", submission: undefined })
    ).toThrow(ReviewHarnessError);
  });

  it("error requires error.code and forbids a submission", () => {
    const execution = makeReviewExecution({
      ...base,
      status: "error",
      terminationReason: "provider_error",
      submission: undefined,
      error: { code: "E_PROVIDER", message: "boom" },
    });
    expect(execution.error.code).toBe("E_PROVIDER");
    expect(() =>
      makeReviewExecution({ ...base, status: "error", submission: base.submission, error: { code: "E", message: "x" } })
    ).toThrow(ReviewHarnessError);
    expect(() => makeReviewExecution({ ...base, status: "error", submission: undefined })).toThrow(ReviewHarnessError);
  });

  it("unknown status or reason is rejected", () => {
    expect(() => makeReviewExecution({ ...base, status: "maybe" })).toThrow(ReviewHarnessError);
    expect(() => makeReviewExecution({ ...base, terminationReason: "gave_up" })).toThrow(ReviewHarnessError);
  });
});

describe("harness registry", () => {
  it("registers and resolves by name; rejects malformed harnesses", () => {
    const registry = createReviewHarnessRegistry();
    registry.register({ name: "pi", runReview: async () => {} });
    expect(registry.get("pi").name).toBe("pi");
    expect(registry.get("nope")).toBeNull();
    expect(registry.names()).toEqual(["pi"]);
    expect(() => registry.register({ name: "broken" })).toThrow(ReviewHarnessError);
  });
});
