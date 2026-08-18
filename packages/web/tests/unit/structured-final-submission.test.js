// tests/unit/structured-final-submission.test.js
// Deterministic tests for the structured final-submission protocol and the
// material-evidence rules on the live-v2 primary and verifier.
//
// Proves:
//   1. final submission parses tool_use.input directly (no prose JSON dependency)
//   2. clean final result after consuming the full retrieval round budget
//      creates NO artificial unresolved request (primary)
//   3. denied exploratory context does not block
//   4. denied required context does block
//   5. model-declared material unresolved context blocks; declared
//      non-material does not
//   6. verifier can return VERIFIED after consuming its full retrieval budget
//   7. malformed/missing submission remains fail-closed

const { runPrimaryReview } = await import("../../src/services/primaryReviewService.js");
const { runApprovalVerification, VERIFIER_STATUS } = await import("../../src/services/approvalVerificationService.js");
const { completeClearedLedger } = await import("./verifierLedgerFixture.js");

// ── Mock octokit for the Context Broker ─────────────────────────────────────

const FILE_TEXT = "line1\nline2\nconst marker = findCommentByMarker();\n";

function makeBrokerOctokit() {
  return {
    request: async function (route, params) {
      if (route.includes("/git/trees/")) {
        return {
          data: {
            tree: [
              { type: "blob", path: "src/a.js", sha: "blob_a" },
              { type: "blob", path: "src/b.js", sha: "blob_b" },
            ],
          },
        };
      }
      if (route.includes("/git/blobs/")) {
        return {
          data: {
            encoding: "base64",
            content: Buffer.from(FILE_TEXT, "utf-8").toString("base64"),
            size: Buffer.byteLength(FILE_TEXT),
          },
        };
      }
      if (route.includes("/contents/")) {
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(FILE_TEXT, "utf-8").toString("base64"),
            sha: "blob_a",
          },
        };
      }
      return { data: {} };
    },
  };
}

// ── Mock Anthropic with a scripted response sequence ────────────────────────

function makeAnthropic(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async function (params) {
        calls.push(params);
        const next = responses.shift();
        if (!next) throw new Error("anthropic mock: no scripted response left");
        return next;
      },
    },
  };
}

