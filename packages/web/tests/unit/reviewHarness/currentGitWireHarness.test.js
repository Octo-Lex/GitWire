// CurrentGitWireHarness (RI-9 Phase 9, Arm A) — the current orchestration's
// characteristics on the shared RepositoryTools substrate: seeded context,
// 8-round loop, forced submit_review_result with fallback + narration
// retry, identical budgets and fail-closed behavior. Drives the REAL
// provider client (pi-ai completeSimple) through the deterministic fake —
// zero paid calls.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createCurrentGitWireHarness } from "../../../src/lib/reviewHarness/currentGitWire/currentGitWireHarness.js";
import { buildFirstOrderSeeds } from "../../../src/lib/reviewHarness/currentGitWire/seeder.js";
import { buildSnapshotSource } from "../repositoryTools/helpers.js";
import { startFakeProvider } from "./helpers.js";

const CHANGED_FILES = [
  { filename: "src/worker.js", patch: "@@ -1 +1 @@\n-import { mark } from \"./markers.js\";\n+import { mark, find } from \"./markers.js\";" },
];
const FILES = {
  "src/worker.js": "import { mark, find } from \"./markers.js\";\nexport function run() {\n  return find(\"x\") ?? mark(\"y\");\n}\n",
  "src/markers.js": "export function mark(id) { return `m:${id}`; }\nexport function find(id) { return null; }\n",
  "docs/guide.md": "guide\n",
};

const VALID_SUBMISSION = {
  findings: [
    { severity: "P2", claim: "find returns null for every id", evidenceRefs: ["repo-read:src/markers.js@HEAD:L2-L2"] },
  ],
  unresolvedContextRequests: [],
  approvalEvidenceComplete: false,
};

