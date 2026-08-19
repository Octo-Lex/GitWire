// Pi adapter qualification gate (RI-9 amendment, Phase 8, Commit 5).
//
// Mechanically proves the adapter over ONE frozen historical fixture
// (ri01/broken) plus synthetic error cases — all through the REAL Pi loop
// driven by the deterministic fake provider. ZERO paid model calls. If any
// item here fails, the paid pilot (Commit 6) does not run.
//
// Gate items: frozen ReviewTask; exact repositorySessionId; read/grep/find/
// ls work against the fixture; PARTIAL/ERROR survive to the MODEL's eyes;
// repository content cannot invoke write/bash/edit; repo AGENTS.md is not
// loaded as Pi configuration; submit_review terminates; duplicates ignored;
// invalid submission fails closed; crash fails closed; timeout fails
// closed; requested/actual identity recorded; tool trace reconstructable;
// no mutation credential anywhere.

import { createPiHarness } from "../../../src/lib/reviewHarness/pi/piHarness.js";
import { validateReviewTask } from "../../../src/lib/reviewHarness/reviewHarness.js";
import { sessionForFixture, loadFixture, closeAllFixtureSessions } from "./fixtures/fixtureGitMaterializer.js";
import { startFakeProvider } from "../../unit/reviewHarness/helpers.js";

const PROVIDER_KEY = "pi-provider-key-canary";

function fixtureTask(fixture, repositorySessionId, overrides = {}) {
  return {
    reviewInvocationId: "rinv-pi-qual",
    repositorySessionId,
    repository: { owner: "org", name: fixture.source.repo },
    baseSha: fixture.source.base,
    headSha: fixture.source.head,
    reviewRoot: { invocationId: "rinv-pi-qual", baseSha: fixture.source.base, headSha: fixture.source.head },
    objective: "Review the changed documentation for contradictory status declarations.",
    findingSchema: { name: "gitwire-findings", version: "2" },
    deadlineMs: 60000,
    budget: { maxToolCalls: 40 },
    ...overrides,
  };
}

async function qualify(turns, taskOverrides = {}) {
  const fixture = loadFixture("ri01", "broken");
  const repositorySession = await sessionForFixture(fixture);
  const fake = await startFakeProvider({ turns, modelName: "fake-qualifier" });
  const harness = createPiHarness({
    model: fake.model,
    runtimeApiKey: PROVIDER_KEY,
    resolveRepositorySession: (id) => (id === repositorySession.id ? repositorySession : null),
  });
  const task = fixtureTask(fixture, repositorySession.id, taskOverrides);
  const execution = await harness.runReview(task);
  return { fixture, repositorySession, fake, harness, task, execution };
}

afterAll(() => {
  closeAllFixtureSessions();
});

/** All message payloads the provider ever received, flattened to strings. */
function allRequestText(fake) {
  return fake.requests.map((r) => JSON.stringify(r));
}