function toolUseMsg(blocks, model = "glm-test") {
  return {
    model,
    stop_reason: "tool_use",
    content: blocks.map((b, i) => ({
      type: "tool_use", id: "tu_" + Math.random().toString(36).slice(2, 8) + i, ...b,
    })),
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function textMsg(text, model = "glm-test") {
  return {
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

// ── Shared evidence fixture ──────────────────────────────────────────────────

const HEAD = "head2222222222222222222222222222222222222222";
const BASE = "base111111111111111111111111111111111111111";

const EVIDENCE = {
  review: { repoId: 1, repoFullName: "org/repo", prNumber: 1, baseSha: BASE, headSha: HEAD, invocationId: "rinv:test" },
  changedFiles: [],
  contextItems: [],
  retrievalTrace: [],
  coverage: {
    totalChangedFiles: 1, fullyCoveredFiles: 1, policyExemptFiles: 0,
    partialFiles: 0, unavailableFiles: 0, approvalEvidenceComplete: true,
  },
};

// ── Primary tests ────────────────────────────────────────────────────────────

describe("Primary: structured final submission", () => {

  it("parses submit_review_result tool_use.input directly (no prose JSON)", async () => {
    const anthropic = makeAnthropic([
      // Round 0: one exploratory search (advances the context round)
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      // Final turn: structured submission via tool_use — the assertion target
      toolUseMsg([{
        name: "submit_review_result",
        input: { findings: [], unresolvedContextNeeds: [] },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    // The submission arrived structured — no parse error, no findings, no unresolved
    expect(receipt.error).toBeUndefined();
    expect(receipt.findings).toEqual([]);
    expect(receipt.unresolvedContextRequests).toEqual([]);
    // The final call exposed ONLY the submission tool
    const finalCall = anthropic.calls[anthropic.calls.length - 1];
    expect(finalCall.tools.map(t => t.name)).toEqual(["submit_review_result"]);
  });

  it("consuming the full round budget with a clean result creates no artificial unresolved request", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      toolUseMsg([{
        name: "submit_review_result",
        input: { findings: [], unresolvedContextNeeds: [] },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    // budgetState.exhausted is true (1/1 rounds), yet the clean result survives
    expect(receipt.budgetState.exhausted).toBe(true);
    expect(receipt.error).toBeUndefined();
    expect(receipt.unresolvedContextRequests).toEqual([]);
  });

  it("denied exploratory context does not block", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([
        // Exploratory search — allowed, advances the round
        { name: "search_repo_text", input: { query: "marker", ref: HEAD, requiredForApproval: false } },
        // Exploratory read — denied (maxFileReads: 0) but NOT required
        { name: "read_repo_file", input: { path: "src/a.js", ref: HEAD, requiredForApproval: false } },
      ]),
      toolUseMsg([{
        name: "submit_review_result",
        input: { findings: [], unresolvedContextNeeds: [] },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1, maxFileReads: 0 } },
      maxDurationMs: 10000,
    });

    expect(receipt.error).toBeUndefined();
    // The exploratory denial stays in the trace but does not block
    expect(receipt.retrievalTrace.some(t => t.result === "budget_exceeded")).toBe(true);
    expect(receipt.unresolvedContextRequests).toEqual([]);
  });

  it("denied required context does block", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([
        { name: "search_repo_text", input: { query: "marker", ref: HEAD } },
        // Required read — denied; must surface as unresolved
        { name: "read_repo_file", input: { path: "src/a.js", ref: HEAD, requiredForApproval: true, purpose: "verify callee implementation" } },
      ]),
      toolUseMsg([{
        name: "submit_review_result",
        input: { findings: [], unresolvedContextNeeds: [] },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1, maxFileReads: 0 } },
      maxDurationMs: 10000,
    });

    expect(receipt.unresolvedContextRequests).toHaveLength(1);
    expect(receipt.unresolvedContextRequests[0].source).toBe("broker_budget");
    expect(receipt.unresolvedContextRequests[0].reason).toBe("budget_exceeded");
  });

  it("model-declared material unresolved context blocks; non-material does not", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      toolUseMsg([{
        name: "submit_review_result",
        input: {
          findings: [],
          unresolvedContextNeeds: [
            { description: "helper implementation at HEAD unverifiable", requiredForApproval: true, potentialSeverity: "P2", basis: "repository_dependency" },
            { description: "optional style guide lookup", requiredForApproval: false },
          ],
        },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    // Only the material entry survives into the blocking list
    expect(receipt.unresolvedContextRequests).toHaveLength(1);
    expect(receipt.unresolvedContextRequests[0].source).toBe("model_declared");
    expect(receipt.unresolvedContextRequests[0].potentialSeverity).toBe("P2");
  });

  it("natural stop takes the structured submission turn (no prose JSON dependency)", async () => {
    const anthropic = makeAnthropic([
      // Round 0: model stops naturally with narration — no tool call at all
      textMsg("I have reviewed the changed files and I am confident about my conclusions now."),
      // Submission turn must then run and arrive structured
      toolUseMsg([{
        name: "submit_review_result",
        input: { findings: [], unresolvedContextNeeds: [] },
      }]),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.findings).toEqual([]);
    expect(receipt.unresolvedContextRequests).toEqual([]);
    // The second call was the submission turn with only the submit tool
    expect(anthropic.calls).toHaveLength(2);
    expect(anthropic.calls[1].tools.map(t => t.name)).toEqual(["submit_review_result"]);
    // The submission instruction followed an assistant turn (valid alternation)
    expect(anthropic.calls[1].messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("forces the submission via tool_choice and falls back if the provider rejects it", async () => {
    const submitInput = { findings: [], unresolvedContextNeeds: [] };
    let callCount = 0;
    const anthropic = {
      messages: {
        create: async function (params) {
          callCount++;
          if (params.tool_choice) {
            // First submission attempt: provider rejects the forced-tool parameter
            throw new Error("tool_choice is not supported by this proxy");
          }
          if (callCount === 1) {
            return toolUseMsg([{ name: "search_repo_text", input: { query: "m", ref: HEAD } }]);
          }
          // callCount 2 = fallback submission without tool_choice
          return toolUseMsg([{ name: "submit_review_result", input: submitInput }]);
        },
      },
    };

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.findings).toEqual([]);
    // Call 1: round-0 exploration. Call 2: submission WITH forced tool_choice
    // (provider rejects). Call 3: fallback without tool_choice → structured.
    expect(callCount).toBe(3);
  });

  it("submission turn sends tool_choice forcing submit_review_result", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "m", ref: HEAD } }]),
      toolUseMsg([{ name: "submit_review_result", input: { findings: [], unresolvedContextNeeds: [] } }]),
    ]);
    await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });
    const finalCall = anthropic.calls[anthropic.calls.length - 1];
    expect(finalCall.tool_choice).toEqual({ type: "tool", name: "submit_review_result" });
  });

  it("retries once at doubled output room when narration dies at max_tokens before the tool call", async () => {
    const narrationNoTool = {
      model: "glm-test", stop_reason: "max_tokens",
      content: [{ type: "text", text: "Analysis part 1... " + "x".repeat(4000) }],
      usage: { input_tokens: 100, output_tokens: 8192 },
    };
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "m", ref: HEAD } }]),
      narrationNoTool, // first submission attempt: narration dies at cap, no tool call
      toolUseMsg([{ name: "submit_review_result", input: { findings: [], unresolvedContextNeeds: [] } }]), // retry succeeds
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.error).toBeUndefined();
    expect(receipt.findings).toEqual([]);
    expect(receipt.submissionDiagnostics.submissionRetried).toBe(true);
    expect(receipt.submissionDiagnostics.usedSubmitTool).toBe(true);
    // The retry used doubled output room
    const lastCall = anthropic.calls[anthropic.calls.length - 1];
    expect(lastCall.max_tokens).toBe(16384);
  });

  it("malformed/missing submission remains fail-closed", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      // Final turn: no tool_use, unparseable prose
      textMsg("I will now summarize my findings in narrative form. The patch looks fine overall."),
    ]);

    const receipt = await runPrimaryReview({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      primaryBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.error).toContain("Failed to parse");
    expect(receipt.findings).toEqual([]);
  });
});

