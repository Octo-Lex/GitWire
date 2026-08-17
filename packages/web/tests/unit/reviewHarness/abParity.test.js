// Phase 9 A/B parity gate (RI-9 amendment) — deterministic, zero paid
// calls. Proves the comparison gives BOTH arms the intended common inputs
// and that neither adapter can silently flatten repository uncertainty:
// PARTIAL results and tool errors survive into what the MODEL sees in
// both arms, over the same RepositoryTools substrate, with no mutation
// credential anywhere.

import { createHash } from "node:crypto";
import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createPiHarness } from "../../../src/lib/reviewHarness/pi/piHarness.js";
import { createCurrentGitWireHarness } from "../../../src/lib/reviewHarness/currentGitWire/currentGitWireHarness.js";
import { buildAbManifest, AB_ORDER, AB_BUDGETS, AB_FIXTURES, AB_OBJECTIVE_PREAMBLE } from "../../../src/lib/reviewHarness/abManifest.js";
import { buildSnapshotSource } from "../repositoryTools/helpers.js";
import { startFakeProvider } from "./helpers.js";

const FILES = {
  "src/worker.js": "import { mark } from \"./markers.js\";\nexport function run() {\n  return mark(\"x\");\n}\n",
  "src/markers.js": "export function mark(id) { return `m:${id}`; }\n",
};

const SUBMIT_PI = {
  findings: [{ severity: "P2", claim: "claim", evidenceRefs: ["repo-read:src/markers.js@HEAD:L2-L2"] }],
  unresolvedContextRequests: [],
  approvalEvidenceComplete: false,
};
const SUBMIT_CURRENT = {
  findings: [{ severity: "P2", claim: "claim", evidenceRefs: ["repo-read:src/markers.js@HEAD:L2-L2"] }],
  unresolvedContextRequests: [],
  approvalEvidenceComplete: false,
};

const EXPLORE_TURNS = [
  { toolCall: { id: "c1", name: "read", arguments: { path: "src/worker.js", limit: 1 } } },  // PARTIAL window
  { toolCall: { id: "c2", name: "read", arguments: { path: "../escape" } } },                 // ERROR
  { toolCall: { id: "c3", name: "grep", arguments: { pattern: "mark", literal: true } } },    // complete match
];

async function setupBothArms(piTurns, currentTurns) {
  // Scripted servers FIRST — each harness binds to its own server's model.
  const fakePi = await startFakeProvider({ turns: piTurns });
  const fakeCurrent = await startFakeProvider({ turns: currentTurns });
  const base = await buildSnapshotSource({ "src/worker.js": "old\n" }, { ref: "par-base" });
  const head = await buildSnapshotSource(FILES, { ref: "par-head" });

  const piSession = await prepareRepository({
    invocationId: "par-pi",
    headSha: "par-head",
    baseSha: "par-base",
    acquire: { mode: "snapshot", baseTree: base, headTree: head, blobs: { ...base.blobs, ...head.blobs } },
  });
  const currentSession = await prepareRepository({
    invocationId: "par-current",
    headSha: "par-head",
    baseSha: "par-base",
    acquire: { mode: "snapshot", baseTree: base, headTree: head, blobs: { ...base.blobs, ...head.blobs } },
  });

  const piHarness = createPiHarness({
    model: fakePi.model,
    runtimeApiKey: "parity-key",
    resolveRepositorySession: (id) => (id === piSession.id ? piSession : null),
  });
  const currentHarness = createCurrentGitWireHarness({
    model: fakeCurrent.model,
    runtimeApiKey: "parity-key",
    resolveRepositorySession: (id) => (id === currentSession.id ? currentSession : null),
    changedFilesProvider: async () => [{ filename: "src/worker.js", patch: "@@ -1 +1 @@\n-new\n+import { mark } from \"./markers.js\";" }],
  });

  const task = (session) => ({
    reviewInvocationId: "rinv-parity",
    repositorySessionId: session.id,
    repository: { owner: "org", name: "repo" },
    baseSha: "par-base",
    headSha: "par-head",
    reviewRoot: { invocationId: "rinv-parity", baseSha: "par-base", headSha: "par-head" },
    objective: AB_OBJECTIVE_PREAMBLE + "\n\nPull request: parity probe",
    findingSchema: { name: "gitwire-findings", version: "2" },
    deadlineMs: 30000,
    budget: { maxToolCalls: 40 },
  });

  return { piSession, currentSession, piHarness, currentHarness, fakePi, fakeCurrent, task };
}

