// src/services/primaryReviewService.js
// Evidence-bound Primary Reviewer for Review Integrity v2.
//
// In the v2 production path, this replaces the legacy diff-oriented
// runStructuredReview. The primary reviewer receives ReviewEvidence
// (changed files with patches + coverage manifest) and has bounded
// read/search tools to inspect the broader repository at immutable SHAs.
//
// The model produces RI-4-style findings directly — severity, claim,
// affectedPaths, evidenceRefs, proof, confidence — instead of the legacy
// schema that required GitWire to manufacture evidence references afterward.
//
// The primary reviewer has its OWN Context Broker, separate from the
// independent verifier's broker. Both operate within the same frozen budgets.

import { createHash } from "node:crypto";
import { createContextBroker, DEFAULT_BUDGETS as BROKER_BUDGETS } from "./reviewContextBroker.js";
import { validateFinding, SEVERITY } from "./findingValidator.js";

// ── Prompt version (for instrumentation) ─────────────────────────────────────

const PROMPT_VERSION = "v2-primary-r1";
const PROMPT_HASH = createHash("sha256")
  .update(PROMPT_VERSION + ":evidence-bound-cross-file")
  .digest("hex").slice(0, 16);

// ── Tool definitions (shared shape with verifier) ───────────────────────────

const REVIEW_TOOLS = [
  {
    name: "read_repo_file",
    description:
      "Read a file at an immutable commit SHA (base or head of the PR). " +
      "Use to inspect supporting files, callers, imports, configs, tests, " +
      "documentation, or any unchanged file that the changes depend on.",
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
        requiredForApproval: { type: "boolean", description: "True if this dependency MUST be checked before approval can be justified. False for exploratory reads." },
      },
      required: ["path", "ref"],
    },
  },
  {
    name: "search_repo_text",
    description:
      "Search repository content for a text query at an immutable commit SHA. " +
      "Returns matching files with line numbers and fragments. Use to find " +
      "callers, references, or related declarations.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive search query" },
        ref: { type: "string", description: "Commit SHA — must be the PR's base or head SHA" },
        purpose: { type: "string", description: "Why this search is needed" },
        requiredForApproval: { type: "boolean", description: "True if this search MUST succeed before approval can be justified. False for exploratory searches." },
      },
      required: ["query", "ref"],
    },
  },
];

// ── Structured final submission tool ────────────────────────────────────────
// Exposed ONLY in the retrieval-closed final turn. Parsing tool_use.input
// directly removes the free-text JSON serialization failure mode.

const SUBMIT_REVIEW_TOOL = {
  name: "submit_review_result",
  description:
    "Submit the final review result. You MUST use this tool to submit your result — do not write JSON as plain text.",
  input_schema: {
    type: "object",
    properties: {
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
            confidence: { type: "number" },
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
    },
    required: ["findings"],
  },
};

// ── System prompt ────────────────────────────────────────────────────────────

/**
 * Build the primary reviewer's system prompt.
 *
 * This prompt is GENERIC — no fixture-specific hints, expected defect titles,
 * expected file paths, or case-specific wording. It instructs the model to
 * treat changed files as the starting point, use repository tools for
 * supporting evidence, and produce evidence-bound findings.
 */
