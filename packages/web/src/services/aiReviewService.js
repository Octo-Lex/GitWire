// src/services/aiReviewService.js
// Pre-merge AI review gate — v2 with bundle-driven review.
//
// Adapted from prior autoreview work autoreview patterns:
//   - Bundle-driven: one structured prompt with full PR context
//   - Strict JSON schema enforcement at AI boundary
//   - Out-of-scope finding rejection
//   - JSON extraction cascade (handles all LLM output formats)
//   - Heartbeat wrapper for long-running reviews
//
// Flow:
//   1. Check repo has AI review enabled
//   2. Create a "pending" GitHub Check Run
//   3. Fetch diff + build review bundle (context-enriched)
//   4. Single-pass structured review via Claude with schema enforcement
//   5. Extract JSON with cascade (handles fenced, JSONL, nested formats)
//   6. Validate schema + scope-filter findings
//   7. Compute verdict from validated report
//   8. Post GitHub PR Review with finding annotations
//   9. Update Check Run to pass/fail
//  10. Write to audit trail
//  11. Persist to ai_reviews table (with new structured columns)

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { Trail }  from "./auditTrailService.js";
import { Events } from "./pipelineEvents.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { minimatch } from "minimatch";
import {
  extractReviewJSON,
  buildReviewSystemPrompt,
  reportToLegacy,
} from "@gitwire/rules";
import { buildReviewBundle } from "./reviewBundleService.js";
import { validateReview } from "./reviewValidator.js";
import { withHeartbeat } from "./reviewHeartbeat.js";
import { runAdversarialChallenge, refineFindings } from "./adversarialReview.js";
import { runDefensePass, refineWithDefense } from "./adversarialDefense.js";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
});

const CHECK_RUN_NAME = "GitWire AI Review";
const DEFAULT_MAX_DURATION_MS = 300000; // 5 minutes
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {object} opts.pr          - GitHub pull_request payload
 * @param {object} opts.repository  - GitHub repository payload
 * @param {object} opts.octokit
 * @param {boolean} [opts.commentFindings=true]
 */
