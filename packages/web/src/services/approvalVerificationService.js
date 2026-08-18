// src/services/approvalVerificationService.js
// Independent Approval Verifier (RI-5).
//
// Runs whenever the deterministic pre-policy says the review could potentially
// approve (zero material findings). The verifier is a completely separate
// LLM invocation that does NOT see the primary reviewer's verdict, confidence,
// or findings. It has its own context broker budget and conversation.
//
// Its job is to find missed P0/P1/P2 regressions that the primary reviewer
// overlooked, and to identify unresolved evidence needs. Any timeout, API
// failure, schema failure, context exhaustion, or unresolved material context
// results in verification_incomplete → no APPROVE.

import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";
import { createContextBroker, DEFAULT_BUDGETS as BROKER_BUDGETS } from "./reviewContextBroker.js";
import { validateFinding, SEVERITY, parseEvidenceRef, validateEvidenceRef } from "./findingValidator.js";
import {
  buildExecutionProfile,
  classifyVerifierTerminal,
  providerFromBaseURL,
  usageFromCategories,
} from "./executionProfileService.js";

// ── Verifier prompt identity (descriptive instrumentation metadata) ──────────

const VERIFIER_PROMPT_VERSION = "v2-verifier-r2";
const VERIFIER_PROMPT_HASH = createHash("sha256")
  .update(VERIFIER_PROMPT_VERSION + ":falsification-risk-ledger")
  .digest("hex").slice(0, 16);

// ── Falsification risk-ledger vocabulary (generic, change-relative) ─────────
//
// The two-phase falsification contract: the verifier first ENUMERATES the
// correctness-material risk obligations this change creates, then RESOLVES
// every obligation with repository evidence, a material finding, or an
// unresolved-context result. `verified` is computed only when the ledger is
// complete and every material obligation is evidence-cleared; any unresolved
// obligation fails closed. The vocabulary is deliberately generic — no
// fixture, corpus, or benchmark specifics may ever enter it.

export const RISK_CATEGORIES = Object.freeze([
  {
    id: "changed_behavior",
    label: "Changed behavior",
    prompt: "What the changed lines now do differently at their call sites: outputs, ordering, error paths, edge conditions the old code handled.",
  },
  {
    id: "dependency_interface_contracts",
    label: "Dependency and interface contracts",
    prompt: "Contracts the change relies on or alters: callers of changed signatures, exports, config schemas, API/CLI surfaces, types consumed elsewhere.",
  },
  {
    id: "state_side_effects",
    label: "State and side effects",
    prompt: "Mutable state the change touches: shared modules, caches, databases, files, background jobs, ordering assumptions, cleanup paths.",
  },
  {
    id: "config_runtime_assumptions",
    label: "Config and runtime assumptions",
    prompt: "Environment facts the change assumes: env vars, feature flags, service versions, defaults, deployment-specific values — and whether the repository actually establishes them.",
  },
  {
    id: "normative_docs_tests",
    label: "Normative docs and tests",
    prompt: "Statements in docs, specs, comments, or tests that normatively describe the changed behavior and must stay consistent with it.",
  },
  {
    id: "counterexamples",
    label: "Counterexamples",
    prompt: "Concrete inputs, sequences, or states that would break the change's implicit claims — constructed adversarially against the diff itself.",
  },
]);

export const RISK_CATEGORY_IDS = Object.freeze(RISK_CATEGORIES.map(c => c.id));

export const OBLIGATION_OUTCOMES = Object.freeze({
  EVIDENCE_CLEARED: "evidence_cleared",
  MATERIAL_FINDING: "material_finding",
  UNRESOLVED:        "unresolved",
});

// ── Verifier status constants ────────────────────────────────────────────────

export const VERIFIER_STATUS = Object.freeze({
  VERIFIED:           "verified",
  MATERIAL_FINDINGS:  "material_findings",
  INCOMPLETE:         "incomplete",
  ERROR:              "error",
});

// ── Verifier system prompt ───────────────────────────────────────────────────

/**
 * Build the verifier's system prompt. This does NOT include the primary
 * reviewer's verdict, confidence, or findings — the verifier is independent.
 *
 * The verifier knows only:
 *   - This is an approval candidate
 *   - The review evidence (changed files, coverage manifest)
 *   - It has read/search tools available at immutable SHAs
 */