describe("adapter qualification — happy path over the frozen ri01/broken fixture", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await qualify([
      { toolCall: { id: "c1", name: "grep", arguments: { pattern: "reopened", literal: true } } },
      { toolCall: { id: "c2", name: "read", arguments: { path: "README.md", offset: 11, limit: 1 } } },
      { toolCall: { id: "c3", name: "read", arguments: { path: "README.md", limit: 1 } } },        // PARTIAL window
      { toolCall: { id: "c4", name: "read", arguments: { path: "../escape" } } },                   // ERROR
      { toolCall: { id: "c5", name: "find", arguments: { glob: "docs/*.md" } } },
      { toolCall: { id: "c6", name: "ls", arguments: { path: "docs" } } },
      { toolCall: { id: "c7", name: "bash", arguments: { command: "cat /etc/passwd" } } },          // must be refused
      {
        toolCall: {
          id: "c8",
          name: "submit_review",
          arguments: {
            findings: [
              {
                severity: "P2",
                claim: "README declares Phase 0.0 reopened while the spec closes it",
                evidenceRefs: ["repo-read:README.md@HEAD:L11-L11"],
              },
            ],
            unresolvedContextRequests: [],
            approvalEvidenceComplete: false,
          },
        },
      },
    ]);
  }, 120000);

  afterAll(async () => {
    await ctx?.fake?.close?.();
  });

  it("starts from a frozen, valid ReviewTask bound to the exact repository session", () => {
    expect(validateReviewTask(ctx.task)).toEqual({ ok: true, errors: [] });
    expect(ctx.execution.requestedHarness).toBe("pi");
    expect(ctx.execution.actualHarness).toBe("pi");
    // The task's identity reached the provider as the system frame.
    const first = ctx.fake.requests[0];
    const system = first.messages.find((m) => m.role === "system");
    expect(system.content).toContain(ctx.task.repository.name);
    expect(system.content).toContain(ctx.task.headSha);
    const user = first.messages.find((m) => m.role === "user");
    const userText = Array.isArray(user.content) ? user.content.map((c) => c.text ?? "").join(" ") : user.content;
    expect(userText).toContain(ctx.task.objective);
  });

  it("read/grep/find/ls work against the fixture's qualified truth", () => {
    const texts = allRequestText(ctx.fake);
    // grep found the oracle fact at the broken head
    expect(texts.some((t) => t.includes("README.md") && t.includes("reopened"))).toBe(true);
    // read returned the exact oracle line 11
    expect(texts.some((t) => t.includes("**Status:** Phase 0.0"))).toBe(true);
    // find listed the docs tree
    expect(texts.some((t) => t.includes("docs/roadmap.md"))).toBe(true);
    // ls listed the docs directory (quotes are escaped inside the request JSON)
    expect(texts.some((t) => t.includes("constitution.md"))).toBe(true);
  });

  it("PARTIAL and ERROR survive into what the MODEL sees — never flattened", () => {
    const texts = allRequestText(ctx.fake);
    expect(texts.some((t) => t.includes('\\"status\\":\\"partial\\"') || t.includes('"status":"partial"'))).toBe(true);
    expect(texts.some((t) => t.includes("output_lines"))).toBe(true);
    expect(texts.some((t) => t.includes("E_PATH_ESCAPE"))).toBe(true);
  });

  it("repository content cannot invoke write/bash/edit — the call is refused, nothing executes", () => {
    const texts = allRequestText(ctx.fake);
    // The bash attempt was answered with an error result...
    const bashAnswered = texts.some((t) => t.toLowerCase().includes("bash") && (t.toLowerCase().includes("error") || t.toLowerCase().includes("not found") || t.toLowerCase().includes("not available") || t.toLowerCase().includes("unknown")));
    expect(bashAnswered).toBe(true);
    // ...and the qualified audit trace contains ONLY repository-tool ops.
    const ops = new Set(ctx.execution.toolTrace.map((e) => e.operation));
    expect([...ops].every((op) => ["read", "grep", "find", "ls"].includes(op))).toBe(true);
    expect(ctx.execution.toolTrace).not.toContainEqual(expect.objectContaining({ operation: "bash" }));
  });

  it("repo AGENTS.md is not loaded as Pi configuration — one GitWire system message only", () => {
    for (const request of ctx.fake.requests) {
      const systems = request.messages.filter((m) => m.role === "system");
      expect(systems).toHaveLength(1);
      expect(systems[0].content.startsWith("You are GitWire's coding reviewer.")).toBe(true);
    }
  });

  it("submit_review terminates the session — exactly the scripted provider turns happened", () => {
    expect(ctx.execution.status).toBe("completed");
    expect(ctx.execution.terminationReason).toBe("submitted");
    expect(ctx.execution.submission.submitAttempts).toBe(1);
    // 8 scripted turns (grep, 3×read, find, ls, bash-refused, submit) — one
    // provider request each, and NOT ONE more after submit_review: the
    // terminate flag ends the loop before any additional turn.
    expect(ctx.fake.requests).toHaveLength(8);
  });

  it("requested vs actual provider/model identity is recorded", () => {
    expect(ctx.execution.requestedProvider).toBe("faketest");
    expect(ctx.execution.actualProvider).toBe("faketest");
    expect(ctx.execution.requestedModel).toBe("fake-qualifier");
    expect(ctx.execution.actualModel).toBe("fake-qualifier");
    expect(ctx.harness.version).toMatch(/^(0\.\d+\.\d+|unknown)$/);
    expect(ctx.harness.promptVersion).toBe("pi-phase8-v1");
  });

  it("the tool trace is reconstructable — every scripted call, in order", () => {
    const ops = ctx.execution.toolTrace.map((e) => e.operation);
    expect(ops).toEqual(["grep", "read", "read", "read", "find", "ls"]);
    expect(ctx.execution.toolTrace).toEqual(ctx.repositorySession.auditTrace());
  });

  it("no mutation credential exists anywhere in the adapter's traffic", () => {
    for (const text of allRequestText(ctx.fake)) {
      expect(text).not.toContain("github.com");
      expect(text).not.toContain("x-github");
      // The repository session (snapshot mode) has no credential surface at all.
      expect(text).not.toContain("ghp_");
    }
  });
});