export async function reviewPR({ pr, repository, octokit, commentFindings = true, principalId = null, surfaceId = null, logicalInvocation = "automatic" }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const repoId = repository.id;
  const startTime = Date.now();

  // ── 0. Skip if PR was created by GitWire bot ───────────────────────────────
  // GitHub rejects reviews from the PR author. Bot-created PRs (heal, fix)
  // will fail with "Cannot approve your own pull request".
  const prAuthor = pr.user?.login || "";
  if (prAuthor.endsWith("[bot]") || prAuthor.includes("gitwire")) {
    logger.info({ repo: repository.full_name, pr: pr.number, author: prAuthor }, "AI review: skipping bot-authored PR");
    return null;
  }

  // ── 1. Load config ─────────────────────────────────────────────────────────
  // The DB-level ai_review_config row is the cost-control gate. When it is
  // missing or disabled, return a structured skip object so the finalizer
  // can render an actionable message (not the generic "not configured").
  // Other null-return paths (bot author, no files, validation) stay bare null.
  const cfg = await loadReviewConfig(repoId);
  if (!cfg?.enabled) {
    return { skipped: true, reason: "not_activated", activationUrl: reviewActivationUrl() };
  }

  logger.info({ repo: repository.full_name, pr: pr.number }, "AI review: starting (bundle-driven v2)");

  // ── 2. Create pending check run ────────────────────────────────────────────
  let checkRunId = null;
  try {
    const { data: checkRun } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name:       CHECK_RUN_NAME,
      head_sha:   pr.head.sha,
      status:     "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title:   "AI review in progress\u2026",
        summary: "Building review bundle and running structured analysis.",
      },
    });
    checkRunId = checkRun.id;
  } catch (checkErr) {
    logger.warn({ err: checkErr.message, repo: repository.full_name }, "AI review: Check Run creation failed (non-fatal)");
  }

  // ── 3. Persist review record ────────────────────────────────────────────────
  const { rows: [reviewRow] } = await db.query(
    "INSERT INTO ai_reviews (repo_id, pr_number, commit_sha, check_run_id, config_snapshot) " +
    "VALUES ($1,$2,$3,$4,$5) " +
    "ON CONFLICT (repo_id, pr_number, commit_sha) DO UPDATE SET " +
    "  check_run_id = COALESCE(EXCLUDED.check_run_id, ai_reviews.check_run_id), started_at = NOW() " +
    "RETURNING id",
    [repoId, pr.number, pr.head.sha, checkRunId, JSON.stringify(cfg)]
  );

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // Shared variables — set by either the v2 production path or the legacy path
    // ═══════════════════════════════════════════════════════════════════════════
    const v2Mode = cfg.review_integrity_v2;
    let v2DecisionComputed = false;
    let v2Decision = null;
    let v2InvocationId = null;
    let v2CheckState = null;

    // Pre-built v2 evidence and findings (set when v2 primary runs before legacy)
    let v2PrimaryFindings = null;
    let v2EvidencePreBuilt = null;
    let v2PrimaryError = null;
    let v2PrimaryMeta = null;

    // Legacy/shared variables
    let files = [], totalAdded = 0, totalRemoved = 0;
    let findings = [], verdict = "approved", confidence = "high";
    let summary = null, overallCorrectness = null, overallConfidence = null;
    let adversarialMeta = null, tokensUsed = 0, strategy = "unknown";
    let validation = {
      valid: true, scopeDroppedCount: 0, ignoredFindings: [],
      legacy: { findings: [], verdict: "approved", confidence: "high", summary: "", overallCorrectness: null, overallConfidence: null },
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // V2 PRODUCTION PATH: evidence-bound primary review
    // When v2Mode === "live", ReviewEvidence is built BEFORE the primary
    // review, and the model operates with bounded repository tools to
    // produce evidence-bound findings directly.
    // ═══════════════════════════════════════════════════════════════════════════
    if (v2Mode === "live") {
      const { computeInvocationId } = await import("./reviewMutationService.js");
      const { acquireChangedFiles, buildReviewEvidence } = await import("./reviewEvidenceService.js");
      const { runPrimaryReview } = await import("./primaryReviewService.js");

      v2InvocationId = computeInvocationId({
        repoId: repository.id, prNumber: pr.number, headSha: pr.head.sha,
        logicalInvocation,
      });

      // Acquire ALL changed files (paginated, reconciled against changed_files count)
      const { allFiles: v2AllFiles, paginatedFully: v2PaginatedFully } = await acquireChangedFiles(
        octokit, owner, repo, pr.number, pr.changed_files || 1,
      );

      // Build ReviewEvidence — changed files with coverage states and side identity
      const v2EvidenceResult = await buildReviewEvidence({
        allFiles: v2AllFiles,
        paginatedFully: v2PaginatedFully,
        ignorePatterns: cfg.ignore_patterns || [],
        maxFiles: cfg.max_files_to_review || 30,
        maxLines: cfg.max_lines_to_review || 2000,
        review: {
          repoId: repository.id, repoFullName: repository.full_name,
          prNumber: pr.number, baseSha: pr.base?.sha, headSha: pr.head.sha,
          invocationId: v2InvocationId,
        },
        octokit, owner, repo,
      });
      v2EvidencePreBuilt = v2EvidenceResult;

      // Run the evidence-bound primary review with tool-use loop
      const primaryReceipt = await runPrimaryReview({
        evidence: v2EvidenceResult,
        octokit, owner, repo,
        anthropic,
        model: cfg.model || DEFAULT_MODEL,
        prMeta: {
          title: pr.title || "",
          author: "@" + (pr.user?.login || "unknown"),
          branch: (pr.base?.ref || "main") + " \u2190 " + (pr.head?.ref || "unknown"),
          repoName: repository.full_name,
        },
        maxDurationMs: (cfg.max_duration_seconds || 300) * 1000,
      });

      v2PrimaryFindings = primaryReceipt.findings;
      v2PrimaryError = primaryReceipt.error || null;
      v2PrimaryMeta = {
        actualModel: primaryReceipt.actualModel,
        promptVersion: primaryReceipt.promptVersion,
        promptHash: primaryReceipt.promptHash,
        rawFindings: primaryReceipt.rawFindings,
        validatedCount: primaryReceipt.findings.length,
        retrievalTrace: primaryReceipt.retrievalTrace,
        budgetState: primaryReceipt.budgetState,
        error: primaryReceipt.error || null,
        rawTextSnippet: primaryReceipt.rawTextSnippet || null,
      };
      tokensUsed = primaryReceipt.tokensUsed;
      strategy = "v2_evidence_bound";

      // Convert v2 findings to legacy format for shared steps 10-13
      var SEVERITY_TO_LEGACY = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
      findings = primaryReceipt.findings.map(function (f) {
        return {
          severity: SEVERITY_TO_LEGACY[f.severity] || "low",
          title: f.claim || "Untitled",
          description: f.description || f.claim || "",
          file: (f.affectedPaths || [])[0] || null,
          line: null,
          suggestion: "",
          category: f.category,
        };
      });

      // File accounting from the v2-acquired files
      files = v2AllFiles;
      totalAdded = v2AllFiles.reduce(function (s, f) { return s + (f.additions || 0); }, 0);
      totalRemoved = v2AllFiles.reduce(function (s, f) { return s + (f.deletions || 0); }, 0);

      logger.info({
        repo: repository.full_name, pr: pr.number,
        primaryModel: primaryReceipt.actualModel,
        primaryTokens: primaryReceipt.tokensUsed,
        primaryToolOps: (primaryReceipt.retrievalTrace || []).length,
        primaryFindings: primaryReceipt.findings.length,
        primaryError: primaryReceipt.error || null,
      }, "AI review: v2 evidence-bound primary complete");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEGACY PATH — steps 4-9 (skipped when v2 primary ran)
    // ═══════════════════════════════════════════════════════════════════════════
    if (v2Mode !== "live") {
    // ── 4. Fetch diff ─────────────────────────────────────────────────────────
    const { files: legacyFiles, totalAdded: legacyAdded, totalRemoved: legacyRemoved } = await fetchDiff(octokit, owner, repo, pr, cfg);
    files = legacyFiles; totalAdded = legacyAdded; totalRemoved = legacyRemoved;

    if (!files.length) {
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "success", {
          title:   "\u2705 No reviewable files changed",
          summary: "All changed files are excluded by the ignore patterns.",
          text:    "",
        });
      }
      return null;
    }

    // ── 5. Build review bundle ────────────────────────────────────────────────
    const { bundle, changedFiles } = await buildReviewBundle({
      files, pr, repository,
    });

    logger.info(
      { repo: repository.full_name, pr: pr.number, bundleChars: bundle.length, files: changedFiles.length },
      "AI review: bundle built"
    );

    // ── 6. Run structured review with heartbeat ──────────────────────────────
    const maxDurationMs = cfg.max_duration_seconds
      ? cfg.max_duration_seconds * 1000
      : DEFAULT_MAX_DURATION_MS;

    const { rawText, tokensUsed: legacyTokens } = await withHeartbeat(
      function () {
        return runStructuredReview(bundle, changedFiles, {
          model: cfg.model || DEFAULT_MODEL,
          includeSecurity: cfg.check_security !== false,
          includeArchitecture: cfg.check_architecture !== false || cfg.check_cost_leaks !== false,
          prTitle: pr.title || "",
          prAuthor: "@" + (pr.user?.login || "unknown"),
          prBranch: (pr.base?.ref || "main") + " ← " + (pr.head?.ref || "unknown"),
          repoName: repository.full_name,
          promptVariant: cfg._reviewPromptVariant || null,
        });
      },
      { label: "claude review", timeoutMs: maxDurationMs }
    );

    tokensUsed = legacyTokens;

    // ── 7. Extract JSON with cascade ─────────────────────────────────────────
    const { json, strategy: legacyStrategy } = extractReviewJSON(rawText);
    strategy = legacyStrategy;

    logger.info(
      { strategy, pr: pr.number, hasJson: !!json },
      "AI review: JSON extraction"
    );

    if (!json) {
      // Extraction failed completely — return neutral
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u26A0\uFE0F AI review: could not parse response",
          summary: "Review completed but the response format was unexpected. Strategy: " + strategy,
          text:    rawText.slice(0, 2000),
        });
      }

      await db.query(
        "UPDATE ai_reviews SET verdict = 'error', summary = $1, tokens_used = $2, " +
        "completed_at = NOW(), duration_ms = $3 WHERE id = $4",
        ["JSON extraction failed (strategy: " + strategy + ")", tokensUsed, Date.now() - startTime, reviewRow.id]
      );

      return null;
    }

    // ── 8. Validate + scope-filter ────────────────────────────────────────────
    validation = validateReview(json, changedFiles);

    if (!validation.valid) {
      logger.warn(
        { errors: validation.schemaErrors, pr: pr.number },
        "AI review: validation failed"
      );

      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u26A0\uFE0F AI review: validation errors",
          summary: "Review completed but findings could not be validated. Errors: " + validation.schemaErrors.slice(0, 3).join("; "),
          text:    "",
        });
      }

      await db.query(
        "UPDATE ai_reviews SET verdict = 'error', summary = $1, tokens_used = $2, " +
        "completed_at = NOW(), duration_ms = $3 WHERE id = $4",
        ["Validation errors: " + validation.schemaErrors.join("; "), tokensUsed, Date.now() - startTime, reviewRow.id]
      );

      return null;
    }

    // ── 9. Use validated legacy format ────────────────────────────────────────
    ({ findings, verdict, confidence, summary, overallCorrectness, overallConfidence } = validation.legacy);

    // ── 9b. Devil's Advocate: adversarial challenge pass ──────────────────────
    adversarialMeta = null;
    if (cfg.adversarial_review !== false && findings.length > 0) {
      try {
        const challenge = await runAdversarialChallenge(findings, {
          prTitle: pr.title || "",
          repoName: repository.full_name,
          model: cfg.adversarial_model || undefined,
        });

        // ── 9c. Defense pass — dynamic trigger ────────────────────────────────
        //  Turn 3 runs only when Turn 2 reveals disagreement or escalated risk.
        //  Config: adversarial_defense = "auto" | "always" | "never"
        const defenseMode = cfg.adversarial_defense || "auto";
        const triggers = cfg.adversarial_defense_triggers || [
          "dropped_findings",
          "critical_downgraded",
          "new_criticals",
        ];
        const triggerResult = shouldRunDefense(
          defenseMode, triggers, findings, challenge.challenges, challenge.missedRisks
        );

        let defense = null;
        if (triggerResult.run) {
          defense = await runDefensePass(validation.legacy.findings, challenge.challenges, {
            prTitle: pr.title || "",
            repoName: repository.full_name,
            model: cfg.adversarial_defense_model || cfg.adversarial_model || undefined,
          });
          logger.info(
            { pr: pr.number, trigger: triggerResult.reason },
            "AI review: defense pass triggered (turn 3)"
          );
        } else {
          logger.info(
            { pr: pr.number, mode: defenseMode },
            "AI review: defense pass skipped (" + triggerResult.reason + ")"
          );
        }

        // Merge: challenge (+ optional defense) → final refined findings
        const refined = defense
          ? refineWithDefense(
              validation.legacy.findings,
              challenge.challenges,
              defense.defenses,
              challenge.missedRisks,
              defense.additionalMissed
            )
          : refineFindings(
              validation.legacy.findings,
              challenge.challenges,
              challenge.missedRisks
            );

        adversarialMeta = {
          dropped: refined.dropped.length,
          downgraded: findings.length - refined.dropped.length - refined.upheld.length,
          missedRisks: refined.missed.length,
          tokensUsed: challenge.tokensUsed + (defense ? defense.tokensUsed : 0),
          turns: defense ? 3 : 2,
          defenseTrigger: triggerResult.reason,
          defended: defense
            ? (defense.defenses || []).filter(function (d) { return d.action === "defend" || d.action === "upgrade"; }).length
            : 0,
          accepted: defense
            ? (defense.defenses || []).filter(function (d) { return d.action === "accept"; }).length
            : 0,
        };

        // Replace findings with refined set
        findings = refined.refined;

        // Recompute verdict with refined findings
        const recomputed = computeVerdict(findings, cfg);
        verdict = recomputed.verdict;
        confidence = recomputed.confidence;

        logger.info(
          {
            pr: pr.number, adversarialMeta,
            originalFindings: validation.legacy.findings.length,
            refinedFindings: findings.length,
          },
          "AI review: adversarial challenge complete"
        );
      } catch (advErr) {
        logger.warn(
          { err: advErr.message, pr: pr.number },
          "AI review: adversarial pass failed, using original findings"
        );
      }
    }
    } // end legacy-only path (if v2Mode !== "live")

    // ── 9b. Review Integrity v2 cutover (RI-9) ─────────────────────────────────
    // When review_integrity_v2 is "live", the deterministic decision policy
    // controls the GitHub review event. v2 failure forces COMMENT.
    if (v2Mode === "live") {

      try {
        const { computeReviewDecision } = await import("./reviewDecisionPolicy.js");
        const { runApprovalVerification } = await import("./approvalVerificationService.js");
        const { persistIntegrityReceipt } = await import("./integrityReceiptService.js");

        let v2Evidence, v2Primary;
        if (v2PrimaryError) {
          // Primary review failed (API/timeout/parse/schema). The empty
          // findings array must NOT be treated as a clean primary — that
          // would allow a clean verifier to reach APPROVE. Fail closed.
          throw new Error("Primary review failed: " + v2PrimaryError);
        } else if (v2PrimaryFindings) {
          // V2 evidence-bound primary already ran — use pre-built evidence
          // and validated findings with real evidence references.
          v2Evidence = v2EvidencePreBuilt;
          v2Primary = v2PrimaryFindings;
        } else {
          // Legacy fallback — build evidence and convert legacy findings
          // (used when shadow mode wraps the legacy path).
          const { buildReviewEvidence, acquireChangedFiles } = await import("./reviewEvidenceService.js");
          const { validateFindings } = await import("./findingValidator.js");
          const v2Files = files.map(f => ({
            filename: f.filename, status: f.status,
            additions: f.added, deletions: f.removed,
            patch: f.patch, sha: f.sha,
          }));
          const { allFiles: v2All, paginatedFully: legacyPaginatedFully } = await acquireChangedFiles(
            octokit, owner, repo, pr.number, pr.changed_files || v2Files.length,
          );
          v2Evidence = await buildReviewEvidence({
            allFiles: v2All,
            paginatedFully: legacyPaginatedFully,
            ignorePatterns: cfg.ignore_patterns || [],
            maxFiles: cfg.max_files_to_review || 30,
            maxLines: cfg.max_lines_to_review || 2000,
            review: {
              repoId: repository.id, repoFullName: repository.full_name,
              prNumber: pr.number, baseSha: pr.base?.sha, headSha: pr.head.sha,
              invocationId: v2InvocationId,
            },
            octokit, owner, repo,
          });
          const v2Findings = findings.map(f => ({
            severity: f.severity === "critical" ? "P0" : f.severity === "high" ? "P1" :
                       f.severity === "medium" ? "P2" : "P3",
            category: f.category || "bug",
            claim: f.title || "Untitled",
            description: f.description || "",
            affectedPaths: f.file ? [f.file] : [],
            evidenceRefs: f.file ? ["changed:" + f.file + "@HEAD:" + (f.line ? "L" + f.line : "L1")] : [],
            proof: { type: "static_trace", summary: f.description || f.title || "" },
          }));
          const v2Validated = validateFindings(v2Findings, v2Evidence);
          v2Primary = v2Validated.valid;
        }

        // Run verifier only if v2 primary has zero material findings and evidence is complete
        let v2Verifier = null;
        const v2HasMaterial = v2Primary.some(f => ["P0", "P1", "P2"].includes(f.severity));
        if (!v2HasMaterial && v2Evidence.coverage?.approvalEvidenceComplete) {
          const Anthropic2 = (await import("@anthropic-ai/sdk")).default;
          const v2Anthropic = new Anthropic2({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseURL });
          try {
            v2Verifier = await runApprovalVerification({
              evidence: v2Evidence,
              octokit, owner, repo,
              anthropic: v2Anthropic,
              model: cfg.model || "claude-sonnet-4-20250514",
            });
          } catch (vErr) {
            v2Verifier = { status: "incomplete", findings: [], approvalSafe: false, error: vErr.message };
          }
        }

        // Compute the v2 deterministic decision
        const computedDecision = computeReviewDecision({
          primaryFindings: v2Primary,
          verifierReceipt: v2Verifier,
          evidence: v2Evidence,
        });

        // Persist v2 receipt FIRST — required in live mode (must throw on
        // failure to guarantee auditability before the GitHub mutation).
        // Only after persistence succeeds do we mark the decision as computed
        // and map it to the verdict. This ensures a receipt-write failure
        // after an APPROVE decision forces COMMENT via the fail-closed path.
        await persistIntegrityReceipt({
          reviewRowId: reviewRow.id,
          evidence: v2Evidence,
          verifierReceipt: v2Verifier,
          decision: computedDecision,
          primaryFindings: v2Primary,
          invocationId: v2InvocationId,
        });

        // Receipt persisted — safe to expose the decision to downstream steps
        v2Decision = computedDecision;
        v2DecisionComputed = true;

        // Map v2 event back to legacy verdict vocabulary for postGitHubReview
        if (v2Decision.event === "REQUEST_CHANGES") {
          verdict = "request_changes";
        } else if (v2Decision.event === "APPROVE") {
          verdict = "approved";
        } else {
          verdict = "needs_discussion";
        }

        // Construct canonical finding collection with provenance.
        // Primary findings already in `findings` (legacy format). Add verifier
        // findings and tag each with source for the GitHub body, ai_reviews,
        // check output, and audit — everywhere findings appear downstream.
        {
          var SEV2LEGACY = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
          var verifierV2Findings = (v2Verifier?.findings || []);
          for (const f of findings) { if (!f.source) f.source = "primary"; }
          findings = findings.concat(verifierV2Findings.map(function (f) {
            return {
              severity: SEV2LEGACY[f.severity] || "low",
              title: f.claim || "Untitled",
              description: f.description || f.claim || "",
              file: (f.affectedPaths || [])[0] || null,
              line: null,
              suggestion: "",
              category: f.category,
              source: "approval_verifier",
            };
          }));
        }

        logger.info({
          pr: pr.number, v2Event: v2Decision.event, v2CheckState: v2Decision.checkState,
        }, "Review Integrity v2 cutover: decision policy controls event");

      } catch (v2Err) {
        // In live mode, v2 failure MUST NOT fall back to legacy APPROVE.
        // Force COMMENT (incomplete) — the only safe non-approval state.
        logger.error({ err: v2Err.message, pr: pr.number }, "Review Integrity v2 cutover failed — forcing COMMENT (never APPROVE)");
      }

      // If v2 did not produce a valid decision, force COMMENT
      if (!v2DecisionComputed) {
        verdict = "needs_discussion";
        confidence = "low";
      }
    }

    // ── 10. Post GitHub PR Review ──────────────────────────────────────────────
    let reviewId = null;
    let githubSummary = "";
    if (commentFindings) {
      // Build review body once (shared between legacy and v2 paths)
      const reviewBody = buildReviewMarkdown(findings, verdict, confidence, validation.scopeDroppedCount, adversarialMeta);

      if (v2Mode === "live") {
        // In v2 live mode, EVERY review mutation goes through the RI-7 mutation
        // manager — including the fail-closed COMMENT when the v2 pipeline fails.
        // This guarantees exactly-once semantics for all live mutations.
        // The invocation ID was computed once before the v2 try block and is
        // shared with the persisted receipt.
        const { createReviewMutationManager } = await import("./reviewMutationService.js");
        const { redis } = await import("../lib/queue.js");
        const mutationManager = createReviewMutationManager({
          redis, octokit, owner, repo,
          prNumber: pr.number, headSha: pr.head.sha,
          invocationId: v2InvocationId,
        });
        const mutationResult = await mutationManager.submitReview({
          event: verdict === "approved" ? "APPROVE" : verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT",
          body: reviewBody.body,
          commit_id: pr.head.sha,
          comments: reviewBody.comments,
        });
        reviewId = mutationResult.reviewId;
        githubSummary = reviewBody.summary;
      } else {
        var ghVerdict =
          verdict === "request_changes" ? "REQUEST_CHANGES" :
          verdict === "approved"        ? "APPROVE"         : "COMMENT";
        var { data: review } = await octokit.request(
          "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner, repo, pull_number: pr.number,
            commit_id: pr.head.sha, body: reviewBody.body,
            event: ghVerdict, comments: reviewBody.comments,
          }
        );
        reviewId = review.id;
        githubSummary = reviewBody.summary;
      }
    }

    // ── 11. Update check run ──────────────────────────────────────────────────
    // In v2 live mode, check semantics come from the deterministic decision
    // policy (RI-6), not legacy block_on_verdict. This preserves the
    // distinction between REVIEW_BLOCKED (P2 COMMENT → failure) and
    // REVIEW_INCOMPLETE (incomplete evidence → neutral). A v2 pipeline
    // failure produces a synthetic REVIEW_INCOMPLETE — never success.
    let shouldBlock;
    let checkConclusion;
    if (v2Mode === "live") {
      const { buildCheckConclusion, CHECK_STATE } = await import("./reviewDecisionPolicy.js");
      const effectiveDecision = (v2DecisionComputed && v2Decision)
        ? v2Decision
        : { checkState: CHECK_STATE.REVIEW_INCOMPLETE, decisionReason: "v2 pipeline failed — fail-closed COMMENT" };
      const checkResult = buildCheckConclusion(effectiveDecision);
      checkConclusion = checkResult.conclusion;
      shouldBlock = effectiveDecision.checkState === CHECK_STATE.REVIEW_BLOCKED;
      v2CheckState = effectiveDecision.checkState;
    } else {
      shouldBlock = cfg.block_on_verdict?.includes(verdict) &&
        confidenceLevel(confidence) >= confidenceLevel(cfg.min_confidence_to_block);
      checkConclusion = shouldBlock ? "failure" : "success";
    }

    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId,
        checkConclusion,
        buildCheckOutput(findings, verdict, confidence, githubSummary, validation.scopeDroppedCount)
      );
    }

    // ── 12. Persist final review ──────────────────────────────────────────────
    const criticalFindings = findings.filter(function (f) { return f.severity === "critical"; }).length;
    const durationMs = Date.now() - startTime;
    const totalTokens = tokensUsed + (adversarialMeta ? adversarialMeta.tokensUsed : 0);

    await db.query(
      "UPDATE ai_reviews SET " +
      "  verdict = $1, confidence = $2, findings = $3, summary = $4, " +
      "  files_reviewed = $5, lines_added = $6, lines_removed = $7, " +
      "  tokens_used = $8, github_review_id = $9, completed_at = NOW(), " +
      "  overall_correctness = $10, overall_confidence = $11, " +
      "  overall_explanation = $12, ignored_findings = $13, " +
      "  review_engine = $14, duration_ms = $15 " +
      "WHERE id = $16",
      [
        verdict, confidence, JSON.stringify(findings), summary || githubSummary,
        files.length, totalAdded, totalRemoved,
        totalTokens, reviewId,
        overallCorrectness || null, overallConfidence || null,
        summary || null,
        JSON.stringify(validation.ignoredFindings),
        adversarialMeta ? "claude+adversarial" : "claude",
        durationMs,
        reviewRow.id,
      ]
    );

    // ── 13. Audit trail ───────────────────────────────────────────────────────
    await Trail.aiDecision({
      repoFullName:     repository.full_name,
      prNumber:         pr.number,
      commitSha:        pr.head.sha,
      verdict, confidence,
      findingsCount:    findings.length,
      criticalFindings,
      tokensUsed,
      reviewId:         reviewRow.id,
      principalId: principalId,
      surfaceId: surfaceId || "audit_trail:ai_decision",
    });

    if (shouldBlock) {
      await Trail.reviewGateBlock({
        repoFullName: repository.full_name,
        prNumber:     pr.number,
        commitSha:    pr.head.sha,
        verdict,
        reason:       criticalFindings + " critical finding" + (criticalFindings !== 1 ? "s" : ""),
        findings:     findings.filter(function (f) { return f.severity === "critical"; }).map(function (f) { return f.title; }),
        principalId: principalId,
        surfaceId: surfaceId || "audit_trail:review_gate_block",
      });
    }

    await Events.ciRunCompleted(repoId, {
      prNumber: pr.number,
      success:  !shouldBlock,
      metadata: { type: "ai_review", verdict, findings_count: findings.length },
    });

    logger.info(
      {
        repo: repository.full_name, pr: pr.number, verdict, findings: findings.length,
        blocked: shouldBlock, scopeDropped: validation.scopeDroppedCount,
        durationMs, extractionStrategy: strategy,
      },
      "AI review: complete (bundle-driven v2)"
    );

    return { verdict, confidence, findings, blocked: shouldBlock, checkState: v2CheckState, primaryMeta: v2PrimaryMeta };

    } catch (err) {
    logger.error({ err: err.message, pr: pr.number }, "AI review: failed");
    const durationMs = Date.now() - startTime;

    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
        title:   "\u26A0\uFE0F AI review unavailable",
        summary: "Review could not be completed: " + err.message,
        text:    "",
      });
    }

    await db.query(
      "UPDATE ai_reviews SET verdict = 'error', summary = $1, " +
      "completed_at = NOW(), duration_ms = $2 WHERE id = $3",
      [err.message.slice(0, 500), durationMs, reviewRow.id]
    );

    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Fetch and filter PR diff