// ── Verifier tests ───────────────────────────────────────────────────────────

describe("Verifier: structured final submission and budget semantics", () => {

  it("can return VERIFIED after consuming its full retrieval budget", async () => {
    const anthropic = makeAnthropic([
      // Round 0: a read consumes the only allowed context round
      toolUseMsg([{ name: "read_repo_file", input: { path: "src/a.js", ref: HEAD } }]),
      toolUseMsg([{
        name: "submit_verification_result",
        input: { status: "verified", findings: [], unresolvedContextNeeds: [], riskLedger: completeClearedLedger(), coverageSatisfied: true },
      }]),
    ]);

    const receipt = await runApprovalVerification({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      verifierBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    // Budget fully consumed, but a clean result is VERIFIED — not INCOMPLETE
    expect(receipt.budgetState.exhausted).toBe(true);
    expect(receipt.status).toBe(VERIFIER_STATUS.VERIFIED);
    expect(receipt.approvalSafe).toBe(true);
  });

  it("denied required context blocks; exploratory denial does not", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([
        { name: "search_repo_text", input: { query: "marker", ref: HEAD, requiredForApproval: false } },
        { name: "read_repo_file", input: { path: "src/a.js", ref: HEAD, requiredForApproval: true } },
      ]),
      toolUseMsg([{
        name: "submit_verification_result",
        input: { status: "verified", findings: [], unresolvedContextNeeds: [], riskLedger: completeClearedLedger(), coverageSatisfied: true },
      }]),
    ]);

    const receipt = await runApprovalVerification({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      verifierBudgets: { contextBroker: { maxContextRounds: 1, maxFileReads: 0 } },
      maxDurationMs: 10000,
    });

    // Model said verified, but a REQUIRED read was denied → INCOMPLETE
    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.unresolvedContextRequests.some(u => u.source === "broker_budget")).toBe(true);
  });

  it("model-declared material unresolved context forces INCOMPLETE", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      toolUseMsg([{
        name: "submit_verification_result",
        input: {
          status: "verified",
          findings: [],
          unresolvedContextNeeds: [
            { description: "callee implementation could not be read", requiredForApproval: true, potentialSeverity: "P2", basis: "repository_dependency" },
          ],
          riskLedger: completeClearedLedger(),
          coverageSatisfied: true,
        },
      }]),
    ]);

    const receipt = await runApprovalVerification({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      verifierBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.unresolvedContextRequests[0].source).toBe("model_declared");
  });

  it("malformed/missing submission remains fail-closed", async () => {
    const anthropic = makeAnthropic([
      toolUseMsg([{ name: "search_repo_text", input: { query: "marker", ref: HEAD } }]),
      textMsg("The verification went well. Everything checks out from my reading of the code."),
    ]);

    const receipt = await runApprovalVerification({
      evidence: EVIDENCE,
      octokit: makeBrokerOctokit(), owner: "org", repo: "repo",
      anthropic,
      verifierBudgets: { contextBroker: { maxContextRounds: 1 } },
      maxDurationMs: 10000,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("Failed to parse");
  });
});