function baseTask(repositorySession, overrides = {}) {
  return {
    reviewInvocationId: "rinv-ab-a-1",
    repositorySessionId: repositorySession.id,
    repository: { owner: "org", name: "repo" },
    baseSha: repositorySession.snapshotRefs.base,
    headSha: repositorySession.snapshotRefs.head,
    reviewRoot: {
      invocationId: "rinv-ab-a-1",
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
  const base = await buildSnapshotSource({ "src/worker.js": "import { mark } from \"./markers.js\";\n" }, { ref: "ab-base" });
  const head = await buildSnapshotSource(FILES, { ref: "ab-head" });
  const repositorySession = await prepareRepository({
    invocationId: "ab-arm-a-test",
    headSha: "ab-head",
    baseSha: "ab-base",
    acquire: { mode: "snapshot", baseTree: base, headTree: head, blobs: { ...base.blobs, ...head.blobs } },
  });
  const harness = createCurrentGitWireHarness({
    model: fake.model,
    runtimeApiKey: "test-key",
    resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null),
    changedFilesProvider: async () => CHANGED_FILES,
  });
  return { fake, repositorySession, harness };
}

describe("deterministic first-order seeding", () => {
  it("seeds the changed file's in-repo import content, excluding changed files", async () => {
    const head = await buildSnapshotSource(FILES, { ref: "seed-test" });
    const repositorySession = await prepareRepository({
      invocationId: "seed-test",
      headSha: "seed-test",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    const seeds = await buildFirstOrderSeeds({ repositorySession, changedFiles: CHANGED_FILES });
    expect(seeds.map((s) => s.path)).toEqual(["src/markers.js"]);
    expect(seeds[0].content).toContain("export function mark");
    repositorySession.close();
  });
});

describe("CurrentGitWireHarness.runReview", () => {
  let fake;
  let repositorySession;
  let harness;

  afterEach(async () => {
    repositorySession?.close?.();
    await fake?.close?.();
    fake = null;
    repositorySession = null;
  });

  it("seeds, explores, then takes the forced submission turn — completed", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "read", arguments: { path: "src/markers.js" } } }, // explore
      { content: "done exploring" },                                                       // natural stop
      { toolCall: { id: "c2", name: "submit_review_result", arguments: VALID_SUBMISSION } }, // submission turn
    ]));

    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    expect(execution.terminationReason).toBe("submitted");
    expect(execution.submission.payload).toEqual(VALID_SUBMISSION);
    expect(execution.requestedHarness).toBe("current-gitwire");
    expect(execution.actualModel).toBe("fake-reviewer");
    // 3 provider calls: explore round, natural-stop round, submission turn.
    expect(fake.requests).toHaveLength(3);
    // The FIRST request carried the seeded dependency context.
    const firstUser = fake.requests[0].messages.find((m) => m.role === "user");
    const firstUserText = Array.isArray(firstUser.content) ? firstUser.content[0].text : firstUser.content;
    expect(firstUserText).toContain("Seeded dependency context");
    expect(firstUserText).toContain("src/markers.js");
    // The submission turn exposed ONLY the submit tool.
    const lastRequest = fake.requests[2];
    expect(lastRequest.tools.map((t) => t.function.name)).toEqual(["submit_review_result"]);
    // The qualified audit trace contains the model's read AND the seed reads.
    const ops = execution.toolTrace.map((e) => e.operation);
    expect(ops).toContain("read");
  });

  it("the narration-death retry recovers a submission that died at the output cap", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { content: "explore done" },                                     // natural stop
      { content: "Let me tell you about this review...".repeat(400), finishReason: "length" }, // narration death
      { toolCall: { id: "c2", name: "submit_review_result", arguments: VALID_SUBMISSION } },    // retry succeeds
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    expect(execution.submissionDiagnostics.submissionRetried).toBe(true);
    expect(execution.submissionDiagnostics.usedSubmitTool).toBe(true);
    expect(fake.requests).toHaveLength(3);
  });

  it("PARTIAL and ERROR repository results reach the model unflattened", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { toolCall: { id: "c1", name: "read", arguments: { path: "src/worker.js", limit: 1 } } }, // partial
      { toolCall: { id: "c2", name: "read", arguments: { path: "../escape" } } },               // error
      { content: "stop" },
      { toolCall: { id: "c3", name: "submit_review_result", arguments: VALID_SUBMISSION } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("completed");
    const texts = fake.requests.map((r) => JSON.stringify(r));
    expect(texts.some((t) => t.includes("output_lines"))).toBe(true);
    expect(texts.some((t) => t.includes("E_PATH_ESCAPE"))).toBe(true);
  });

  it("a model that never submits ends incomplete (no_submission)", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { content: "nothing to review" },
      { content: "I decline to submit" },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.status).toBe("incomplete");
    expect(execution.terminationReason).toBe("no_submission");
    expect(execution.submission).toBeUndefined();
    expect(execution.submissionDiagnostics.usedSubmitTool).toBe(false);
  });

  it("deadline and identity mismatch fail closed with zero or bounded provider calls", async () => {
    ({ fake, repositorySession, harness } = await setup([{ hang: true }]));
    const deadline = await harness.runReview(baseTask(repositorySession, { deadlineMs: 1500 }));
    expect(deadline.status).toBe("incomplete");
    expect(deadline.terminationReason).toBe("deadline_exceeded");
    await fake.close();

    ({ fake, repositorySession, harness } = await setup([{ content: "unused" }]));
    const mismatch = await harness.runReview({
      ...baseTask(repositorySession),
      headSha: "deadbeef",
      reviewRoot: { baseSha: "x", headSha: "deadbeef" },
    });
    expect(mismatch.status).toBe("error");
    expect(mismatch.error.code).toBe("E_IDENTITY_MISMATCH");
    expect(fake.requests).toHaveLength(0);
  });

  it("cost and tool-call budgets abort with budget_exceeded", async () => {
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

  it("usage records all four token categories with all-in cost", async () => {
    ({ fake, repositorySession, harness } = await setup([
      { content: "stop" },
      { toolCall: { id: "c1", name: "submit_review_result", arguments: VALID_SUBMISSION } },
    ]));
    const execution = await harness.runReview(baseTask(repositorySession));
    expect(execution.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      cacheReadTokens: expect.any(Number),
      cacheWriteTokens: expect.any(Number),
      totalTokens: expect.any(Number),
    });
  });
});