// ════════════════════════════════════════════════════════════════════════════

async function fetchDiff(octokit, owner, repo, pr, cfg) {
  const { data: prFiles } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    { owner, repo, pull_number: pr.number, per_page: 100 }
  );

  const ignorePatterns = cfg.ignore_patterns ?? [];

  var filtered = prFiles.filter(function (f) {
    if (f.status === "removed") return false;
    if (ignorePatterns.some(function (pat) { return minimatch(f.filename, pat); })) return false;
    return true;
  });

  // Respect limits
  filtered = filtered.slice(0, cfg.max_files_to_review);

  var totalAdded = 0, totalRemoved = 0, totalLines = 0;
  var files = [];

  for (var i = 0; i < filtered.length; i++) {
    var f = filtered[i];
    var added   = f.additions ?? 0;
    var removed = f.deletions ?? 0;
    totalAdded   += added;
    totalRemoved += removed;
    totalLines   += added + removed;

    if (totalLines > cfg.max_lines_to_review) break;

    files.push({
      filename: f.filename,
      status:   f.status,
      added:    added,
      removed:  removed,
      patch:    f.patch ?? "",
      sha:      f.sha,
    });
  }

  return { files, totalAdded, totalRemoved };
}

// ════════════════════════════════════════════════════════════════════════════
// Structured review via Claude (single-pass with schema enforcement)
// ════════════════════════════════════════════════════════════════════════════

