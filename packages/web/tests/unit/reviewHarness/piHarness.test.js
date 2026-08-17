// PiHarness orchestration + submit_review (RI-9 Phase 8, Commit 4) —
// end-to-end over the real Pi loop with the deterministic fake provider:
// completion, termination-on-submit, fail-closed failure modes, and the
// data-only submission contract. Zero paid calls.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createPiHarness } from "../../../src/lib/reviewHarness/pi/piHarness.js";
import { createSubmitReviewTool, validateSubmission } from "../../../src/lib/reviewHarness/pi/submitReview.js";
import { buildSnapshotSource } from "../repositoryTools/helpers.js";
import { startFakeProvider } from "./helpers.js";

const FILES = {
  "README.md": "# t\nsecond\nthird\n",
  "src/app.js": "export function main() {\n  return NEEDLE;\n}\n",
};

const VALID_SUBMISSION = {
  findings: [
    {
      severity: "P2",
      claim: "main returns NEEDLE",
      evidenceRefs: ["repo-read:src/app.js@HEAD:L2-L2"],
    },
  ],
  unresolvedContextRequests: [],
  approvalEvidenceComplete: false,
};

function baseTask(repositorySession, overrides = {}) {
  return {
    reviewInvocationId: "rinv-pi-1",
    repositorySessionId: repositorySession.id,
    repository: { owner: "org", name: "repo" },
    baseSha: repositorySession.snapshotRefs.base,
    headSha: repositorySession.snapshotRefs.head,
    reviewRoot: {
      invocationId: "rinv-pi-1",
      baseSha: repositorySession.snapshotRefs.base,
      headSha: repositorySession.snapshotRefs.head,
    },
    objective: "Review the change for correctness defects.",
    findingSchema: { name: "gitwire-findings", version: "2" },
    deadlineMs: 30000,
    budget: { maxToolCalls: 40 },
    ...overrides,
  };
}

async function setup(turns) {
  const fake = await startFakeProvider({ turns });
  const base = await buildSnapshotSource({ "README.md": "# old\n" }, { ref: "pi-harness-base" });
  const head = await buildSnapshotSource(FILES, { ref: "pi-harness-head" });
  const repositorySession = await prepareRepository({
    invocationId: "pi-harness-test",
    headSha: "pi-harness-head",
    baseSha: "pi-harness-base",
    acquire: {
      mode: "snapshot",
      baseTree: base,
      headTree: head,
      blobs: { ...base.blobs, ...head.blobs },
    },
  });
  const harness = createPiHarness({
    model: fake.model,
    runtimeApiKey: "test-key",
    resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null),
  });
  return { fake, repositorySession, harness };
}

describe("validateSubmission", () => {
  it("accepts a structurally valid payload and rejects the broken ones", () => {
    expect(validateSubmission(VALID_SUBMISSION)).toEqual({ ok: true, errors: [] });
    expect(validateSubmission({ findings: "nope" }).ok).toBe(false);
    expect(validateSubmission({ findings: [{ severity: "P9", claim: "x", evidenceRefs: [] }], unresolvedContextRequests: [], approvalEvidenceComplete: true }).ok).toBe(false);
    expect(validateSubmission({ findings: [{ severity: "P2", claim: "", evidenceRefs: [] }], unresolvedContextRequests: [], approvalEvidenceComplete: true }).ok).toBe(false);
    expect(validateSubmission({ findings: [], unresolvedContextRequests: [], approvalEvidenceComplete: "yes" }).ok).toBe(false);
  });
});

describe("submit_review tool in isolation", () => {
  it("captures exactly one valid submission; duplicates are ignored deterministically", async () => {
    const runContext = { submission: undefined, submitAttempts: 0, terminationRequested: false };
    const tool = createSubmitReviewTool(runContext);

    const first = JSON.parse((await tool.execute("c1", VALID_SUBMISSION)).content[0].text);
    expect(first.status).toBe("success");
    expect(runContext.submission.payload).toEqual(VALID_SUBMISSION);
    expect(runContext.terminationRequested).toBe(true);

    const second = JSON.parse((await tool.execute("c2", { ...VALID_SUBMISSION, approvalEvidenceComplete: true })).content[0].text);
    expect(second.status).toBe("error");
    expect(second.error.code).toBe("E_ALREADY_SUBMITTED");
    // The first submission stands, unchanged.
    expect(runContext.submission.payload.approvalEvidenceComplete).toBe(false);
    expect(runContext.submitAttempts).toBe(2);
  });

  it("a malformed submission is rejected and never captured", async () => {
    const runContext = { submission: undefined, submitAttempts: 0, terminationRequested: false };
    const tool = createSubmitReviewTool(runContext);
    const bad = JSON.parse((await tool.execute("c1", { findings: [], unresolvedContextRequests: [] })).content[0].text);
    expect(bad.status).toBe("error");
    expect(bad.error.code).toBe("E_INVALID_SUBMISSION");
    expect(runContext.submission).toBeUndefined();
    expect(runContext.terminationRequested).toBe(false);
  });
});