export function buildVerifierSystemPrompt(evidence) {
  const categoryLines = RISK_CATEGORIES.map(c => '  - "' + c.id + '": ' + c.label + " — " + c.prompt).join("\n");
  return [
    "You are an independent approval verifier for a code review system.",
    "",
    "A primary review has completed on this PR. You do NOT know its verdict,",
    "confidence, or findings. Your job is to independently verify whether this",
    "PR is safe to approve — by trying to FALSIFY it, not by summarizing it.",
    "",
    "You are given the ReviewEvidence: the complete list of changed files,",
    "their coverage states, and the coverage manifest. You also have read and",
    "search tools to inspect repository files at the exact base and head commit SHAs.",
    "",
    "## Immutable commit SHAs",
    "",
    "Use these exact SHA values for all read_repo_file and search_repo_text calls:",
    "- BASE (old version, before the PR): " + (evidence?.review?.baseSha || "UNKNOWN"),
    "- HEAD (new version, after the PR): " + (evidence?.review?.headSha || "UNKNOWN"),
    "",
    "## Protocol — two phases, in order",
    "",
    "PHASE 1 (enumerate): Build a risk ledger of the correctness-material risk",
    "obligations this change creates. Enumerate one entry per category below.",
    "Each obligation must be specific to THIS diff — a concrete way the change",
    "could break correctness that a maintainer would demand be checked before",
    "approval. An obligation is material when failing it could conceal a",
    "P0/P1/P2 defect. If a category genuinely has no obligation for this",
    "change, you must still include the category with an explicit, specific",
    "noneJustification — an empty category with no justification is invalid.",
    "",
    "Categories (use these exact ids):",
    categoryLines,
    "",
    "PHASE 2 (resolve): Resolve EVERY obligation, using the repository tools",
    "to gather evidence:",
    "- evidence_cleared: you examined repository evidence (cite it in",
    "  evidenceRefs) and the obligation does not hold — the change is safe",
    "  on this axis. An evidence_cleared resolution with no evidenceRefs is",
    "  invalid: clearing requires evidence, not assertion.",
    "- material_finding: the obligation holds and constitutes a P0/P1/P2",
    "  defect — also emit it in findings and point findingIndex at it.",
    "- unresolved: you could not gather the evidence needed to decide, within",
    "  budget or data limits — state why in reason. This fails verification",
    "  closed; never guess an obligation away.",
    "",
    "Coverage manifest:",
    "  Total changed files: " + evidence.coverage.totalChangedFiles,
    "  Fully covered: " + evidence.coverage.fullyCoveredFiles,
    "  Policy exempt: " + evidence.coverage.policyExemptFiles,
    "  Partial: " + evidence.coverage.partialFiles,
    "  Unavailable: " + evidence.coverage.unavailableFiles,
    "  Approval evidence complete: " + evidence.coverage.approvalEvidenceComplete,
    "",
    "Respond with a JSON object matching this schema:",
    "{",
    '  "status": "verified" | "material_findings" | "incomplete",',
    '  "findings": [',
    "    {",
    '      "severity": "P0" | "P1" | "P2" | "P3",',
    '      "category": "bug" | "security" | "regression" | "test_gap" | "maintainability",',
    '      "claim": "short description",',
    '      "description": "detailed explanation",',
    '      "affectedPaths": ["path/to/file"],',
    '      "evidenceRefs": ["changed:path@HEAD:Lstart-Lend" | "repo-read:path@SIDE:Lline"],',
    '      "proof": { "type": "static_trace" | "counterexample" | "reproduction" | "inference", "summary": "..." }',
    "    }",
    "  ],",
    '  "riskLedger": {',
    '    "categories": [',
    "      {",
    '        "category": "<one of the six category ids above>",',
    '        "obligations": [',
    "          {",
    '            "description": "concrete way this change could break correctness",',
    '            "resolution": {',
    '              "outcome": "evidence_cleared" | "material_finding" | "unresolved",',
    '              "evidenceRefs": ["evidence you examined for a clearance"],',
    '              "findingIndex": 0,',
    '              "reason": "why the obligation could not be resolved"',
    "            }",
    "          }",
    "        ],",
    '        "noneJustification": "why this category has no obligations for this change"',
    "      }",
    "    ]",
    "  },",
    '  "unresolvedContextNeeds": [',
    "    {",
    '      "description": "what could not be checked and why it matters",',
    '      "requiredForApproval": true,',
    '      "potentialSeverity": "P0" | "P1" | "P2",',
    '      "basis": "repository_dependency" | "changed_contract"',
    "    }",
    "  ],",
    '  "coverageSatisfied": true | false',
    "}",
    "",
    "Rules:",
    "- `verified` is only schema-valid when the ledger covers ALL six",
    "  categories and EVERY obligation resolves evidence_cleared (or to a",
    "  validated material finding). The system computes the final status from",
    "  your ledger — a declared status cannot override it.",
    "- Every evidence_cleared resolution MUST cite the repository evidence you",
    "  examined in evidenceRefs.",
    "- Every material_finding resolution MUST point at its finding via",
    "  findingIndex, and every P0/P1/P2 finding MUST include at least one",
    "  evidence reference pointing to a specific file and line range in the",
    "  changed files or retrieved repository context.",
    "- An unresolved obligation or unresolved material context need fails",
    "  verification closed. Using your full retrieval budget is NOT",
    "  incompleteness by itself.",
    "- Report an unresolved context need only when the missing evidence",
    "  could plausibly conceal a P0/P1/P2 defect introduced or exposed by",
    "  this PR. Do not report optional completeness checks, low-confidence",
    "  speculation, or historical/external facts that the repository is not",
    "  expected to contain, unless a repository contract specifically",
    "  requires that evidence to be committed or referenced.",
    "- Follow dependency chains: when a changed path calls a helper, verify",
    "  that helper's implementation at HEAD before clearing that obligation.",
    "- You have a LIMITED number of file reads and searches. Spend them on",
    "  the obligations, not on exploration.",
  ].join("\n");
}

// ── Verifier result parser ───────────────────────────────────────────────────