export function buildPrimarySystemPrompt(evidence) {
  const coverage = evidence?.coverage || {};
  return [
    "You are a senior code reviewer for a pull request.",
    "",
    "## What you are given",
    "",
    "You receive the list of changed files with their diffs, the coverage",
    "manifest, and PR metadata. These changed files are your STARTING POINT.",
    "",
    "## Immutable commit SHAs",
    "",
    "Use these exact SHA values for all read_repo_file and search_repo_text calls:",
    "- BASE (old version, before the PR): " + (evidence?.review?.baseSha || "UNKNOWN"),
    "- HEAD (new version, after the PR): " + (evidence?.review?.headSha || "UNKNOWN"),
    "",
    "manifest, and PR metadata. These changed files are your STARTING POINT.",
    "",
    "However, correctness does not stop at the diff boundary. A change can",
    "introduce a regression, break a caller, contradict a documented contract,",
    "or miss a required update in an unchanged file. You have tools to inspect",
    "the broader repository at the exact base and head commit SHAs.",
    "",
    "## What counts as correctness material",
    "",
    "- Source code: changed AND unchanged callers, helpers, interfaces, imports.",
    "- Normative documentation: status declarations, executable specifications,",
    "  configuration contracts, API contracts, README instructions, gate",
    "  definitions. When a change can contradict such a document, the document",
    "  is correctness material — not prose or style.",
    "- Tests and configuration: missing test or config updates that the changes",
    "  require are valid findings.",
    "- Prose, formatting, and style preferences are NOT correctness material.",
    "",
    "## How to use your tools",
    "",
    "You have two tools: read_repo_file and search_repo_text. Both operate at",
    "immutable commit SHAs (the PR's base and head). Use them to:",
    "- Read an unchanged file to check whether a changed function's callers",
    "  are compatible.",
    "- Read a config, test, or documentation file to check whether the changes",
    "  require an update there.",
    "- Search for references to a changed symbol, import, or contract.",
    "You have a LIMITED number of reads and searches. Prioritize checking",
    "cross-file dependencies before style concerns.",
    "",
    "## Dependency traversal priority",
    "",
    "When a change expands when, where, or how often an existing helper or",
    "callee executes, inspect that helper's implementation and assumptions",
    "at HEAD before broad repository exploration. Follow directly involved",
    "imports and callees first. If you cannot resolve a correctness-material",
    "dependency within the available budget, report it as an unresolved",
    "context need rather than declaring the review complete.",
    "",
    "## Finding schema",
    "",
    "Produce your response as a JSON object:",
    "{",
    '  "findings": [',
    "    {",
    '      "severity": "P0" | "P1" | "P2" | "P3",',
    '      "category": "bug" | "security" | "regression" | "test_gap" | "docs_gap" | "config_gap" | "maintainability",',
    '      "claim": "short one-line description of the issue",',
    '      "description": "detailed explanation of the problem and its impact",',
    '      "affectedPaths": ["path/to/changed/file", "path/to/unchanged/file"],',
    '      "evidenceRefs": [',
    '        "changed:path/to/file@HEAD:Lstart-Lend",',
    '        "repo-read:path/to/file@SIDE:Lline"',
    "      ],",
    '      "proof": { "type": "static_trace" | "counterexample" | "reproduction" | "inference", "summary": "..." },',
    '      "confidence": 0.0',
    "    }",
    "  ],",
    '  "unresolvedContextNeeds": [',
    "    {",
    '      "description": "what could not be checked and why it matters",',
    '      "requiredForApproval": true,',
    '      "potentialSeverity": "P0" | "P1" | "P2",',
    '      "basis": "repository_dependency" | "changed_contract"',
    "    }",
    "  ]",
    "}",
    "",
    "## Evidence reference format",
    "",
    '- changed:PATH@SIDE:Lstart-Lend — cite lines in a changed file. SIDE is',
    "  HEAD (new version) or BASE (old version). The line range must fall",
    "  within the diff hunks for that file.",
    "- repo-read:PATH@SIDE:Lline — cite a line in an unchanged file you read",
    "  via read_repo_file. SIDE is HEAD or BASE.",
    "",
    "Every P0/P1/P2 finding MUST include at least one evidence reference.",
    "A material cross-file finding should cite BOTH the changed trigger",
    "(changed: evidence ref) AND the unchanged supporting evidence",
    "(repo-read: evidence ref) when the supporting file is not in the diff.",
    "",
    "## Severity guidance",
    "",
    "- P0: Critical — data loss, security vulnerability, crash, or total",
    "  breakage of a core flow.",
    "- P1: High — a real bug or regression that will fail in production.",
    "- P2: Medium — a correctness issue, contract violation, or missing",
    "  required update that should be addressed before merge.",
    "- P3: Low — style, minor improvement, or low-risk observation.",
    "",
    "## Rules",
    "",
    "- Omit low-confidence speculation. If you are not confident enough to",
    "  provide evidence, do not include the finding.",
    "- Do not invent evidence references for lines you did not verify.",
    "- If you could not check a correctness-material dependency due to budget",
    "  limits or missing data, report it as an unresolved context need in",
    '  "unresolvedContextNeeds" rather than omitting it or guessing.',
    "  An unresolved material dependency means approval evidence is incomplete.",
    "- Report an unresolved context need only when the missing evidence could",
    "  plausibly conceal a P0/P1/P2 defect introduced or exposed by this PR.",
    "  Do not report optional completeness checks, low-confidence speculation,",
    "  or historical/external facts that the repository is not expected to",
    "  contain, unless a repository contract specifically requires that",
    "  evidence to be committed or referenced.",
    "",
    "## Coverage manifest",
    "",
    "  Total changed files: " + (coverage.totalChangedFiles ?? "?"),
    "  Fully covered: " + (coverage.fullyCoveredFiles ?? "?"),
    "  Policy exempt: " + (coverage.policyExemptFiles ?? "?"),
    "  Partial: " + (coverage.partialFiles ?? "?"),
    "  Unavailable: " + (coverage.unavailableFiles ?? "?"),
    "",
  ].join("\n");
}