async function runStructuredReview(bundle, changedFiles, opts) {
  var systemPrompt = buildReviewSystemPrompt({
    changedFiles: changedFiles,
    includeSecurity: opts.includeSecurity,
    includeArchitecture: opts.includeArchitecture,
  });

  // Ablation arm B: cross-file prompt variant (corrected review instructions
  // on the legacy data path, no tools). Appended to the standard system prompt.
  if (opts.promptVariant === "cross_file") {
    systemPrompt += [
      "",
      "## Cross-file correctness",
      "",
      "The changed files shown above are your STARTING POINT. However, correctness",
      "can depend on unchanged callers, helpers, configs, tests, documentation,",
      "and repository contracts. Consider:",
      "",
      "- Does a changed function signature break its callers?",
      "- Does a change contradict documented status declarations, API contracts,",
      "  configuration requirements, or gate definitions?",
      "- Does a change require updates to tests or configuration that are missing?",
      "- Are there cross-file dependencies that the diff alone does not show?",
      "",
      "Normative documentation — status declarations, executable specifications,",
      "configuration contracts, API contracts — is correctness material when a",
      "change can contradict it. Prose and style are not.",
      "",
      "A clean patch with no findings is a valid and welcome result.",
      "Omit low-confidence speculation.",
    ].join("\n");
  }

  // Build a rich user prompt with PR metadata for context
  // The bundle already contains structured sections (metadata, diff, files, repo context)
  // but the framing prompt helps the model understand intent
  var prTitle = opts.prTitle || "";
  var prAuthor = opts.prAuthor || "";
  var prBranch = opts.prBranch || "";
  var repoName = opts.repoName || "";
  var fileCount = changedFiles.length;

  var headerLines = [
    "You are reviewing a pull request for " + repoName + ".",
    "",
    "PR: " + prTitle,
    "Author: " + prAuthor,
    "Branch: " + prBranch,
    "Changed files: " + fileCount,
    "",
    "Focus on correctness, security, and regressions.",
    "Prioritize concrete issues visible in the diff.",
    "A clean patch with no findings is a valid and welcome result.",
    "",
    "--- BEGIN REVIEW BUNDLE ---",
    "",
  ];

  var userPrompt = headerLines.join("\n") + bundle;

  try {
    const message = await anthropic.messages.create({
      model:      opts.model || DEFAULT_MODEL,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    var text = "";
    if (Array.isArray(message.content)) {
      // Extract text blocks
      text = message.content
        .filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; })
        .join("\n");
    } else if (typeof message.content === "string") {
      text = message.content;
    }

    var tokens = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    return { rawText: text.trim(), tokensUsed: tokens };
  } catch (err) {
    logger.warn({ err: err.message }, "AI review: Claude call failed");
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Verdict computation (unchanged — kept for backward compat)
// ════════════════════════════════════════════════════════════════════════════

export function computeVerdict(findings, cfg) {
  var critical = findings.filter(function (f) { return f.severity === "critical"; }).length;
  var high     = findings.filter(function (f) { return f.severity === "high"; }).length;

  var verdict    = "approved";
  var confidence = "high";

  if (critical > 0) {
    verdict    = "request_changes";
    confidence = "high";
  } else if (high >= 3) {
    verdict    = "request_changes";
    confidence = "medium";
  } else if (high >= 1) {
    verdict    = "needs_discussion";
    confidence = "medium";
  } else if (findings.length >= 5) {
    verdict    = "needs_discussion";
    confidence = "low";
  }

  return { verdict, confidence };
}

// ════════════════════════════════════════════════════════════════════════════
// GitHub PR Review body building (shared between legacy POST and v2 mutation manager)
// ════════════════════════════════════════════════════════════════════════════

function buildReviewMarkdown(findings, verdict, confidence, scopeDroppedCount, adversarialMeta) {
  var VERDICT_LABEL = {
    approved:          "\u2705 Approved",
    needs_discussion:  "\uD83D\uDCAC Needs discussion",
    request_changes:   "\u274C Changes requested",
  };

  var critical = findings.filter(function (f) { return f.severity === "critical"; });
  var high     = findings.filter(function (f) { return f.severity === "high"; });
  var others   = findings.filter(function (f) { return ["critical", "high"].indexOf(f.severity) === -1; });
  var adversarialFindings = findings.filter(function (f) { return f.adversarial_status === "missed_risk"; });
  var upheldFindings = findings.filter(function (f) { return f.adversarial_status === "upheld"; });

  var summaryLines = [
    "## \uD83E\uDD16 AI Code Review \u2014 " + VERDICT_LABEL[verdict],
    "",
    "**Confidence:** " + confidence + " \u00B7 **Findings:** " + findings.length,
    critical.length ? "\n**" + critical.length + " critical issue" + (critical.length > 1 ? "s" : "") + " require attention before merging.**" : "",
    scopeDroppedCount > 0 ? "\n*" + scopeDroppedCount + " out-of-scope finding" + (scopeDroppedCount !== 1 ? "s" : "") + " filtered out.*" : "",
    "",
  ];

  if (critical.length || high.length) {
    summaryLines.push("### Key issues");
    for (var i = 0; i < Math.min(5, critical.length + high.length); i++) {
      var f = (critical.concat(high))[i];
      var badge = f.adversarial_status === "upheld" ? " 🔮" : (f.adversarial_status === "missed_risk" ? " 🔍" : "");
      summaryLines.push("- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " (`" + f.file + "`)" : "") + badge);
    }
    summaryLines.push("");
  }

  if (others.length) {
    summaryLines.push("### Other findings (" + others.length + ")");
    for (var j = 0; j < Math.min(5, others.length); j++) {
      summaryLines.push("- **[" + others[j].severity + "]** " + others[j].title);
    }
    summaryLines.push("");
  }

  if (adversarialMeta) {
    var advParts = [];
    if (adversarialMeta.dropped > 0) advParts.push(adversarialMeta.dropped + " false positive" + (adversarialMeta.dropped !== 1 ? "s" : "") + " dropped");
    if (adversarialMeta.downgraded > 0) advParts.push(adversarialMeta.downgraded + " downgraded");
    if (adversarialMeta.missedRisks > 0) advParts.push(adversarialMeta.missedRisks + " missed risk" + (adversarialMeta.missedRisks !== 1 ? "s" : "") + " found");
    if (upheldFindings.length > 0) advParts.push(upheldFindings.length + " upheld");
    if (advParts.length > 0) {
      var turnLabel = adversarialMeta.turns === 3 ? "3 turns" : "2 turns";
      summaryLines.push("> 🔮 **Devil's Advocate** (" + turnLabel + "): " + advParts.join(" · "));
      summaryLines.push("");
    }
  }

  if (adversarialMeta && adversarialMeta.dropped > 0) {
    summaryLines.push("<details><summary>❌ " + adversarialMeta.dropped + " finding" + (adversarialMeta.dropped !== 1 ? "s" : "") + " overruled by Devil's Advocate</summary>");
    summaryLines.push("<em>False positives eliminated by adversarial challenge pass.</em>");
    summaryLines.push("</details>");
    summaryLines.push("");
  }

  summaryLines.push(
    "---",
    "_GitWire AI Review Gate (bundle-driven v2) · Structured schema · Scope-validated" +
    (adversarialMeta ? " · Devil's Advocate" : "") + "_"
  );

  var body    = summaryLines.filter(function (l) { return l !== ""; }).join("\n");
  var summary = summaryLines.slice(0, 3).join(" ");

  var comments = findings
    .filter(function (f) { return f.file && f.line; })
    .slice(0, 10)
    .map(function (f) {
      return {
        path:     f.file,
        position: f.line,
        body:     "**[" + f.severity.toUpperCase() + "] " + f.title + "**\n\n" + f.description + "\n\n> **Suggestion:** " + f.suggestion,
      };
    });

  return { body, summary, comments };
}

// ════════════════════════════════════════════════════════════════════════════
// Legacy GitHub PR Review posting (retained for non-v2 path)
// ════════════════════════════════════════════════════════════════════════════

async function postGitHubReview({ octokit, owner, repo, pr, findings, verdict, confidence, cfg, scopeDroppedCount, adversarialMeta }) {
  var reviewBody = buildReviewMarkdown(findings, verdict, confidence, scopeDroppedCount, adversarialMeta);
  var ghVerdict =
    verdict === "request_changes" ? "REQUEST_CHANGES" :
    verdict === "approved"        ? "APPROVE"         : "COMMENT";

  var { data: review } = await octokit.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner,
      repo,
      pull_number: pr.number,
      commit_id:   pr.head.sha,
      body:        reviewBody.body,
      event:       ghVerdict,
      comments:    reviewBody.comments,
    }
  );

  return { reviewId: review.id, summary: reviewBody.summary };
}

// ════════════════════════════════════════════════════════════════════════════
// Check run helpers
// ════════════════════════════════════════════════════════════════════════════

async function finaliseCheckRun(octokit, owner, repo, checkRunId, conclusion, output) {
  await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id: checkRunId,
      status:       "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output,
    }
  ).catch(function (err) {
    logger.warn({ err: err.message, checkRunId: checkRunId }, "Failed to finalise check run");
  });
}