/**
 * Parse the verifier's raw text response into a structured result.
 * Handles JSON extraction with the same cascade as the primary review.
 *
 * @param {string} rawText
 * @returns {object|null} parsed verifier result, or null if unparseable
 */
export function parseVerifierResult(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  const trimmed = rawText.trim();

  // Strategy 1: Direct parse
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    // continue
  }

  // Strategy 2: Strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_e) {
      // continue
    }
  }

  // Strategy 3: Find the first { and last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
    } catch (_e) {
      // continue
    }
  }

  return null;
}

// ── Main verification runner ─────────────────────────────────────────────────

/**
 * Run the independent approval verifier.
 *
 * This is the main entry point. It creates a SEPARATE context broker with its
 * own budget, invokes the LLM as a completely independent conversation, and
 * returns a structured verification receipt.
 *
 * @param {object} params
 * @param {object} params.evidence - ReviewEvidence from buildReviewEvidence
 * @param {object} params.octokit - GitHub client for the context broker
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {object} params.anthropic - Anthropic SDK instance
 * @param {string} params.model - model identifier
 * @param {object} [params.verifierBudgets] - override default LLM/context budgets
 * @param {number} [params.maxDurationMs] - timeout for the entire verification
 * @returns {Promise<object>} verification receipt
 */