describe("PiHarness.runReview", () => {
  let fake;
  let repositorySession;
  let harness;

  afterEach(async () => {
    repositorySession?.close?.();
    await fake?.close?.();
    fake = null;
    repositorySession = null;
  });

  it("explores via the qualified tools, submits, and TERMINATES — no provider turn after submit_review", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "call-read", name: "read", arguments: { path: "src/app.js" } } },
      { toolCall: { id: "call-submit", name: "submit_review", arguments: VALID_SUBMISSION } },
      { content: "THIS TURN MUST NEVER HAPPEN" },
    ]));

    const execution = await harness.runReview(baseTask(repositorySession));

    expect(execution.status).toBe("completed");
    expect(execution.terminationReason).toBe("submitted");
    expect(execution.submission.payload).toEqual(VALID_SUBMISSION);
    expect(execution.submission.submitAttempts).toBe(1);
    // Termination proof: the scripted third turn was never requested.
    expect(fake.requests).toHaveLength(2);
    // The repository tool call is in the qualified audit trace.
    expect(execution.toolTrace.some((e) => e.operation === "read" && e.params.path === "src/app.js")).toBe(true);
    // Identity recording: requested vs actual.
    expect(execution.requestedHarness).toBe("pi");
    expect(execution.actualHarness).toBe("pi");
    expect(execution.requestedModel).toBe("fake-reviewer");
    expect(execution.actualModel).toBe("fake-reviewer");
    expect(execution.usage.totalTokens).toBeGreaterThan(0);
  });

  it("an invalid submission is reported to the model and NOT captured; recovery still completes", async () => {
    ({ fake, repositorySession, harness } = await setup([
      // Structurally-valid at the TypeBox level but fails semantic
      // validation (empty claim) — reaches execute and is rejected there.
      {
        toolCall: {
          id: "call-bad",
          name: "submit_review",
          arguments: {
            findings: [{ severity: "P2", claim: "", evidenceRefs: ["repo-read:src/app.js@HEAD:L2-L2"] }],
            unresolvedContextRequests: [],
            approvalEvidenceComplete: false,
          },
        },
      },
      { toolCall: { id: "call-good", name: "submit_review", arguments: VALID_SUBMISSION } },
    ]));

    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    expect(execution.submission.payload).toEqual(VALID_SUBMISSION);
    expect(execution.submission.submitAttempts).toBe(2);
  });

  it("schema-level rejection (missing required fields) never reaches execute and never captures", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "call-schema-bad", name: "submit_review", arguments: { findings: [], unresolvedContextRequests: [] } } },
      { toolCall: { id: "call-good", name: "submit_review", arguments: VALID_SUBMISSION } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    // The schema-rejected call never invoked the tool; only the valid one counts.
    expect(execution.submission.submitAttempts).toBe(1);
  });

  it("a model that never submits ends incomplete — approval stays impossible", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { content: "I looked around and stopped." },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("no_submission");
    expect(execution.submission).toBeUndefined();
  });

  it("deadline expiry aborts and records deadline_exceeded with no submission", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { content: "slow turn" },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession, { deadlineMs: 1 }));
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("deadline_exceeded");
    expect(execution.submission).toBeUndefined();
  });

  it("a provider failure records provider_error — never a silent completion", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { error: { status: 500, message: "scripted provider failure" } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("error");
    expect(execution.terminationReason).toBe("provider_error");
    expect(execution.error.message).toContain("scripted provider failure");
    expect(execution.submission).toBeUndefined();
  });

  it("invalid tasks and missing repository sessions return error executions without starting a session", async () => {
    ({ fake, repositorySession, harness } = await setup([{ content: "unused" }]));
    const invalid = await harness.runReview({ nope: true });
    expect(invalid.status).toBe("error");
    expect(invalid.error.code).toBe("E_INVALID_TASK");
    expect(fake.requests).toHaveLength(0);

    const missingTask = baseTask(repositorySession);
    const missing = await harness.runReview({ ...missingTask, repositorySessionId: "no-such-session" });
    expect(missing.status).toBe("error");
    expect(missing.error.code).toBe("E_SESSION_UNAVAILABLE");
    expect(fake.requests).toHaveLength(0);
  });

  it("identity mismatch between task/reviewRoot/session is rejected with ZERO provider calls", async () => {
    ({ fake, repositorySession, harness } = await setup([{ content: "unused" }]));
    const task = baseTask(repositorySession);

    // Wrong HEAD on the task (and root).
    const wrongHead = await harness.runReview({
      ...task,
      headSha: "deadbeef",
      reviewRoot: { ...task.reviewRoot, headSha: "deadbeef" },
    });
    expect(wrongHead.status).toBe("error");
    expect(wrongHead.error.code).toBe("E_IDENTITY_MISMATCH");
    expect(wrongHead.error.message).toContain("HEAD:");
    expect(fake.requests).toHaveLength(0);

    // HEAD agrees but the review root disagrees.
    const rootMismatch = await harness.runReview({
      ...task,
      reviewRoot: { ...task.reviewRoot, baseSha: "deadbeef" },
    });
    expect(rootMismatch.error.code).toBe("E_IDENTITY_MISMATCH");
    expect(rootMismatch.error.message).toContain("reviewRoot:");
    expect(fake.requests).toHaveLength(0);

    // Session carries no base identity at all.
    const baseless = { ...repositorySession, snapshotRefs: { base: null, head: repositorySession.snapshotRefs.head } };
    const harness2 = createPiHarness({
      model: fake.model,
      runtimeApiKey: "test-key",
      resolveRepositorySession: (id) => (id === "baseless-session" ? baseless : null),
    });
    const noBaseExecution = await harness2.runReview({ ...task, repositorySessionId: "baseless-session" });
    expect(noBaseExecution.error.code).toBe("E_IDENTITY_MISMATCH");
    expect(noBaseExecution.error.message).toContain("BASE:");
    expect(fake.requests).toHaveLength(0);

    // A matching run still works after all these rejections.
    const ok = await harness.runReview(task);
    expect(ok.status).not.toBe("error");
    expect(fake.requests).toHaveLength(1);
  });

  it("tool-call budget overrun aborts with budget_exceeded", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "ls", arguments: {} } },
      { toolCall: { id: "c2", name: "ls", arguments: {} } },
      { toolCall: { id: "c3", name: "ls", arguments: {} } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession, { budget: { maxToolCalls: 2 } }));
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("budget_exceeded");
    expect(execution.submission).toBeUndefined();
  });

  it("A TURN THAT BOTH SUBMITS AND CROSSES THE BUDGET is budget_exceeded — never completed (Arm A parity)", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "ls", arguments: {} } },
      { toolCall: { id: "c2", name: "submit_review", arguments: VALID_SUBMISSION } },
    ]));
    // Each fake turn reports 18 total tokens; a 30-token cap crosses exactly
    // on the submit turn's assistant message.
    const execution = await harness.runReview(
      baseTask(repositorySession, { budget: { maxTotalTokens: 30 } })
    );
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("budget_exceeded");
    expect(execution.status).not.toBe("completed");
    // If the submission was captured before the loop ended, it is preserved
    // for audit and explicitly marked as captured on the crossing.
    if (execution.submission !== undefined) {
      expect(execution.submission.capturedOnBudgetCrossing).toBe(true);
    }
  });

  it("usage records every token category and the ALL-IN cost (input+output+cache)", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "ls", arguments: {} } },
      { toolCall: { id: "c2", name: "submit_review", arguments: VALID_SUBMISSION } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    expect(execution.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      cacheWriteTokens: expect.any(Number),
      totalTokens: expect.any(Number),
      costUsd: expect.any(Number),
    });
    // The fake provider reports 12 input + 6 output per turn; cost must be
    // computed from the model's rates (which are zero in the fake).
    expect(execution.usage.inputTokens).toBeGreaterThanOrEqual(24);
    expect(execution.usage.costUsd).toBe(0);
  });

  it("maxCostUsd exhaustion aborts with budget_exceeded — dollars are a hard cap", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "ls", arguments: {} } },
      { toolCall: { id: "c2", name: "ls", arguments: {} } },
      { toolCall: { id: "c3", name: "submit_review", arguments: VALID_SUBMISSION } },
    ]));
    // Price the fake model like an expensive real one: $50/M input tokens.
    // Each turn reports 12 input + 6 output → ≈$0.0006+ per turn; a cap of
    // $0.001 is exhausted during the second turn.
    fake.model.cost = { input: 50, output: 50, cacheRead: 5, cacheWrite: 10 };
    const execution = await harness.runReview(
      baseTask(repositorySession, { budget: { maxCostUsd: 0.001 } })
    );
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("budget_exceeded");
    expect(execution.submission).toBeUndefined();
    expect(execution.usage.costUsd).toBeGreaterThan(0.001);
  });
});