// ── User prompt ──────────────────────────────────────────────────────────────

/**
 * Build the primary reviewer's user prompt with PR metadata and changed-file diffs.
 */
function buildPrimaryUserPrompt(evidence, prMeta) {
  const parts = [
    "## Pull Request",
    "",
    "Title: " + (prMeta.title || "(no title)"),
    "Author: " + (prMeta.author || "unknown"),
    "Branch: " + (prMeta.branch || "unknown"),
    "Repository: " + (prMeta.repoName || "unknown"),
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
  parts.push("Review this pull request for correctness, regressions, and contract violations.");
  parts.push("Changed files are your starting point. Use your read and search tools to check");
  parts.push("cross-file dependencies, documentation consistency, and required updates.");
  parts.push("Produce findings in the JSON schema described in your system prompt.");

  return parts.join("\n");
}

// ── Response parser (same cascade as verifier) ──────────────────────────────

function parsePrimaryResult(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const trimmed = rawText.trim();

  try { return JSON.parse(trimmed); } catch (_e) { /* continue */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_e) { /* continue */ }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1)); } catch (_e) { /* continue */ }
  }

  return null;
}

// ── Schema validation ───────────────────────────────────────────────────────

function validatePrimarySchema(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") return ["Result must be an object"];
  if (parsed.findings !== undefined && !Array.isArray(parsed.findings)) {
    errors.push("findings must be an array");
  }
  return errors;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the evidence-bound primary review.
 *
 * @param {object} params
 * @param {object} params.evidence - ReviewEvidence from buildReviewEvidence
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {object} params.anthropic - Anthropic SDK instance
 * @param {string} [params.model] - model identifier
 * @param {object} [params.prMeta] - { title, author, branch, repoName }
 * @param {object} [params.primaryBudgets] - override default budgets
 * @param {number} [params.maxDurationMs] - timeout
 * @returns {Promise<object>} primary review receipt
 */
export async function runPrimaryReview({
  evidence,
  octokit,
  owner,
  repo,
  anthropic,
  model = "claude-sonnet-4-20250514",
  prMeta = {},
  primaryBudgets,
  maxDurationMs = 180000,
}) {
  const startTime = Date.now();
  const reviewRoot = evidence?.review;

  if (!reviewRoot || !reviewRoot.baseSha || !reviewRoot.headSha) {
    return makePrimaryReceipt([], [], [], null, 0, Date.now() - startTime, "Missing review root with base/head SHAs");
  }

  // ── Create primary's own Context Broker ─────────────────────────────────
  let broker;
  try {
    broker = createContextBroker({
      octokit, owner, repo,
      baseSha: reviewRoot.baseSha,
      headSha: reviewRoot.headSha,
      budgets: primaryBudgets?.contextBroker,
    });
  } catch (err) {
    return makePrimaryReceipt([], [], [], null, 0, Date.now() - startTime, "Failed to create context broker: " + err.message);
  }

  const systemPrompt = buildPrimarySystemPrompt(evidence);
  const userPrompt = buildPrimaryUserPrompt(evidence, prMeta);

  // ── Deadline helper ─────────────────────────────────────────────────────
  const deadline = startTime + maxDurationMs;
  function withDeadline(promise, label) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new Error("Primary review timed out: " + label));
    }
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Primary review timed out: " + label + " after " + maxDurationMs + "ms")), remaining),
      ),
    ]);
  }

  // ── Tool-use loop ───────────────────────────────────────────────────────
  const textParts = []; // accumulate text from all rounds (don't overwrite)
  let tokensUsed = 0;
  let actualModel = null;
  let messages = [{ role: "user", content: userPrompt }];
  const MAX_TOOL_ROUNDS = 8;
  const MAX_TOKENS = primaryBudgets?.maxTokens || 100000;
  const primaryContextItems = [];
  const unresolvedBrokerRequests = []; // budget_exceeded tool calls
  let tokenBudgetExceeded = false;

  let submittedResult = null; // structured final submission via tool_use
  let submissionAttempted = false; // one submission turn per invocation
  let submissionDiagnostics = null; // what the submission turn actually returned

  try {
    // Structured submission turn: only the submission tool is exposed and
    // its tool_use.input is parsed directly (no free-text JSON dependency).
    // Runs when retrieval closes — either by budget exhaustion OR by the
    // model naturally stopping tool use.
    async function runSubmissionTurn() {
      submissionAttempted = true;
      messages.push({
        role: "user",
        content: "Repository retrieval is now closed. Call the submit_review_result tool NOW with your complete final result — do not write any preamble or narrative text first. If any correctness-material dependency still must be checked before approval can be justified, include it in unresolvedContextNeeds with requiredForApproval: true.",
      });
      const finalMsg = await withDeadline(
        anthropic.messages.create({
          model, max_tokens: 8192, system: systemPrompt,
          tools: [SUBMIT_REVIEW_TOOL],
          messages,
        }),
        "LLM final submission",
      );
      if (finalMsg.model && !actualModel) actualModel = finalMsg.model;
      tokensUsed += (finalMsg.usage?.input_tokens ?? 0) + (finalMsg.usage?.output_tokens ?? 0);
      if (tokensUsed > MAX_TOKENS) tokenBudgetExceeded = true;
      const submitBlocks = Array.isArray(finalMsg.content)
        ? finalMsg.content.filter(b => b.type === "tool_use" && b.name === "submit_review_result")
        : [];
      if (submitBlocks.length > 0) {
        submittedResult = submitBlocks[submitBlocks.length - 1].input;
      }
      const finalTextBlocks = Array.isArray(finalMsg.content) ? finalMsg.content.filter(b => b.type === "text") : [];
      const finalText = finalTextBlocks.map(b => b.text).join("\n");
      if (finalText) textParts.push(finalText);
      // Capture what the submission turn returned for diagnosis when the
      // model refuses the tool — stop_reason and the TAIL of its text.
      submissionDiagnostics = {
        stopReason: finalMsg.stop_reason || null,
        usedSubmitTool: submitBlocks.length > 0,
        textTail: finalText ? finalText.slice(-300) : null,
        outputTokens: finalMsg.usage?.output_tokens ?? 0,
      };
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Budget exhaustion → close retrieval and take the structured submission
      const bs = broker.getBudgetState();
      const maxRounds = bs.limits?.maxContextRounds || 4;
      if (round > 0 && bs.contextRounds >= maxRounds) {
        await runSubmissionTurn();
        break;
      }

      const message = await withDeadline(
        anthropic.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          tools: REVIEW_TOOLS,
          messages,
        }),
        "LLM call (round " + round + ")",
      );

      // Capture actual model identity from the provider response
      if (message.model && !actualModel) actualModel = message.model;

      tokensUsed += (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

      // Token ceiling — fail closed, do not parse budget-exhausted output
      if (tokensUsed > MAX_TOKENS) {
        tokenBudgetExceeded = true;
        break;
      }

      const toolUseBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === "tool_use")
        : [];
      const textBlocks = Array.isArray(message.content)
        ? message.content.filter(b => b.type === "text")
        : [];

      if (textBlocks.length > 0) {
        textParts.push(textBlocks.map(b => b.text).join("\n"));
      }

      if (message.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        // Natural stop — keep the assistant turn in the conversation so the
        // submission instruction that follows lands on a valid user turn.
        messages.push({ role: "assistant", content: message.content });
        break;
      }

      messages.push({ role: "assistant", content: message.content });

      const toolResults = [];
      for (const block of toolUseBlocks) {
        let result;
        if (block.name === "read_repo_file") {
          result = await withDeadline(
            broker.readRepoFile(block.input.path, block.input.ref, { range: block.input.range }),
            "read_repo_file",
          );
          if (result && !result.error) primaryContextItems.push(result);
        } else if (block.name === "search_repo_text") {
          result = await withDeadline(
            broker.searchRepoText(block.input.query, block.input.ref),
            "search_repo_text",
          );
          if (result && result.results) {
            for (const r of result.results) {
              primaryContextItems.push({
                path: r.path, type: "search_result",
                ref: r.ref || r.resolvedSha, resolvedSha: r.resolvedSha,
                content: r.fragment,
              });
            }
          }
        } else {
          result = { error: "unknown_tool" };
        }

        // Capture broker denials as unresolved context requests ONLY when
        // the model declared the request as requiredForApproval. Exploratory
        // denials stay in the retrieval trace for audit but do not
        // automatically invalidate approval evidence.
        if (result && typeof result === "object") {
          var isDenied = (result.error && result.error !== "unknown_tool") ||
                         (result.truncated && (!result.results || result.results.length === 0) && result.reason);
          if (isDenied && block.input?.requiredForApproval === true) {
            unresolvedBrokerRequests.push({
              tool: block.name,
              target: block.input?.path || block.input?.query || null,
              reason: result.error || result.reason,
              purpose: block.input?.purpose || null,
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

    // Natural stop: the model ended tool use before the budget boundary
    // (stop_reason end_turn). Retrieval is closed — take the structured
    // submission turn here too, so the result never depends on the model
    // serializing JSON into free text. (Skipped after token exhaustion —
    // that path fails closed without another call.)
    if (!submittedResult && !submissionAttempted && !tokenBudgetExceeded) {
      await runSubmissionTurn();
    }
  } catch (err) {
    return makePrimaryReceipt(
      [], [], broker?.getTrace() || [], broker?.getBudgetState() || null,
      tokensUsed, Date.now() - startTime, "LLM invocation failed: " + err.message,
      actualModel,
    );
  }

  // Token budget exceeded — fail closed. Do not parse budget-exhausted
  // output into an approval-eligible primary result.
  if (tokenBudgetExceeded) {
    return makePrimaryReceipt(
      [], [], broker?.getTrace() || [], broker?.getBudgetState() || null,
      tokensUsed, Date.now() - startTime,
      "Token budget exceeded: " + tokensUsed + " > " + MAX_TOKENS,
      actualModel,
    );
  }

  // ── Parse: prefer the structured submission; fall back to text cascade ──
  const rawText = textParts.join("\n\n");
  let parsed = null;
  if (submittedResult && typeof submittedResult === "object") {
    parsed = submittedResult;
  } else {
    parsed = parsePrimaryResult(rawText);
    if (!parsed) {
      for (let i = textParts.length - 1; i >= 0; i--) {
        parsed = parsePrimaryResult(textParts[i]);
        if (parsed) break;
      }
    }
  }
  if (!parsed) {
    return makePrimaryReceipt(
      [], [], broker.getTrace(), broker.getBudgetState(),
      tokensUsed, Date.now() - startTime, "Failed to parse primary review response",
      actualModel, rawText.slice(0, 2000),
    );
  }

  const schemaErrors = validatePrimarySchema(parsed);
  if (schemaErrors.length > 0) {
    return makePrimaryReceipt(
      [], [], broker.getTrace(), broker.getBudgetState(),
      tokensUsed, Date.now() - startTime, "Schema validation failed: " + schemaErrors.join("; "),
      actualModel,
    );
  }

  // ── Validate each finding through the evidence-bound validator ──────────
  const rawFindings = parsed.findings || [];
  const validatedFindings = [];
  for (const finding of rawFindings) {
    const result = validateFinding(finding, evidence, primaryContextItems);
    if (result.valid) {
      validatedFindings.push(result.finding);
    }
  }

  // Merge broker-denied REQUIRED requests with model-declared MATERIAL
  // unresolved needs. A structured entry blocks only when
  // requiredForApproval === true; a bare string (model did not follow the
  // structured schema) is treated as material — fail closed.
  const modelUnresolved = parsed.unresolvedContextNeeds || parsed.unresolvedContextRequests || [];
  const allUnresolved = [
    ...unresolvedBrokerRequests.map(function (r) {
      return { source: "broker_budget", tool: r.tool, target: r.target, reason: r.reason };
    }),
    ...modelUnresolved
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

  return makePrimaryReceipt(
    rawFindings,
    validatedFindings,
    broker.getTrace(),
    broker.getBudgetState(),
    tokensUsed,
    Date.now() - startTime,
    undefined,
    actualModel,
    rawText.slice(0, 500),
    allUnresolved,
    submissionDiagnostics,
  );
}

// ── Receipt builder ─────────────────────────────────────────────────────────

function makePrimaryReceipt(rawFindings, validatedFindings, retrievalTrace, budgetState, tokensUsed, durationMs, error, actualModel, rawText, unresolvedContextRequests, submissionDiagnostics) {
  return {
    findings: validatedFindings,
    rawFindings: rawFindings || [],
    retrievalTrace: retrievalTrace || [],
    budgetState: budgetState || null,
    tokensUsed: tokensUsed || 0,
    durationMs: durationMs || 0,
    error: error || undefined,
    rawTextSnippet: rawText ? rawText.slice(0, 500) : undefined,
    unresolvedContextRequests: unresolvedContextRequests || [],
    submissionDiagnostics: submissionDiagnostics || null,
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    actualModel: actualModel || null,
    hasMaterialFindings: (validatedFindings || []).some(f =>
      [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity),
    ),
  };
}