export async function runApprovalVerification({
  evidence,
  octokit,
  owner,
  repo,
  anthropic,
  model = "claude-sonnet-4-20250514",
  verifierBudgets,
  maxDurationMs = 120000,
}) {
  const startTime = Date.now();
  const reviewRoot = evidence?.review;

  // Phase 10 execution-observability accumulators (input/output only; the
  // Anthropic messages loop does not expose cache categories — they stay
  // null rather than being synthesized).
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let usageSeen = false;

  function accumulateUsage(u) {
    if (u && typeof u === "object" && (u.input_tokens !== undefined || u.output_tokens !== undefined)) {
      usageSeen = true;
      usageInputTokens += u.input_tokens ?? 0;
      usageOutputTokens += u.output_tokens ?? 0;
    }
  }

  function usageAccumulators() {
    return usageSeen
      ? { inputTokens: usageInputTokens, outputTokens: usageOutputTokens }
      : {};
  }

  const invocationInfo = {
    requestedModel: model,
    provider: providerFromBaseURL(anthropic?.baseURL),
    adapter: "anthropic-sdk-verifier",
    protocol: "anthropic-messages",
    requestedRoute: anthropic?.baseURL || null,
    promptId: VERIFIER_PROMPT_VERSION,
    promptHash: VERIFIER_PROMPT_HASH,
    maxTokens: verifierBudgets?.maxTokens || 50000,
    startTime,
  };

  // ── Guard: evidence must have a review root with required SHAs ──────────
  if (!reviewRoot || !reviewRoot.baseSha || !reviewRoot.headSha) {
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], [], false, 0, Date.now() - startTime, "Missing review root with base/head SHAs", null, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }

  // ── Create a SEPARATE context broker with its own budget ────────────────
  let broker;
  try {
    broker = createContextBroker({
      octokit,
      owner,
      repo,
      baseSha: reviewRoot.baseSha,
      headSha: reviewRoot.headSha,
      budgets: verifierBudgets?.contextBroker,
    });
  } catch (err) {
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], [], false, 0, Date.now() - startTime, "Failed to create context broker: " + err.message, null, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }

  // ── Build the prompt ─────────────────────────────────────────────────────
  const systemPrompt = buildVerifierSystemPrompt(evidence);
  const userPrompt = buildVerifierUserPrompt(evidence);

  // ── Tool definitions for the context broker ──────────────────────────────
  const verifierTools = [
    {
      name: "read_repo_file",
      description: "Read a file at an immutable commit SHA (base or head of the PR). Use to inspect supporting files, callers, imports, configs.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository file path (relative, no ../)" },
          ref: { type: "string", description: "Commit SHA — must be the PR's base or head SHA" },
          range: {
            type: "object",
            properties: {
              startLine: { type: "number" },
              endLine: { type: "number" },
            },
            description: "Optional line range to read",
          },
          purpose: { type: "string", description: "Why this context is needed" },
          requiredForApproval: { type: "boolean", description: "True if this dependency MUST be checked before approval can be justified." },
        },
        required: ["path", "ref"],
      },
    },
    {
      name: "search_repo_text",
      description: "Search repository content for a text query at an immutable commit SHA. Returns matching files with line numbers and fragments.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive search query" },
          ref: { type: "string", description: "Commit SHA — must be the PR's base or head SHA" },
          purpose: { type: "string", description: "Why this search is needed" },
          requiredForApproval: { type: "boolean", description: "True if this search MUST succeed before approval can be justified." },
        },
        required: ["query", "ref"],
      },
    },
  ];

  // ── Structured final submission tool (retrieval-closed turn only) ────────
  const SUBMIT_VERIFICATION_TOOL = {
    name: "submit_verification_result",
    description:
      "Submit the final verification result. You MUST use this tool to submit your result — do not write JSON as plain text.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "material_findings", "incomplete"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
              category: { type: "string" },
              claim: { type: "string" },
              description: { type: "string" },
              affectedPaths: { type: "array", items: { type: "string" } },
              evidenceRefs: { type: "array", items: { type: "string" } },
              proof: { type: "object" },
            },
            required: ["severity", "claim"],
          },
        },
        unresolvedContextNeeds: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              requiredForApproval: { type: "boolean" },
              potentialSeverity: { type: "string", enum: ["P0", "P1", "P2"] },
              basis: { type: "string", enum: ["repository_dependency", "changed_contract"] },
            },
            required: ["description", "requiredForApproval"],
          },
        },
        riskLedger: {
          type: "object",
          description: "Two-phase falsification ledger: every risk obligation enumerated per category, each resolved with evidence, a finding, or an unresolved reason.",
          properties: {
            categories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  category: { type: "string", enum: [...RISK_CATEGORY_IDS] },
                  obligations: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        description: { type: "string", description: "Concrete way this change could break correctness" },
                        resolution: {
                          type: "object",
                          properties: {
                            outcome: { type: "string", enum: ["evidence_cleared", "material_finding", "unresolved"] },
                            evidenceRefs: { type: "array", items: { type: "string" } },
                            findingIndex: { type: "number" },
                            reason: { type: "string" },
                          },
                          required: ["outcome"],
                        },
                      },
                      required: ["description", "resolution"],
                    },
                  },
                  noneJustification: { type: "string" },
                },
                required: ["category"],
              },
            },
          },
          required: ["categories"],
        },
        coverageSatisfied: { type: "boolean" },
      },
      required: ["status", "riskLedger"],
    },
  };

  // ── Helper: race a promise against a deadline ────────────────────────────
  const deadline = startTime + maxDurationMs;
  function withDeadline(promise, label) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new Error("Verifier timed out: " + label + " exceeded deadline after " + maxDurationMs + "ms"));
    }
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Verifier timed out: " + label + " after " + maxDurationMs + "ms")), remaining)),
    ]);
  }

  // ── Invoke the LLM with tool-use loop ────────────────────────────────────
  const textParts = []; // accumulate text from all rounds (don't overwrite)
  let tokensUsed = 0;
  let actualModel = null;
  let messages = [{ role: "user", content: userPrompt }];
  const MAX_TOOL_ROUNDS = 5; // safety limit
  const MAX_TOKENS = verifierBudgets?.maxTokens || 50000;
  const verifierContextItems = []; // successful broker results for finding validation
  const verifierDeniedRequired = []; // denied requests the model marked requiredForApproval
  let tokenBudgetExceeded = false;

  let submittedResult = null; // structured final submission via tool_use
  let submissionAttempted = false; // one submission turn per invocation
  let submissionDiagnostics = null; // what the submission turn actually returned

  try {
    // Structured submission turn: only the submission tool is exposed and its
    // tool_use.input is parsed directly. Runs when retrieval closes — either
    // by budget exhaustion OR by the model naturally stopping tool use.
    async function runSubmissionTurn() {
      submissionAttempted = true;
      messages.push({
        role: "user",
        content: "Repository retrieval is now closed. Call the submit_verification_result tool NOW with your complete final result — do not write any preamble or narrative text first. If any correctness-material dependency still must be checked, include it in unresolvedContextNeeds with requiredForApproval: true.",
      });
      // FORCE the tool call (same rationale as the primary: narration must
      // not be able to displace the structured submission). Provider-reject
      // fallback retries without tool_choice; a narration that dies at
      // max_tokens with no tool call gets ONE retry at doubled output room.
      let vForcedToolFallbackAttempts = 0;
      const vCallSubmission = async (maxTokens) => {
        try {
          return await withDeadline(
            anthropic.messages.create({
              model, max_tokens: maxTokens, system: systemPrompt,
              tools: [SUBMIT_VERIFICATION_TOOL],
              tool_choice: { type: "tool", name: "submit_verification_result" },
              messages,
            }),
            "Verifier final submission",
          );
        } catch (_tcErr) {
          vForcedToolFallbackAttempts += 1;
          return await withDeadline(
            anthropic.messages.create({
              model, max_tokens: maxTokens, system: systemPrompt,
              tools: [SUBMIT_VERIFICATION_TOOL],
              messages,
            }),
            "Verifier final submission (no tool_choice fallback)",
          );
        }
      };

      // Usage accounting on EVERY successful response, BEFORE any response
      // variable is overwritten — mirrors the primary submission fix.
      const vAccountResponse = (msg) => {
        accumulateUsage(msg.usage);
        tokensUsed += (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
      };

      let vFinalMsg = await vCallSubmission(8192);
      vAccountResponse(vFinalMsg);
      let vRetried = false;

      const vExtract = (msg) => Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === "tool_use" && b.name === "submit_verification_result")
        : [];

      if (vFinalMsg.stop_reason === "max_tokens" && vExtract(vFinalMsg).length === 0 && tokensUsed <= MAX_TOKENS) {
        vRetried = true;
        messages.push({
          role: "user",
          content: "Output limit reached. Call submit_verification_result NOW with the final structured result only — no prose.",
        });
        vFinalMsg = await vCallSubmission(16384);
        vAccountResponse(vFinalMsg);
      }

      if (vFinalMsg.model && !actualModel) actualModel = vFinalMsg.model;
      if (tokensUsed > MAX_TOKENS) tokenBudgetExceeded = true;
      const vSubmitBlocks = vExtract(vFinalMsg);
      if (vSubmitBlocks.length > 0) {
        submittedResult = vSubmitBlocks[vSubmitBlocks.length - 1].input;
      }
      const vFinalTextBlocks = Array.isArray(vFinalMsg.content) ? vFinalMsg.content.filter(b => b.type === "text") : [];
      const vFinalText = vFinalTextBlocks.map(b => b.text).join("\n");
      if (vFinalText) textParts.push(vFinalText);
      submissionDiagnostics = {
        stopReason: vFinalMsg.stop_reason || null,
        usedSubmitTool: vSubmitBlocks.length > 0,
        submissionRetried: vRetried,
        forcedToolFallbackAttempts: vForcedToolFallbackAttempts,
        textTail: vFinalText ? vFinalText.slice(-300) : null,
        outputTokens: vFinalMsg.usage?.output_tokens ?? 0,
      };
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Budget exhaustion → close retrieval and take the structured submission
      const vbs = broker.getBudgetState();
      const vMaxRounds = vbs.limits?.maxContextRounds || 4;
      if (round > 0 && vbs.contextRounds >= vMaxRounds) {
        await runSubmissionTurn();
        break;
      }

      const message = await withDeadline(
        anthropic.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          tools: verifierTools,
          messages,
        }),
        "LLM call (round " + round + ")",
      );

      // Capture actual model identity from the provider response
      if (message.model && !actualModel) actualModel = message.model;

      accumulateUsage(message.usage);
      tokensUsed += (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

      // Token ceiling — fail closed, do not parse budget-exhausted output
      if (tokensUsed > MAX_TOKENS) {
        tokenBudgetExceeded = true;
        break;
      }

      // Check if the model wants to use tools
      const toolUseBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === "tool_use")
        : [];
      const textBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === "text")
        : [];

      // Accumulate text from all rounds (don't overwrite)
      if (textBlocks.length > 0) {
        textParts.push(textBlocks.map(b => b.text).join("\n"));
      }

      // If no tool-use, the model is done — keep the assistant turn in the
      // conversation so the submission instruction follows a valid user turn.
      if (message.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        messages.push({ role: "assistant", content: message.content });
        break;
      }

      // Process tool-use blocks — execute broker operations
      messages.push({ role: "assistant", content: message.content });

      const toolResults = [];
      for (const block of toolUseBlocks) {
        let result;
        if (block.name === "read_repo_file") {
          result = await withDeadline(
            broker.readRepoFile(block.input.path, block.input.ref, { range: block.input.range }),
            "read_repo_file",
          );
          // Collect successful results for finding validation
          if (result && !result.error) {
            verifierContextItems.push(result);
          }
        } else if (block.name === "search_repo_text") {
          result = await withDeadline(
            broker.searchRepoText(block.input.query, block.input.ref),
            "search_repo_text",
          );
          // Collect search result items for finding validation
          if (result && result.results) {
            for (const r of result.results) {
              verifierContextItems.push({ path: r.path, type: "search_result", ref: r.ref || r.resolvedSha, resolvedSha: r.resolvedSha, content: r.fragment });
            }
          }
        } else {
          result = { error: "unknown_tool" };
        }

        // Capture broker denials as unresolved requests ONLY when the model
        // declared the request as requiredForApproval. Exploratory denials
        // stay in the retrieval trace for audit.
        if (result && typeof result === "object") {
          const isDeniedV = (result.error && result.error !== "unknown_tool") ||
                            (result.truncated && (!result.results || result.results.length === 0) && result.reason);
          if (isDeniedV && block.input?.requiredForApproval === true) {
            verifierDeniedRequired.push({
              tool: block.name,
              target: block.input?.path || block.input?.query || null,
              reason: result.error || result.reason,
            });
          }
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      broker.endRound();
    }

    // Natural stop: the model ended tool use before the budget boundary.
    // Take the structured submission turn so the result never depends on
    // free-text JSON. (Skipped after token exhaustion — that path fails
    // closed without another call.)
    if (!submittedResult && !submissionAttempted && !tokenBudgetExceeded) {
      await runSubmissionTurn();
    }
  } catch (err) {
    // Timeout, API failure, or SDK error → incomplete
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker?.getTrace() || [], false, tokensUsed, Date.now() - startTime, "LLM invocation failed: " + err.message, actualModel, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }

  // Token budget exceeded — fail closed to INCOMPLETE
  if (tokenBudgetExceeded) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker?.getTrace() || [], false, tokensUsed, Date.now() - startTime, "Token budget exceeded: " + tokensUsed + " > " + MAX_TOKENS, actualModel, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }

  // ── Parse: prefer the structured submission; fall back to text cascade ──
  const rawText = textParts.join("\n\n");
  let parsed = null;
  if (submittedResult && typeof submittedResult === "object") {
    parsed = submittedResult;
  } else {
    parsed = parseVerifierResult(rawText.trim());
    if (!parsed) {
      for (let i = textParts.length - 1; i >= 0; i--) {
        parsed = parseVerifierResult(textParts[i].trim());
        if (parsed) break;
      }
    }
  }
  if (!parsed) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker.getTrace(), false, tokensUsed, Date.now() - startTime, "Failed to parse verifier response", actualModel, rawText.slice(0, 500), undefined, undefined, invocationInfo, usageAccumulators());
  }

  // ── Deterministic schema validation ──────────────────────────────────────
  const schemaErrors = validateVerifierSchema(parsed);
  if (schemaErrors.length > 0) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker.getTrace(), false, tokensUsed, Date.now() - startTime, "Verifier schema validation failed: " + schemaErrors.join("; "), actualModel, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }

  // ── Falsification risk-ledger validation (fail-closed) ──────────────────
  // `verified` is computed from the ledger; a structurally invalid ledger can
  // never produce it, regardless of the model's declared status. Clearances
  // are evidence-bound: every evidence_cleared obligation must cite at least
  // one reference that survives the RI-4 parser and bounds validation.
  const { errors: ledgerErrors, ledger } = validateRiskLedger(parsed, (parsed.findings || []).length, evidence, verifierContextItems);
  if (ledgerErrors.length > 0) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker.getTrace(), false, tokensUsed, Date.now() - startTime, "Risk-ledger validation failed: " + ledgerErrors.join("; "), actualModel, undefined, undefined, undefined, invocationInfo, usageAccumulators());
  }
  const unresolvedObligations = [];
  for (const cat of ledger.categories) {
    for (const ob of cat.obligations) {
      if (ob.resolution.outcome === OBLIGATION_OUTCOMES.UNRESOLVED) {
        unresolvedObligations.push({ category: cat.category, description: ob.description, reason: ob.resolution.reason });
      }
    }
  }

  // ── Extract fields ───────────────────────────────────────────────────────
  const rawFindings = parsed.findings || [];
  // The frozen contract has contextRequests and unresolvedContextRequests.
  // Support both names for compatibility.
  const contextRequests = parsed.contextRequests || [];
  const coverageSatisfied = parsed.coverageSatisfied === true;
  const modelDeclaredStatus = parsed.status;

  // Material unresolved needs: broker-denied REQUIRED requests plus
  // model-declared entries that are material. A structured entry counts
  // only when requiredForApproval === true; a bare string (model did not
  // follow the structured schema) is treated as material — fail closed.
  const modelDeclared = parsed.unresolvedContextNeeds || parsed.unresolvedContextRequests || [];
  const unresolvedMaterial = [
    ...verifierDeniedRequired.map(function (r) {
      return { source: "broker_budget", tool: r.tool, target: r.target, reason: r.reason };
    }),
    ...modelDeclared
      .filter(function (n) {
        if (typeof n === "string") return true;
        if (n && typeof n === "object") return n.requiredForApproval === true;
        return false;
      })
      .map(function (n) {
        if (typeof n === "string") return { source: "model_declared", description: n };
        return {
          source: "model_declared",
          description: n.description || JSON.stringify(n),
          potentialSeverity: n.potentialSeverity || null,
          basis: n.basis || null,
        };
      }),
  ];

  // ── Validate findings through the evidence-bound validator ───────────────
  // Use the successful broker context items (which carry content for range
  // derivation), not just the trace (which only has contentLength).
  const validatedFindings = [];
  for (const finding of rawFindings) {
    const result = validateFinding(finding, evidence, verifierContextItems);
    if (result.valid) {
      validatedFindings.push(result.finding);
    }
  }

  // ── Check for material findings (P0/P1/P2) ───────────────────────────────
  const materialFindings = validatedFindings.filter(f =>
    [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
  );

  // ── Determine final status ───────────────────────────────────────────────
  // Never promote model-declared incomplete/error to verified.
  // NOTE: consuming the full retrieval budget is NOT an incompleteness
  // signal by itself — a verifier may use its final allowed round, receive
  // all evidence it needed, and legitimately return verified.
  let status;

  if (modelDeclaredStatus === "incomplete" || modelDeclaredStatus === "error") {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (materialFindings.length > 0) {
    status = VERIFIER_STATUS.MATERIAL_FINDINGS;
  } else if (modelDeclaredStatus === "material_findings") {
    // Model declared material findings but none survived validation.
    // Cannot confirm approval safety — fail closed to INCOMPLETE.
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (unresolvedObligations.length > 0) {
    // Falsification contract: an unresolved risk obligation fails closed —
    // a declared status can never clear an obligation the verifier could not.
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (unresolvedMaterial.length > 0) {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (!coverageSatisfied) {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (ledger.categories.some(cat => cat.obligations.some(ob => ob.resolution.outcome === OBLIGATION_OUTCOMES.MATERIAL_FINDING))) {
    // The ledger claims a material obligation but no finding survived
    // validation — inconsistent with a clean verification. Fail closed.
    status = VERIFIER_STATUS.INCOMPLETE;
  } else {
    status = VERIFIER_STATUS.VERIFIED;
  }

  const durationMs = Date.now() - startTime;

  const finalReceipt = makeReceipt(
    status,
    validatedFindings,
    unresolvedMaterial,
    contextRequests,
    broker.getTrace(),
    coverageSatisfied,
    tokensUsed,
    durationMs,
    undefined,
    actualModel,
    rawText.slice(0, 500),
    broker.getBudgetState(),
    rawFindings,
    invocationInfo,
    usageAccumulators(),
  );
  finalReceipt.submissionDiagnostics = submissionDiagnostics;
  finalReceipt.riskLedger = ledger;
  finalReceipt.unresolvedObligations = unresolvedObligations;
  return finalReceipt;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the user prompt with the review evidence (changed files + patches).
 * Does NOT include primary reviewer's findings or verdict.
 */
function buildVerifierUserPrompt(evidence) {
  const parts = [
    "## Approval Candidate Verification",
    "",
    "This PR has been identified as a potential approval candidate.",
    "Independently verify whether it is safe to approve.",
    "",
    "## Changed Files",
    "",
  ];

  for (const cf of (evidence.changedFiles || [])) {
    parts.push("### " + cf.path + " (" + cf.status + ", coverage: " + cf.coverage + ")");
    if (cf.coverageReason) {
      parts.push("_Reason: " + cf.coverageReason + "_");
    }
    if (cf.patch && cf.coverage !== "policy_exempt" && cf.coverage !== "unavailable") {
      parts.push("```diff");
      parts.push(cf.patch);
      parts.push("```");
    }
    parts.push("");
  }

  parts.push("## Instructions");
  parts.push("Use your read and search tools to inspect supporting files.");
  parts.push("Report any P0/P1/P2 issues you find, or confirm this is safe to approve.");

  return parts.join("\n");
}

/**
 * Build a verification receipt.
 */
function makeReceipt(status, findings, unresolvedContextNeeds, contextRequests, contextTrace, coverageSatisfied, tokensUsed, durationMs, error, actualModel, rawTextSnippet, budgetState, rawFindings, invocationInfo, usageAccumulators) {
  // Phase 10 execution profile — descriptive metadata only, built on every
  // receipt path. Missing optional telemetry never fails the verification.
  const invocation = invocationInfo || {};
  const usage = usageFromCategories(usageAccumulators || {});
  const budgetLimits = budgetState?.limits
    ? { maxTokens: invocation.maxTokens ?? null, contextBroker: budgetState.limits }
    : (invocation.maxTokens != null ? { maxTokens: invocation.maxTokens } : null);
  const executionProfile = buildExecutionProfile({
    provider: invocation.provider,
    adapter: invocation.adapter,
    protocol: invocation.protocol,
    requestedRoute: invocation.requestedRoute,
    requestedModel: invocation.requestedModel,
    observedModel: actualModel,
    promptId: invocation.promptId,
    promptHash: invocation.promptHash,
    budgetLimits,
    startedAt: invocation.startTime,
    completedAt: invocation.startTime != null && typeof durationMs === "number"
      ? invocation.startTime + durationMs
      : null,
    durationMs: typeof durationMs === "number" ? durationMs : null,
    terminalState: classifyVerifierTerminal({ status, error: error || null }),
    terminalReason: error || null,
    usage,
  });

  return {
    status,
    findings,
    rawFindings: rawFindings || [],
    unresolvedContextNeeds,
    unresolvedContextRequests: unresolvedContextNeeds, // frozen contract field name
    contextRequests: contextRequests || [],
    contextTrace: contextTrace || [],
    coverageSatisfied,
    tokensUsed: tokensUsed || 0,
    durationMs: durationMs || 0,
    error: error || undefined,
    actualModel: actualModel || null,
    rawTextSnippet: rawTextSnippet || undefined,
    budgetState: budgetState || null,
    executionProfile,
    promptVersion: VERIFIER_PROMPT_VERSION,
    promptHash: VERIFIER_PROMPT_HASH,
    hasMaterialFindings: findings.some(f =>
      [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
    ),
    materialFindingCount: findings.filter(f =>
      [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
    ).length,
    approvalSafe: status === VERIFIER_STATUS.VERIFIED,
  };
}

// ── Schema validation ───────────────────────────────────────────────────────

/**
 * Deterministically validate the verifier result schema.
 * Returns an array of error strings. Empty array means valid.
 */
export function validateVerifierSchema(parsed) {
  const errors = [];

  if (!parsed || typeof parsed !== "object") {
    return ["Result must be an object"];
  }

  // status is required and must be one of the frozen values
  const validStatuses = ["verified", "material_findings", "incomplete"];
  if (!parsed.status || !validStatuses.includes(parsed.status)) {
    errors.push("status must be one of: " + validStatuses.join(", ") + " (got " + JSON.stringify(parsed.status) + ")");
  }

  // findings must be an array if present
  if (parsed.findings !== undefined && !Array.isArray(parsed.findings)) {
    errors.push("findings must be an array");
  }

  // coverageSatisfied must be a boolean if present
  if (parsed.coverageSatisfied !== undefined && typeof parsed.coverageSatisfied !== "boolean") {
    errors.push("coverageSatisfied must be a boolean");
  }

  return errors;
}

// ── Falsification risk-ledger validation (deterministic, fail-closed) ───────
//
// `verified` is schema-valid only when the ledger is COMPLETE (every category
// present exactly once; every category either carries ≥1 obligation or an
// explicit noneJustification) and every obligation's resolution is well
// formed. Outcome-level fail-closed semantics (unresolved → INCOMPLETE) are
// applied by the caller; this function judges only ledger structure.

/**
 * Validate and normalize the verifier's risk ledger.
 *
 * @param {object} parsed - the parsed verifier submission
 * @param {number} findingsCount - bounds-check for material_finding indexes
 * @param {object|null} evidence - ReviewEvidence, for evidence-bound clearance checks
 * @param {object[]} verifierContextItems - successful broker reads, for repo-read checks
 * @returns {{errors: string[], ledger: object|null}} errors is empty iff the
 *   ledger is structurally complete; ledger is the normalized copy for the
 *   receipt (null when structurally invalid).
 */
export function validateRiskLedger(parsed, findingsCount = 0, evidence = null, verifierContextItems = []) {
  const errors = [];
  const ledger = parsed && typeof parsed === "object" ? parsed.riskLedger : null;

  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.categories)) {
    return { errors: ["riskLedger with a categories array is required"], ledger: null };
  }

  const seen = new Map();
  for (const entry of ledger.categories) {
    if (!entry || typeof entry !== "object" || typeof entry.category !== "string") {
      errors.push("ledger category entry must be an object with a category id");
      continue;
    }
    if (!RISK_CATEGORY_IDS.includes(entry.category)) {
      errors.push("unknown ledger category: " + JSON.stringify(entry.category));
      continue;
    }
    if (seen.has(entry.category)) {
      errors.push("duplicate ledger category: " + entry.category);
      continue;
    }
    seen.set(entry.category, entry);

    const obligations = Array.isArray(entry.obligations) ? entry.obligations : null;
    const noneJustification = typeof entry.noneJustification === "string" && entry.noneJustification.trim().length > 0
      ? entry.noneJustification.trim()
      : null;

    if (obligations === null) {
      errors.push(entry.category + ": obligations must be an array");
      continue;
    }
    if (obligations.length === 0 && !noneJustification) {
      errors.push(entry.category + ": empty category requires a noneJustification");
      continue;
    }

    for (let i = 0; i < obligations.length; i++) {
      const ob = obligations[i];
      const where = entry.category + " obligation[" + i + "]";
      if (!ob || typeof ob !== "object" || typeof ob.description !== "string" || ob.description.trim().length === 0) {
        errors.push(where + ": description is required");
        continue;
      }
      const resolution = ob.resolution;
      if (!resolution || typeof resolution !== "object" || typeof resolution.outcome !== "string") {
        errors.push(where + ": resolution.outcome is required");
        continue;
      }
      if (!Object.values(OBLIGATION_OUTCOMES).includes(resolution.outcome)) {
        errors.push(where + ": unknown resolution outcome " + JSON.stringify(resolution.outcome));
        continue;
      }
      if (resolution.outcome === OBLIGATION_OUTCOMES.EVIDENCE_CLEARED) {
        const refs = Array.isArray(resolution.evidenceRefs)
          ? resolution.evidenceRefs.filter(r => typeof r === "string" && r.trim().length > 0)
          : [];
        if (refs.length === 0) {
          errors.push(where + ": evidence_cleared requires at least one evidenceRef");
        } else {
          // Evidence-bound clearances: a citation-shaped string is not
          // evidence. Every clearance must carry ≥1 reference that parses and
          // passes the same RI-4 bounds validation used for findings —
          // against the ReviewEvidence and the verifier's successful reads.
          const validCount = refs.filter(function (r) {
            const parsedRef = parseEvidenceRef(r);
            return parsedRef !== null && validateEvidenceRef(parsedRef, evidence, verifierContextItems).valid === true;
          }).length;
          if (validCount === 0) {
            errors.push(where + ": evidence_cleared requires at least one valid repository evidence reference (parsed and bounds-checked against ReviewEvidence and verifier context)");
          }
        }
      }
      if (resolution.outcome === OBLIGATION_OUTCOMES.MATERIAL_FINDING) {
        const idx = resolution.findingIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx >= findingsCount) {
          errors.push(where + ": material_finding requires findingIndex within findings bounds");
        }
      }
      if (resolution.outcome === OBLIGATION_OUTCOMES.UNRESOLVED) {
        if (typeof resolution.reason !== "string" || resolution.reason.trim().length === 0) {
          errors.push(where + ": unresolved requires a reason");
        }
      }
    }
  }

  for (const id of RISK_CATEGORY_IDS) {
    if (!seen.has(id)) {
      errors.push("missing ledger category: " + id);
    }
  }

  if (errors.length > 0) return { errors, ledger: null };

  // Normalize a receipt-safe copy with bounded strings.
  const normalized = {
    complete: true,
    categories: ledger.categories.map(entry => ({
      category: entry.category,
      noneJustification: (entry.noneJustification || "").slice(0, 300) || null,
      obligations: (entry.obligations || []).map(ob => ({
        description: String(ob.description).slice(0, 300),
        resolution: {
          outcome: ob.resolution.outcome,
          evidenceRefs: (ob.resolution.evidenceRefs || []).slice(0, 10).map(String),
          findingIndex: Number.isInteger(ob.resolution.findingIndex) ? ob.resolution.findingIndex : null,
          reason: ob.resolution.reason ? String(ob.resolution.reason).slice(0, 300) : null,
        },
      })),
    })),
  };
  return { errors: [], ledger: normalized };
}