describe("adapter qualification — fail-closed modes", () => {
  let fake;

  afterEach(async () => {
    await fake?.close?.();
    fake = null;
  });

  it("invalid submission that is never recovered fails closed (incomplete, no submission)", async () => {
    const ctx = await qualify([
      {
        toolCall: {
          id: "c-bad",
          name: "submit_review",
          arguments: {
            findings: [{ severity: "P2", claim: "", evidenceRefs: [] }],
            unresolvedContextRequests: [],
            approvalEvidenceComplete: false,
          },
        },
      },
      { content: "I give up." },
    ]);
    fake = ctx.fake;
    expect(ctx.execution.status).toBe("incomplete");
    expect(ctx.execution.terminationReason).toBe("no_submission");
    expect(ctx.execution.submission).toBeUndefined();
  }, 120000);

  it("provider crash fails closed (error execution)", async () => {
    const ctx = await qualify([{ error: { status: 502, message: "upstream exploded" } }]);
    fake = ctx.fake;
    expect(ctx.execution.status).toBe("error");
    expect(ctx.execution.terminationReason).toBe("provider_error");
    expect(ctx.execution.submission).toBeUndefined();
  }, 120000);

  it("hanging provider + deadline fails closed (deadline_exceeded)", async () => {
    const ctx = await qualify([{ hang: true }], { deadlineMs: 3000 });
    fake = ctx.fake;
    expect(ctx.execution.status).toBe("incomplete");
    expect(ctx.execution.terminationReason).toBe("deadline_exceeded");
    expect(ctx.execution.submission).toBeUndefined();
  }, 120000);

  it("a FABRICATED reference (syntactically valid, never observed) cannot pass evidence verification", async () => {
    // The model submits a well-formed ref without ever reading the file.
    // The harness accepts the submission (it is data); the PILOT-side
    // verification must then reject the evidence: no covering read exists
    // in the audit trace, so the non-circular proof fails closed.
    const ctx = await qualify([
      {
        toolCall: {
          id: "c-fab",
          name: "submit_review",
          arguments: {
            findings: [
              {
                severity: "P2",
                claim: "fabricated claim citing a file I never opened",
                evidenceRefs: ["repo-read:docs/roadmap.md@HEAD:L1-L5"],
              },
            ],
            unresolvedContextRequests: [],
            approvalEvidenceComplete: false,
          },
        },
      },
    ]);
    fake = ctx.fake;
    expect(ctx.execution.status).toBe("completed"); // submission accepted as DATA...
    const { verifySubmissionEvidence, brokerReconstruct } = await import("../../../src/services/piSubmissionVerificationService.js");
    const { createContextBroker } = await import("../../../src/services/reviewContextBroker.js");
    const { buildFixtureOctokit } = await import("./fixtureOctokit.js");
    const broker = createContextBroker({
      octokit: buildFixtureOctokit(ctx.fixture),
      owner: "org",
      repo: "repo",
      baseSha: ctx.fixture.source.base,
      headSha: ctx.fixture.source.head,
    });
    const verification = await verifySubmissionEvidence({
      submission: ctx.execution.submission.payload,
      repositorySession: ctx.repositorySession,
      toolTrace: ctx.execution.toolTrace,
      reconstruct: brokerReconstruct(broker, ctx.fixture.source.head),
    });
    // ...but the evidence never verifies.
    expect(verification.evidenceComplete).toBe(false);
    const ref = verification.findings[0].refs[0];
    expect(ref.evidenceIncompleteReason).toBe("no_observed_covering_read");
    expect(ref.reconciliation).toBeUndefined();
  }, 120000);
});