function buildCheckOutput(findings, verdict, confidence, summary, scopeDroppedCount) {
  var ICONS = { approved: "\u2705", needs_discussion: "\uD83D\uDCAC", request_changes: "\u274C" };
  var title = (ICONS[verdict] ?? "\uD83E\uDD16") + " AI Review \u2014 " + verdict.replace(/_/g, " ") + " (" + confidence + " confidence)";

  var details = findings.map(function (f) {
    return "- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " \u2014 `" + f.file + "`" : "") + "\n  " + f.description;
  }).join("\n");

  var scopeNote = scopeDroppedCount > 0
    ? "\n\n*" + scopeDroppedCount + " out-of-scope findings filtered.*"
    : "";

  return {
    title: title,
    summary: (summary || findings.length + " finding" + (findings.length !== 1 ? "s" : "")) + scopeNote,
    text:    details || "No specific findings.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Dynamic defense-pass trigger (turn 3 gating)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate whether Turn 3 (defense pass) should run based on config mode
 * and the outcomes of Turn 2 (adversarial challenge).
 *
 * Modes:
 *   "always"  — unconditionally run Turn 3
 *   "never"   — never run Turn 3
 *   "auto"    — run only if a trigger condition fires
 *
 * Trigger conditions (all on by default):
 *   dropped_findings     — any finding was disproven (suggested_action=drop)
 *   critical_downgraded  — a critical or high finding was challenged with downgrade
 *   new_criticals        — advocate discovered new critical or high risks
 *
 * @param {string} mode
 * @param {string[]} triggers
 * @param {Array} findings - Original findings
 * @param {Array} challenges - Challenge results from Turn 2
 * @param {Array} missedRisks - Missed risks from Turn 2
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldRunDefense(mode, triggers, findings, challenges, missedRisks) {
  if (mode === "always") {
    return { run: true, reason: "mode=always" };
  }
  if (mode === "never") {
    return { run: false, reason: "mode=never" };
  }

  // mode === "auto"
  var enabledTriggers = Array.isArray(triggers) && triggers.length > 0
    ? triggers
    : ["dropped_findings", "critical_downgraded", "new_criticals"];

  // Check: dropped findings
  if (enabledTriggers.indexOf("dropped_findings") !== -1) {
    var dropped = (challenges || []).some(function (c) { return c.suggested_action === "drop"; });
    if (dropped) {
      return { run: true, reason: "dropped_findings" };
    }
  }

  // Check: critical/high findings downgraded
  if (enabledTriggers.indexOf("critical_downgraded") !== -1) {
    var downgraded = (challenges || []).some(function (c) {
      if (c.suggested_action !== "downgrade") return false;
      var original = findings[c.finding_index];
      return original && (original.severity === "critical" || original.severity === "high");
    });
    if (downgraded) {
      return { run: true, reason: "critical_downgraded" };
    }
  }

  // Check: new criticals from advocate
  if (enabledTriggers.indexOf("new_criticals") !== -1) {
    var newCrits = (missedRisks || []).some(function (r) {
      return r.severity === "critical" || r.severity === "high";
    });
    if (newCrits) {
      return { run: true, reason: "new_criticals" };
    }
  }

  return { run: false, reason: "no_triggers_matched" };
}

// ════════════════════════════════════════════════════════════════════════════
// Config loader
// ════════════════════════════════════════════════════════════════════════════

async function loadReviewConfig(repoId) {
  var { rows } = await db.query(
    "SELECT * FROM ai_review_config WHERE repo_id = $1", [repoId]
  );
  return rows[0] ?? null;
}

/**
 * Build the activation URL for the Intelligence dashboard page.
 * The dashboard uses basePath: "/dashboard", so the public URL is
 * APP_BASE_URL + "/dashboard/intelligence".
 */
function reviewActivationUrl() {
  return (config.server.baseUrl || "").replace(/\/$/, "") + "/dashboard/intelligence";
}

/**
 * Resolve the effective AI review state for a repository.
 *
 * AI review requires two independent gates:
 *   Gate 1: .gitwire.yml pillar enabled (isPillarEnabled)
 *   Gate 2: ai_review_config DB row with enabled = true (loadReviewConfig)
 *
 * This function is the single source of truth for "is AI review effectively
 * runnable for this repo." Used by the manual-run handler to preflight before
 * promising results, and by the worker skip logic to distinguish reasons.
 *
 * @param {number} repoId - GitHub repository ID (repositories.github_id)
 * @param {string} repoFullName - Full repo name (owner/repo) for config lookup
 * @returns {Promise<{runnable: boolean, reason: string|null, pillarEnabled: boolean, dbActivated: boolean, activationUrl: string}>}
 */
export async function getEffectiveReviewState(repoId, repoFullName) {
  const { getConfigForRepo } = await import("./configService.js");
  const { isPillarEnabled } = await import("@gitwire/rules");
  const repoConfig = await getConfigForRepo(repoFullName);
  const cfg = await loadReviewConfig(repoId);
  const pillarEnabled = isPillarEnabled("ai_review", repoConfig);
  const dbActivated = cfg?.enabled === true;
  const activationUrl = reviewActivationUrl();

  if (!pillarEnabled) {
    return { runnable: false, reason: "pillar_disabled", pillarEnabled, dbActivated, activationUrl };
  }
  if (!dbActivated) {
    return { runnable: false, reason: "not_activated", pillarEnabled, dbActivated, activationUrl };
  }
  return { runnable: true, reason: null, pillarEnabled, dbActivated, activationUrl };
}

// ── Utilities ─────────────────────────────────────────────────────────────────
export function confidenceLevel(c) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}
