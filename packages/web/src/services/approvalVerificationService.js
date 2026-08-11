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
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], false, 0, Date.now() - startTime, "Missing review root with base/head SHAs");
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
    return makeReceipt(VERIFIER_STATUS.ERROR, [], [], [], false, 0, Date.now() - startTime, "Failed to create context broker: " + err.message);
  }

  // ── Build the prompt ─────────────────────────────────────────────────────
  const systemPrompt = buildVerifierSystemPrompt(evidence);
  const userPrompt = buildVerifierUserPrompt(evidence);

  // ── Invoke the LLM with timeout ──────────────────────────────────────────
  let rawText = "";
  let tokensUsed = 0;

  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Verifier timed out after " + maxDurationMs + "ms")), maxDurationMs);
    });

    const llmPromise = anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const message = await Promise.race([llmPromise, timeoutPromise]);

    // Extract text
    if (Array.isArray(message.content)) {
      rawText = message.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    } else if (typeof message.content === "string") {
      rawText = message.content;
    }

    tokensUsed = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);
  } catch (err) {
    // Timeout, API failure, or SDK error → incomplete
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], false, tokensUsed, Date.now() - startTime, "LLM invocation failed: " + err.message);
  }

  // ── Parse the response ───────────────────────────────────────────────────
  const parsed = parseVerifierResult(rawText.trim());
  if (!parsed) {
    return makeReceipt(VERIFIER_STATUS.INCOMPLETE, [], [], [], false, tokensUsed, Date.now() - startTime, "Failed to parse verifier response");
  }

  // ── Extract fields ───────────────────────────────────────────────────────
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const unresolvedContextNeeds = Array.isArray(parsed.unresolvedContextNeeds) ? parsed.unresolvedContextNeeds : [];
  const coverageSatisfied = parsed.coverageSatisfied !== false; // default true if not explicitly false

  // ── Validate findings through the evidence-bound validator ───────────────
  const brokerTrace = broker.getTrace();
  const validatedFindings = [];
  for (const finding of rawFindings) {
    const result = validateFinding(finding, evidence, brokerTrace);
    if (result.valid) {
      validatedFindings.push(result.finding);
    }
    // Invalid findings from the verifier are silently dropped — the validator
    // is the authority, not the verifier's output.
  }

  // ── Check for material findings (P0/P1/P2) ───────────────────────────────
  const materialFindings = validatedFindings.filter(f =>
    [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
  );

  // ── Determine final status ───────────────────────────────────────────────
  let status;

  if (materialFindings.length > 0) {
    status = VERIFIER_STATUS.MATERIAL_FINDINGS;
  } else if (unresolvedContextNeeds.length > 0) {
    // Unresolved material context needs → incomplete → no APPROVE
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (!coverageSatisfied) {
    // Verifier says coverage is not satisfied → incomplete
    status = VERIFIER_STATUS.INCOMPLETE;
  } else if (broker.getBudgetState().exhausted && validatedFindings.length === 0) {
    // Budget was exhausted and verifier found nothing — may not have had
    // enough context to complete verification
    status = VERIFIER_STATUS.INCOMPLETE;
  } else {
    status = VERIFIER_STATUS.VERIFIED;
  }

  const durationMs = Date.now() - startTime;

  return makeReceipt(
    status,
    validatedFindings,
    unresolvedContextNeeds,
    brokerTrace,
    coverageSatisfied,
    tokensUsed,
    durationMs,
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
function makeReceipt(status, findings, unresolvedContextNeeds, contextTrace, coverageSatisfied, tokensUsed, durationMs, error) {
  return {
    status,
    findings,
    unresolvedContextNeeds,
    contextTrace,
    coverageSatisfied,
    tokensUsed,
    durationMs,
    error: error || undefined,
    // Material finding severities for quick policy checks
    hasMaterialFindings: findings.some(f =>
      [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
    ),
    materialFindingCount: findings.filter(f =>
      [SEVERITY.P0, SEVERITY.P1, SEVERITY.P2].includes(f.severity)
    ).length,
    // True only when status is exactly VERIFIED
    approvalSafe: status === VERIFIER_STATUS.VERIFIED,
  };
}
