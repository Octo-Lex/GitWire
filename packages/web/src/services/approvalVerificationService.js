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

import { logger } from "../lib/logger.js";
import { createContextBroker, DEFAULT_BUDGETS as BROKER_BUDGETS } from "./reviewContextBroker.js";
import { validateFinding, SEVERITY } from "./findingValidator.js";

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
  return [
    "You are an independent approval verifier for a code review system.",
    "",
    "A primary review has completed on this PR. You do NOT know its verdict,",
    "confidence, or findings. Your job is to independently verify whether this",
    "PR is safe to approve.",
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
    "Your objectives:",
    "1. Find missed P0/P1/P2 regressions the primary reviewer may have overlooked.",
    "2. Find stale declarations or documentation that contradict the changes.",
    "3. Find caller/helper inconsistencies — changed function signatures,",
    "   removed exports, broken interfaces.",
    "4. Find missing test/doc/config updates that the changes require.",
    "5. Find contradictory repository contracts.",
    "6. Challenge assumptions the changes make.",
    "7. Re-evaluate whether apparent P3 risks are really P2+.",
    "8. Identify unresolved evidence needs — things you needed to check but",
    "   could not due to budget limits or missing data.",
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
    '  "unresolvedContextNeeds": ["description of things you needed but could not retrieve"],',
    '  "coverageSatisfied": true | false',
    "}",
    "",
    "Rules:",
    "- Use status 'verified' only if you found zero P0/P1/P2 issues AND have",
    "  no unresolved material context needs AND coverageSatisfied is true.",
    "- Use status 'material_findings' if you found any P0/P1/P2 issue.",
    "- Use status 'incomplete' if you could not complete verification due to",
    "  budget limits, missing data, or unresolved context needs.",
    "- Every P0/P1/P2 finding MUST include at least one evidence reference",
    "  pointing to a specific file and line range in the changed files or",
    "  retrieved repository context.",
    "- You have a LIMITED number of file reads and searches. Use them wisely.",
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

  // ── Guard: evidence must have a review root with required SHAs ──────────
  if (!reviewRoot || !reviewRoot.baseSha || !reviewRoot.headSha) {
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], [], false, 0, Date.now() - startTime, "Missing review root with base/head SHAs");
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
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], [], false, 0, Date.now() - startTime, "Failed to create context broker: " + err.message);
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
        },
        required: ["query", "ref"],
      },
    },
  ];

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
  const verifierContextItems = []; // successful broker results for finding validation

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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

      tokensUsed += (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

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

      // If no tool-use, the model is done — extract the final text
      if (message.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
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

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    // Timeout, API failure, or SDK error → incomplete
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker?.getTrace() || [], false, tokensUsed, Date.now() - startTime, "LLM invocation failed: " + err.message, actualModel);
  }

  // ── Parse: try each accumulated text part (model may produce JSON in an
  //    earlier tool-use round and a summary in the final round). ───────────
  const rawText = textParts.join("\n\n");
  let parsed = parseVerifierResult(rawText.trim());
  if (!parsed) {
    for (let i = textParts.length - 1; i >= 0; i--) {
      parsed = parseVerifierResult(textParts[i].trim());
      if (parsed) break;
    }
  }
  if (!parsed) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker.getTrace(), false, tokensUsed, Date.now() - startTime, "Failed to parse verifier response", actualModel, rawText.slice(0, 500));
  }

  // ── Deterministic schema validation ──────────────────────────────────────
  const schemaErrors = validateVerifierSchema(parsed);
  if (schemaErrors.length > 0) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], broker.getTrace(), false, tokensUsed, Date.now() - startTime, "Verifier schema validation failed: " + schemaErrors.join("; "), actualModel);
  }

  // ── Extract fields ───────────────────────────────────────────────────────
  const rawFindings = parsed.findings || [];
  // The frozen contract has contextRequests and unresolvedContextRequests.
  // Support both names for compatibility.
  const contextRequests = parsed.contextRequests || [];
  const unresolvedContextNeeds = parsed.unresolvedContextNeeds || parsed.unresolvedContextRequests || [];
  const coverageSatisfied = parsed.coverageSatisfied === true;
  const modelDeclaredStatus = parsed.status;

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
  let status;

  if (modelDeclaredStatus === "incomplete" || modelDeclaredStatus === "error") {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (materialFindings.length > 0) {
    status = VERIFIER_STATUS.MATERIAL_FINDINGS;
  } else if (modelDeclaredStatus === "material_findings") {
    // Model declared material findings but none survived validation.
    // Cannot confirm approval safety — fail closed to INCOMPLETE.
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (unresolvedContextNeeds.length > 0) {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (!coverageSatisfied) {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (broker.getBudgetState().exhausted && validatedFindings.length === 0) {
    status = VERIFIER_STATUS.INCOMPLETE;
  } else {
    status = VERIFIER_STATUS.VERIFIED;
  }

  const durationMs = Date.now() - startTime;

  return makeReceipt(
    status,
    validatedFindings,
    unresolvedContextNeeds,
    contextRequests,
    broker.getTrace(),
    coverageSatisfied,
    tokensUsed,
    durationMs,
    undefined,
    actualModel,
  );
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
function makeReceipt(status, findings, unresolvedContextNeeds, contextRequests, contextTrace, coverageSatisfied, tokensUsed, durationMs, error, actualModel, rawTextSnippet) {
  return {
    status,
    findings,
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
    budgetState: null, // populated by caller if broker exists
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