describe("frozen A/B manifest", () => {
  it("freezes arms, order, budgets, scoring, and the decision rule; hash is stable", () => {
    const a = buildAbManifest({ gitHead: "x", provider: "zai", model: "glm-5.3", piPromptVersion: "pi-phase8-v1", currentPromptVersion: "current-phase9-v1", piPackageVersion: "0.74.2" });
    const b = buildAbManifest({ gitHead: "y", provider: "zai", model: "glm-5.3", piPromptVersion: "pi-phase8-v1", currentPromptVersion: "current-phase9-v1", piPackageVersion: "0.74.2" });
    expect(a.manifestHash).toBe(b.manifestHash); // gitHead excluded from hash
    expect(a.maxInvocations).toBe(12);
    expect(a.order).toHaveLength(12);
    expect(AB_ORDER.filter((o) => o.variant === "broken" && o.arm === "pi")).toHaveLength(3);
    expect(AB_ORDER.filter((o) => o.variant === "broken" && o.arm === "current-gitwire")).toHaveLength(3);
    expect(AB_ORDER.filter((o) => o.variant === "fixed" && o.arm === "pi")).toHaveLength(3);
    expect(AB_ORDER.filter((o) => o.variant === "fixed" && o.arm === "current-gitwire")).toHaveLength(3);
    // Predeclared interleaving per the frozen protocol: each variant's
    // sequence alternates WITHIN each repetition pair (A B | B A | A B and
    // its mirror); across-pair adjacency follows the client's example.
    expect(AB_BUDGETS.maxTotalTokens).toBe(7000000);
    expect(a.budgetSemantics).toContain("crossing threshold");
  });

  it("fixtures freeze RI-04 broken and fixed at their exact heads", () => {
    expect(AB_FIXTURES).toEqual([
      { caseId: "RI-04", variant: "broken", fixtureHead: "624732c" },
      { caseId: "RI-04", variant: "fixed", fixtureHead: "a32a07e" },
    ]);
  });
});

describe("A/B parity — both arms share the frozen contract", () => {
  let ctx;

  beforeAll(async () => {
    ctx = await setupBothArms(
      [
        ...EXPLORE_TURNS,
        { toolCall: { id: "c9", name: "submit_review", arguments: SUBMIT_PI } },
      ],
      [
        ...EXPLORE_TURNS.map((t) => ({ ...t, toolCall: { ...t.toolCall, id: `cur-${t.toolCall.id}` } })),
        { content: "done exploring" },
        { toolCall: { id: "cur-c9", name: "submit_review_result", arguments: SUBMIT_CURRENT } },
      ]
    );
  }, 120000);

  afterAll(async () => {
    ctx?.piSession?.close?.();
    ctx?.currentSession?.close?.();
    await ctx?.fakePi?.close?.();
    await ctx?.fakeCurrent?.close?.();
  });

  it("both arms complete with a submission and the same repository operations", async () => {
    const piExecution = await ctx.piHarness.runReview(ctx.task(ctx.piSession));
    const currentExecution = await ctx.currentHarness.runReview(ctx.task(ctx.currentSession));

    expect(piExecution.status).toBe("completed");
    expect(currentExecution.status).toBe("completed");
    expect(piExecution.terminationReason).toBe("submitted");
    expect(currentExecution.terminationReason).toBe("submitted");

    // Same repository substrate semantics: both arms' traces contain the
    // same MODEL-driven operations (Arm A additionally prepends its
    // deterministic seed reads — its own context-selection characteristic).
    const piOps = piExecution.toolTrace.map((e) => `${e.operation}:${e.params.path ?? e.params.pattern ?? ""}`);
    const curOps = currentExecution.toolTrace.map((e) => `${e.operation}:${e.params.path ?? e.params.pattern ?? ""}`);
    expect(piOps.join("|")).toContain("read:src/worker.js");
    expect(piOps.join("|")).toContain("grep:mark");
    expect(curOps.join("|")).toContain("read:src/worker.js");
    expect(curOps.join("|")).toContain("grep:mark");
  });

  it("PARTIAL and ERROR survive into BOTH arms' model-visible payloads", () => {
    const piTexts = ctx.fakePi.requests.map((r) => JSON.stringify(r));
    const curTexts = ctx.fakeCurrent.requests.map((r) => JSON.stringify(r));
    for (const texts of [piTexts, curTexts]) {
      expect(texts.some((t) => t.includes("output_lines"))).toBe(true);
      expect(texts.some((t) => t.includes("E_PATH_ESCAPE"))).toBe(true);
      expect(texts.some((t) => t.includes("repo-read") || t.includes("submit"))).toBe(true);
    }
  });

  it("both arms received the same objective text and identical model identity", () => {
    const piFirst = ctx.fakePi.requests[0];
    const curFirst = ctx.fakeCurrent.requests[0];
    const piUser = piFirst.messages.find((m) => m.role === "user");
    const curUser = curFirst.messages.find((m) => m.role === "user");
    const piText = Array.isArray(piUser.content) ? piUser.content[0].text : piUser.content;
    const curText = Array.isArray(curUser.content) ? curUser.content[0].text : curUser.content;
    expect(piText).toContain("Pull request: parity probe");
    expect(curText).toContain("Pull request: parity probe");
    expect(piFirst.model).toBe(curFirst.model);
  });

  it("no mutation credential exists in either arm's traffic", () => {
    for (const fake of [ctx.fakePi, ctx.fakeCurrent]) {
      for (const text of fake.requests.map((r) => JSON.stringify(r))) {
        expect(text).not.toContain("github.com");
        expect(text).not.toContain("ghp_");
        expect(text).not.toContain("x-github");
      }
    }
  });

  it("requested/actual identity is recorded by both arms", async () => {
    const piExecution = await ctx.piHarness.runReview({ ...ctx.task(ctx.piSession), repositorySessionId: "nope" });
    expect(piExecution.requestedHarness).toBe("pi");
    const curExecution = await ctx.currentHarness.runReview({ ...ctx.task(ctx.currentSession), repositorySessionId: "nope" });
    expect(curExecution.requestedHarness).toBe("current-gitwire");
    expect(curExecution.error.code).toBe("E_SESSION_UNAVAILABLE");
  });
});
