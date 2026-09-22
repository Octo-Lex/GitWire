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
//   3. Persist review record (advisory receipt columns) + recover any
//      interrupted publication before doing work
//   4. Fetch ALL changed-file pages; account for every file (coverage)
//   5. Build review bundle (complete evidence) + exact token admission
//      against the model-context envelope (PC-01 v2.1)
//   6. Single-pass structured review via Claude with schema enforcement
//   7. Extract JSON with cascade (handles fenced, JSONL, nested formats)
//   8. Validate schema + scope-filter findings
//   9. Derive verdict; adversarial challenge; evidence-bind material
//      findings; resolve publication (judgment / integrity / authority)
//  10. Supersession guard; persist receipt + publication intent; post the
//      GitHub review (COMMENT in advisory mode) with the publication marker
//  11. Update Check Run to pass/fail
//  12. Write to audit trail
//  13. Persist the terminal review receipt (published / terminal_reason)

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { Trail }  from "./auditTrailService.js";
import { Events } from "./pipelineEvents.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import {
  extractReviewJSON,
  buildReviewSystemPrompt,
  reportToLegacy,
} from "@gitwire/rules";
import { buildReviewBundle } from "./reviewBundleService.js";
import { countInputTokens, classifyProviderRejection, MAX_PRIMARY_INPUT_TOKENS } from "./reviewTokenAccounting.js";
import { validateReview } from "./reviewValidator.js";
import { withHeartbeat } from "./reviewHeartbeat.js";
import { runAdversarialChallenge, refineFindings } from "./adversarialReview.js";
import { buildInlineComments, partitionAnchored, renderBodyOnlyDetails } from "./reviewAnchorResolver.js";
import { runDefensePass, refineWithDefense } from "./adversarialDefense.js";
import { resolveReviewPublication } from "./reviewPublicationPolicy.js";
import { buildFileCoverage, finalizeCoverage, coverageSummaryLine } from "./reviewCoverageService.js";
import https from "node:https";
import { buildEvidenceReceipts } from "./reviewEvidenceService.js";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
  // Transport bound pinned to the 600 s review deadline. The SDK default is
  // also 600 s today; stating it explicitly keeps the bound independent of
  // SDK version drift as the review output ceiling grows.
  timeout:  600000,
  // RT-01: pin connections to IPv4. The provider resolver returns mixed
  // A/AAAA records and the app container has no IPv6 route; the SDK's
  // default address selection persistently fails fresh connections while
  // family-4 succeeds (see triageWorker.js and PR #194 evidence).
  httpAgent: new https.Agent({ keepAlive: true, family: 4 }),
});

const CHECK_RUN_NAME = "GitWire AI Review";
const DEFAULT_MAX_DURATION_MS = 600000; // 10 minutes (thinking-model latency)
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
export async function reviewPR({ pr, repository, octokit, commentFindings = true, principalId = null, surfaceId = null }) {
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
    "RETURNING id, publication_state, github_review_id, verdict, published_outcome, " +
    "judgment, integrity_state, policy_blocked",
    [repoId, pr.number, pr.head.sha, checkRunId, JSON.stringify(cfg)]
  );

  // ── 3b. Recover an interrupted publication before any model work ──────────
  // The ambiguous window: the review POST succeeded, then the process died
  // before github_review_id was persisted (publication_state still
  // 'submitting'). Resolve the prior attempt deterministically — paginate the
  // PR's reviews and search for the exact publication marker — before
  // re-running the model or posting again (frozen v1.2, recoverably
  // exactly-once).
  if (reviewRow.publication_state === "published" && reviewRow.github_review_id) {
    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId, reviewRow.policy_blocked ? "failure" : "success", {
        title:   "\u2705 AI review already published",
        summary: "A prior invocation already published this review (recovery). Outcome: " +
          (reviewRow.published_outcome ?? reviewRow.verdict ?? "unknown") + ".",
        text:    "",
      });
    }
    logger.info({ pr: pr.number, reviewId: reviewRow.github_review_id }, "AI review: recovered published invocation");
    return {
      verdict: reviewRow.verdict, recovered: true,
      reviewId: reviewRow.github_review_id,  // presentation: link the recovered publication
      blocked: reviewRow.policy_blocked === true, findings: [],
      publication: {
        judgment: reviewRow.judgment,
        publishedOutcome: reviewRow.published_outcome,
        integrityState: reviewRow.integrity_state,
        authorityState: reviewRow.policy_blocked ? "POLICY_BLOCKED" : "ADVISORY",
        publicationAllowed: false,
      },
    };
  }

  if (reviewRow.publication_state === "submitting") {
    const priorMarker = buildPublicationMarker(reviewRow.id, repoId, pr.number, pr.head.sha);
    let matches;
    try {
      matches = await findMarkerMatches(octokit, owner, repo, pr.number, priorMarker);
    } catch (lookupErr) {
      // Fail closed: without a completed lookup we cannot prove the prior
      // POST did not land, so no repost is allowed.
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u26A0\uFE0F AI review publication lookup failed",
          summary: "Could not verify whether a prior review publication exists: " + lookupErr.message,
          text:    "",
        });
      }
      const lookupFail = new Error("Publication recovery lookup failed, refusing to repost: " + lookupErr.message);
      lookupFail.gitwireErrorCode = "E_PUBLICATION_LOOKUP";
      throw lookupFail;
    }

    if (matches.length === 1) {
      await db.query(
        "UPDATE ai_reviews SET github_review_id = $1, publication_state = 'published', " +
        "terminal_reason = 'recovered_after_crash' WHERE id = $2",
        [matches[0].id, reviewRow.id]
      );
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, reviewRow.policy_blocked ? "failure" : "success", {
          title:   "\u2705 AI review recovered",
          summary: "A prior invocation published this review after a crash; the publication was adopted, not repeated.",
          text:    "",
        });
      }
      logger.info({ pr: pr.number, reviewId: matches[0].id }, "AI review: adopted crashed publication via marker");
      return {
        verdict: reviewRow.verdict, recovered: true,
        blocked: reviewRow.policy_blocked === true, findings: [],
        publication: {
          judgment: reviewRow.judgment,
          publishedOutcome: reviewRow.published_outcome,
          integrityState: reviewRow.integrity_state,
          authorityState: reviewRow.policy_blocked ? "POLICY_BLOCKED" : "ADVISORY",
          publicationAllowed: false,
        },
      };
    }

    if (matches.length > 1) {
      await db.query(
        "UPDATE ai_reviews SET publication_state = 'failed', " +
        "terminal_reason = 'ambiguous_publication' WHERE id = $1",
        [reviewRow.id]
      ).catch(function (persistErr) {
        logger.warn({ err: persistErr.message }, "AI review: ambiguity persist failed");
      });
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "failure", {
          title:   "\u274C AI review publication ambiguity",
          summary: "The publication marker for this review appears in " + matches.length +
            " GitHub reviews. No further publication was attempted; manual inspection is required.",
          text:    "",
        });
      }
      const ambiguity = new Error("Ambiguous publication: marker found in " + matches.length + " reviews");
      ambiguity.gitwireErrorCode = "E_AMBIGUOUS_PUBLICATION";
      throw ambiguity;
    }

    if (matches.length === 0) {
      // Zero matches does NOT prove the POST never happened: a live owner may
      // simply be between its claim and its POST right now. Release the
      // crashed claim only when it is provably STALE; otherwise suppress —
      // never a second concurrent POST (frozen v1.2 criterion 13).
      const { rows: released } = await db.query(
        "UPDATE ai_reviews SET publication_state = 'computed' " +
        "WHERE id = $1 AND publication_state = 'submitting' " +
        "AND (publication_claimed_at IS NULL OR publication_claimed_at < NOW() - INTERVAL '10 minutes') " +
        "RETURNING id",
        [reviewRow.id]
      );
      if (!released.length) {
        return suppressConcurrentPublication({
          octokit, owner, repo, checkRunId, reviewRowId: reviewRow.id,
          summary: "Another invocation owns the publication for this review head; no duplicate review was posted.",
        });
      }
      logger.info({ pr: pr.number }, "AI review: stale publication claim released — proceeding fresh");
    }
  }

  try {
    // ── 4. Fetch all changed-file pages and account for every file ──────────
    const { prFiles, paginationCapped } = await fetchChangedFiles(octokit, owner, repo, pr);
    const { files, coverage, totalAdded, totalRemoved } = buildFileCoverage({
      prFiles, cfg, headSha: pr.head.sha, paginationCapped,
    });

    if (!files.length) {
      const allExempt = coverage.files.length > 0 &&
        coverage.files.every((r) => r.coverage === "policy_exempt");
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, allExempt ? "success" : "neutral", {
          title:   allExempt ? "\u2705 No reviewable files changed" : "\u26A0\uFE0F AI review not run \u2014 no files admitted",
          summary: allExempt
            ? "All changed files are excluded by the ignore patterns."
            : "Changed files exist but none were admitted within the configured review limits. " + coverageSummaryLine(coverage),
          text:    "",
        });
      }
      return null;
    }

    // ── 5. Build review bundle (complete evidence) ──────────────────────────
    const bundleParts = await buildReviewBundle({
      files, pr, repository,
    });
    const changedFiles = bundleParts.changedFiles;

    const reviewOpts = {
      model: cfg.model || DEFAULT_MODEL,
      includeSecurity: cfg.check_security !== false,
      includeArchitecture: cfg.check_architecture !== false || cfg.check_cost_leaks !== false,
      prTitle: pr.title || "",
      prAuthor: "@" + (pr.user?.login || "unknown"),
      prBranch: (pr.base?.ref || "main") + " ← " + (pr.head?.ref || "unknown"),
      repoName: repository.full_name,
    };

    // ── 5b/6 provider work shares ONE deadline (PC-01 v2.1 final amendment) ─
    // Token admission and the primary inference call may not serially
    // consume more than the configured review deadline (max_duration_seconds,
    // default 600 s). The deadline is absolute: every provider call below is
    // bounded by the REMAINING slice, which only shrinks — a chain of
    // count_tokens calls can never reset the budget per call, and inference
    // cannot begin once the deadline has expired.
    const maxDurationMs = cfg.max_duration_seconds
      ? cfg.max_duration_seconds * 1000
      : DEFAULT_MAX_DURATION_MS;
    const providerDeadline = Date.now() + maxDurationMs;

    const admission = await admitPrimaryReviewEvidence({
      bundleParts, changedFiles, opts: reviewOpts, deadline: providerDeadline,
    });

    if (providerDeadline - Date.now() <= 0) {
      const deadlineErr = new Error("Review deadline expired during token admission — refusing inference");
      deadlineErr.gitwireErrorCode = "E_REVIEW_DEADLINE_EXCEEDED";
      deadlineErr.gitwireRejectionClass = "timeout";
      throw deadlineErr;
    }

    // Aggregate-budget truncation downgrades affected files from full to
    // partial; incomplete evidence must reach the publication decision, not
    // just the prompt budget.
    const finalCoverage = finalizeCoverage(coverage, admission.coverageAdjustments);

    logger.info(
      { repo: repository.full_name, pr: pr.number, bundleChars: admission.bundleChars,
        files: changedFiles.length, inputTokens: admission.requestedTokens, allocated: admission.allocated },
      "AI review: bundle built and admitted"
    );

    // ── 6. Run structured review with heartbeat ──────────────────────────────
    // withHeartbeat races but does not cancel the losing operation, so the
    // real bound is the per-request provider timeout set inside
    // runStructuredReview from the same shared deadline; the heartbeat is
    // the reporting/backstop layer on top.
    const { rawText, tokensUsed } = await withHeartbeat(
      function () {
        return runStructuredReview(admission.request, { model: reviewOpts.model, deadline: providerDeadline });
      },
      { label: "claude review", timeoutMs: Math.max(1, providerDeadline - Date.now()) }
    );

    // ── 7. Extract JSON with cascade ─────────────────────────────────────────
    const { json, strategy } = extractReviewJSON(rawText);

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
    const validation = validateReview(json, changedFiles);

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
    let { findings, verdict, confidence, summary, overallCorrectness, overallConfidence } = validation.legacy;

    // ── 9b. Devil's Advocate: adversarial challenge pass ──────────────────────
    let adversarialMeta = null;
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

    // ── 9c2. Evidence-bind material findings ─────────────────────────────────
    // A material claim without valid evidence stays visible but cannot
    // independently drive deterministic blocking authority (frozen v1.2).
    const evidenceResult = buildEvidenceReceipts({
      findings, files, headSha: pr.head.sha,
    });
    for (const receipt of evidenceResult.receipts) {
      const finding = findings[receipt.findingIndex];
      if (finding) finding.evidence_valid = receipt.valid;
    }
    if (findings.length > 0) {
      const unverified = evidenceResult.receipts.filter((r) => !r.valid).length;
      logger.info(
        { pr: pr.number, findings: findings.length, unverified },
        "AI review: evidence receipts built"
      );
    }

    // ── 9d. Resolve publication under the advisory contract ──────────────────
    // Judgment is the normalized model-derived verdict; integrity and authority
    // are GitWire-deterministic. Advisory mode (the pilot default) publishes
    // every outcome as a GitHub COMMENT — blocking comes only from explicit
    // repository policy applied to evidence-backed findings.
    // Integrity is derived from changed-file coverage: incomplete evidence can
    // never produce a published clean APPROVE.
    const publication = resolveReviewPublication({
      judgment: verdict,
      integrityState: finalCoverage.approvalEvidenceComplete ? "COMPLETE" : "INCOMPLETE",
      materialEvidenceValid: evidenceResult.materialEvidenceValid,
      repositoryPolicy: {
        blockOnVerdict: cfg.block_on_verdict,
        minConfidenceToBlock: cfg.min_confidence_to_block,
        confidence,
      },
      publicationMode: cfg.publication_mode || "advisory",
    });
    const shouldBlock = publication.policyBlocked;

    // ── 9e. Exact-head supersession guard ────────────────────────────────────
    // A review started at SHA A must not publish a current-looking conclusion
    // after the PR moves to SHA B: re-read the PR head immediately before the
    // first externally visible publication. On mismatch the invocation is
    // terminal with no review mutation and no automatic replacement review
    // (frozen v1.2 — synchronize re-review is out of scope).
    const reviewHeadSha = pr.head.sha;
    let currentHeadSha;
    try {
      const { data: currentPr } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo, pull_number: pr.number }
      );
      currentHeadSha = currentPr?.head?.sha ?? null;
    } catch (headErr) {
      // Fail closed: without head confirmation the review cannot be proven
      // current, so it must not be published. Receipted + neutralized by the
      // broad catch, then rethrown so the worker visibly fails (transient
      // API outages get a BullMQ retry, never a blind publication).
      const confirmErr = new Error("Head confirmation failed, refusing to publish: " + headErr.message);
      confirmErr.gitwireErrorCode = "E_HEAD_CONFIRMATION";
      throw confirmErr;
    }
    if (!currentHeadSha) {
      const confirmErr = new Error("Head confirmation failed: PR response carried no head SHA, refusing to publish");
      confirmErr.gitwireErrorCode = "E_HEAD_CONFIRMATION";
      throw confirmErr;
    }
    if (currentHeadSha !== reviewHeadSha) {
      const supersededPublication = resolveReviewPublication({
        judgment: verdict,
        integrityState: "SUPERSEDED",
        repositoryPolicy: {
          blockOnVerdict: cfg.block_on_verdict,
          minConfidenceToBlock: cfg.min_confidence_to_block,
          confidence,
        },
        publicationMode: cfg.publication_mode || "advisory",
      });
      logger.info(
        { repo: repository.full_name, pr: pr.number, reviewHeadSha, currentHeadSha },
        "AI review: head superseded — no publication"
      );
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u23ED\uFE0F AI review superseded",
          summary: "The PR head changed while the AI review was running" +
            (currentHeadSha ? " (" + reviewHeadSha.slice(0, 12) + " \u2192 " + currentHeadSha.slice(0, 12) + ")" : "") +
            ". No review was published for the old head.",
          text:    "",
        });
      }
      await db.query(
        "UPDATE ai_reviews SET verdict = 'superseded', summary = $1, " +
        "integrity_state = 'SUPERSEDED', terminal_reason = 'head_superseded', " +
        "completed_at = NOW(), duration_ms = $2 WHERE id = $3",
        [("Superseded: PR head moved from " + reviewHeadSha + " to " + (currentHeadSha ?? "unknown")).slice(0, 500), Date.now() - startTime, reviewRow.id]
      ).catch(function (persistErr) {
        logger.warn({ err: persistErr.message }, "AI review: supersession persist failed");
      });
      return {
        verdict: "superseded", superseded: true, findings: [], blocked: false,
        reviewedHeadSha: reviewHeadSha, currentHeadSha: currentHeadSha ?? null,
        publication: supersededPublication,
      };
    }

    // ── 10a. Atomically claim the publication before mutation ──────────────
    // Exactly one concurrent invocation may move this row to 'submitting';
    // the receipt fields land WITH the claim so the row stays reconstructable
    // even if the process dies at the POST. A claim loser never treats
    // "marker not found" as proof no POST happened — the owner may be between
    // claim and POST — and adopts, suppresses, or fails closed instead
    // (frozen v1.2 criterion 13).
    const publicationMarker = buildPublicationMarker(reviewRow.id, repoId, pr.number, reviewHeadSha);
    const { rows: claimedPublication } = await db.query(
      "UPDATE ai_reviews SET " +
      "  judgment = $1, published_outcome = $2, integrity_state = $3, " +
      "  authority_state = $4, publication_mode = $5, policy_blocked = $6, " +
      "  github_review_event = $7, coverage = $8, evidence_receipts = $9, " +
      "  publication_state = 'submitting', publication_claimed_at = NOW() " +
      "WHERE id = $10 " +
      "  AND (publication_state IS NULL OR publication_state = 'computed') " +
      "RETURNING id",
      [
        publication.judgment, publication.publishedOutcome, publication.integrityState,
        publication.authorityState, publication.publicationMode, publication.policyBlocked,
        publication.githubReviewEvent, JSON.stringify(finalCoverage),
        JSON.stringify(evidenceResult.receipts), reviewRow.id,
      ]
    );

    if (!claimedPublication.length) {
      const { rows: [currentRow] } = await db.query(
        "SELECT publication_state, github_review_id, verdict, published_outcome, " +
        "judgment, integrity_state, policy_blocked FROM ai_reviews WHERE id = $1",
        [reviewRow.id]
      );
      const state = currentRow?.publication_state;

      if (state === "published" && currentRow.github_review_id) {
        if (checkRunId) {
          await finaliseCheckRun(octokit, owner, repo, checkRunId, currentRow.policy_blocked ? "failure" : "success", {
            title:   "\u2705 AI review already published",
            summary: "A concurrent invocation already published this review. Outcome: " +
              (currentRow.published_outcome ?? currentRow.verdict ?? "unknown") + ".",
            text:    "",
          });
        }
        logger.info({ pr: pr.number }, "AI review: claim lost to a published row — adopting");
        return {
          verdict: currentRow.verdict, recovered: true,
          blocked: currentRow.policy_blocked === true, findings: [],
          publication: {
            judgment: currentRow.judgment,
            publishedOutcome: currentRow.published_outcome,
            integrityState: currentRow.integrity_state,
            authorityState: currentRow.policy_blocked ? "POLICY_BLOCKED" : "ADVISORY",
            publicationAllowed: false,
          },
        };
      }

      if (state === "submitting") {
        return suppressConcurrentPublication({
          octokit, owner, repo, checkRunId, reviewRowId: reviewRow.id,
          summary: "Another invocation owns the publication for this review head; no duplicate review was posted.",
        });
      }

      if (state === "failed") {
        if (checkRunId) {
          await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
            title:   "\u26A0\uFE0F AI review publication previously failed",
            summary: "A prior publication attempt for this review head failed terminally; nothing was reposted.",
            text:    "",
          });
        }
        return null;
      }

      const stateErr = new Error("Unknown publication state at claim boundary: '" + state + "' — refusing to publish");
      stateErr.gitwireErrorCode = "E_PUBLICATION_STATE";
      throw stateErr;
    }

    // ── 10b. Post GitHub PR Review ──────────────────────────────────────────────
    // Delivery is a hard boundary: a computed review that GitHub REJECTS is
    // a terminal delivery failure (E_REVIEW_DELIVERY) — error receipt,
    // FAILURE check, rethrow to the worker. Never finalized neutral and
    // never returned as null-success. Anchors are prevalidated against the
    // fetched patches, so a rejection means GitHub refused the review
    // itself; it propagates (no automatic retry without comments).
    let reviewId = null;
    let githubSummary = "";
    if (commentFindings) {
      try {
        const result = await postGitHubReview({
          octokit, owner, repo, pr, findings, verdict, confidence, cfg,
          scopeDroppedCount: validation.scopeDroppedCount,
          adversarialMeta,
          files,
          publication,
          coverage: finalCoverage,
          publicationMarker,
        });
        reviewId = result.reviewId;
        githubSummary = result.summary;
      } catch (deliveryErr) {
        deliveryErr.gitwireErrorCode = "E_REVIEW_DELIVERY";
        logger.error(
          { err: deliveryErr.message, pr: pr.number, reviewRowId: reviewRow.id },
          "AI review: GitHub delivery failed — terminal failure"
        );
        // Persist the error receipt (same shape as the broad catch).
        await db.query(
          "UPDATE ai_reviews SET verdict = 'error', summary = $1, " +
          "publication_state = CASE WHEN publication_state = 'submitting' THEN 'failed' ELSE publication_state END, " +
          "terminal_reason = 'delivery_failure', " +
          "completed_at = NOW(), duration_ms = $2 WHERE id = $3",
          [("GitHub review delivery failed: " + deliveryErr.message).slice(0, 500), Date.now() - startTime, reviewRow.id]
        ).catch(function (persistErr) {
          logger.warn({ err: persistErr.message }, "AI review: delivery-failure persist failed");
        });
        // Terminalize the check as FAILURE — not neutral, not success.
        if (checkRunId) {
          await finaliseCheckRun(octokit, owner, repo, checkRunId, "failure", {
            title:   "\u274C AI review delivery failed",
            summary: "The review was computed but GitHub rejected the review submission: " + deliveryErr.message,
            text:    "",
          });
        }
        throw deliveryErr;
      }
    }

    // ── 11. Update check run ──────────────────────────────────────────────────
    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId,
        shouldBlock ? "failure" : "success",
        buildCheckOutput(findings, verdict, confidence, githubSummary, validation.scopeDroppedCount, coverageSummaryLine(finalCoverage), publication.publishedOutcome)
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
      "  review_engine = $14, duration_ms = $15, " +
      "  publication_state = CASE WHEN $9::bigint IS NOT NULL THEN 'published' ELSE 'computed' END, " +
      "  terminal_reason = CASE WHEN $9::bigint IS NOT NULL THEN 'completed' ELSE 'completed_unpublished' END " +
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

    return { verdict, confidence, findings, blocked: shouldBlock, publication, coverage: finalCoverage, evidence: evidenceResult };

  } catch (err) {
    // A delivery failure was already classified, receipted, and finalized
    // as FAILURE by the Step-10 boundary — rethrow untouched so the worker
    // visibly fails instead of degrading to neutral-then-null.
    if (err && err.gitwireErrorCode === "E_REVIEW_DELIVERY") {
      throw err;
    }
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
      "terminal_reason = $2, " +
      "completed_at = NOW(), duration_ms = $3 WHERE id = $4",
      [err.message.slice(0, 500), reviewErrorTerminalReason(err), durationMs, reviewRow.id]
    );

    // Head-confirmation, publication-state, token-accounting, and
    // budget-enforcement failures are receipted and neutralized above;
    // rethrow so the worker visibly fails rather than reporting a completed
    // null. Token counts never fall back to an estimate, so a counting
    // failure must retry rather than send unmeasured evidence.
    if (err && (
      err.gitwireErrorCode === "E_HEAD_CONFIRMATION" ||
      err.gitwireErrorCode === "E_PUBLICATION_STATE" ||
      err.gitwireErrorCode === "E_TOKEN_COUNT_FAILED" ||
      err.gitwireErrorCode === "E_INPUT_BUDGET_EXCEEDED" ||
      err.gitwireErrorCode === "E_REVIEW_DEADLINE_EXCEEDED" ||
      err.gitwireErrorCode === "E_REVIEW_PROVIDER_TRANSIENT"
    )) {
      throw err;
    }

    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Fetch changed files — every page, so coverage can account for them all
// ════════════════════════════════════════════════════════════════════════════

const MAX_FILE_PAGES = 10; // changed-files pagination cap; beyond it evidence is incomplete

async function fetchChangedFiles(octokit, owner, repo, pr) {
  const prFiles = [];
  let paginationCapped = false;

  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: pr.number, per_page: 100, page }
    );
    if (!Array.isArray(data) || data.length === 0) break;
    prFiles.push(...data);
    if (data.length < 100) break;
    if (page === MAX_FILE_PAGES) paginationCapped = true;
  }

  return { prFiles, paginationCapped };
}

// ════════════════════════════════════════════════════════════════════════════
// Structured review via Claude (single-pass with schema enforcement)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the exact primary-review request (system prompt + framed user
 * message) for a bundle. Shared by token admission (which must count the
 * exact bytes the send will use) and runStructuredReview itself.
 */
// SC-01 P1: exported so the pure planner receives the SAME production
// request builder (injected dependency) instead of re-implementing one —
// no behavior change.
export function buildReviewRequest(bundle, changedFiles, opts) {
  const system = buildReviewSystemPrompt({
    changedFiles: changedFiles,
    includeSecurity: opts.includeSecurity,
    includeArchitecture: opts.includeArchitecture,
  });

  // The bundle already contains structured sections (metadata, diff, files, repo context)
  // but the framing prompt helps the model understand intent
  const headerLines = [
    "You are reviewing a pull request for " + opts.repoName + ".",
    "",
    "PR: " + opts.prTitle,
    "Author: " + opts.prAuthor,
    "Branch: " + opts.prBranch,
    "Changed files: " + changedFiles.length,
    "",
    "Focus on correctness, security, and regressions.",
    "Prioritize concrete issues visible in the diff.",
    "A clean patch with no findings is a valid and welcome result.",
    "",
    "--- BEGIN REVIEW BUNDLE ---",
    "",
  ];

  return { system, userPrompt: headerLines.join("\n") + bundle };
}

/**
 * PC-01 v2.1 model-context admission. The complete request is counted with
 * the provider's exact count_tokens endpoint; if it fits
 * MAX_PRIMARY_INPUT_TOKENS the whole PR is sent. Overflow allocates
 * deterministically in existing file order (whole sections while budget
 * remains; the crossing file and everything after are omitted and marked
 * bundle_truncated), and the rebuilt request is re-counted and required to
 * fit before inference. Standalone section counts slightly overstate each
 * section's in-bundle marginal cost (per-call message envelope), so the
 * allocation is conservative by construction and the final re-count is the
 * authoritative gate. Exported as the replay/diagnostic seam (PC-01).
 */
export async function admitPrimaryReviewEvidence({ bundleParts, changedFiles, opts, deadline }) {
  const model = opts.model || DEFAULT_MODEL;

  const complete = buildReviewRequest(bundleParts.bundle, changedFiles, opts);
  const requestedTokens = await countInputTokens({
    model, system: complete.system, userPrompt: complete.userPrompt, deadline,
  });

  if (requestedTokens <= MAX_PRIMARY_INPUT_TOKENS) {
    logger.info(
      { requestedTokens, ceiling: MAX_PRIMARY_INPUT_TOKENS, allocated: false },
      "AI review: token admission — complete evidence fits the model context envelope"
    );
    return {
      request: complete,
      bundle: bundleParts.bundle,
      bundleChars: bundleParts.bundle.length,
      coverageAdjustments: bundleParts.coverageAdjustments ?? [],
      requestedTokens,
      allocated: false,
    };
  }

  // Overflow: count the zero-evidence skeleton, then admit whole sections
  // while the remaining budget allows. Every count is deadline-bounded.
  const skeleton = bundleParts.reassemble(0);
  const skeletonRequest = buildReviewRequest(skeleton.bundle, changedFiles, opts);
  const skeletonTokens = await countInputTokens({
    model, system: skeletonRequest.system, userPrompt: skeletonRequest.userPrompt, deadline,
  });
  let remaining = MAX_PRIMARY_INPUT_TOKENS - skeletonTokens;
  let admittedFiles = 0;
  for (const section of bundleParts.fileSections) {
    const sectionTokens = await countInputTokens({ model, userPrompt: section.text, deadline });
    if (sectionTokens > remaining) break;
    remaining -= sectionTokens;
    admittedFiles++;
  }

  const allocated = bundleParts.reassemble(admittedFiles);
  const allocatedRequest = buildReviewRequest(allocated.bundle, changedFiles, opts);
  const finalTokens = await countInputTokens({
    model, system: allocatedRequest.system, userPrompt: allocatedRequest.userPrompt, deadline,
  });
  if (finalTokens > MAX_PRIMARY_INPUT_TOKENS) {
    const budgetErr = new Error(
      "Review input budget enforcement failed after allocation: " + finalTokens +
      " > " + MAX_PRIMARY_INPUT_TOKENS + " input tokens"
    );
    budgetErr.gitwireErrorCode = "E_INPUT_BUDGET_EXCEEDED";
    throw budgetErr;
  }

  logger.info(
    { requestedTokens, skeletonTokens, admittedFiles, totalFiles: bundleParts.fileSections.length,
      finalTokens, ceiling: MAX_PRIMARY_INPUT_TOKENS, allocated: true },
    "AI review: token admission — allocated deterministically within the model context envelope"
  );
  return {
    request: allocatedRequest,
    bundle: allocated.bundle,
    bundleChars: allocated.bundle.length,
    coverageAdjustments: allocated.coverageAdjustments,
    requestedTokens: finalTokens,
    allocated: true,
  };
}

async function runStructuredReview(request, opts) {
  // Shared-deadline gate: inference may not BEGIN after the review deadline
  // expired, and when it begins it is bounded by the remaining slice via the
  // per-request provider timeout (withHeartbeat races but does not cancel,
  // so this per-request bound is the hard one).
  const remaining = opts.deadline !== undefined ? opts.deadline - Date.now() : undefined;
  if (remaining !== undefined && remaining <= 0) {
    const expired = new Error("Review deadline expired before inference — refusing to start the model call");
    expired.gitwireErrorCode = "E_REVIEW_DEADLINE_EXCEEDED";
    expired.gitwireRejectionClass = "timeout";
    throw expired;
  }
  // SDK-local retries are disabled under the deadline (they retry per
  // attempt with the timeout applying each time, which could outrun the
  // deadline without GitWire regaining control); BullMQ's bounded attempts
  // are the only recovery layer for this path.
  const requestOptions = remaining !== undefined ? { timeout: remaining, maxRetries: 0 } : {};
  try {
    const message = await anthropic.messages.create(
      {
        model:      opts.model || DEFAULT_MODEL,
        max_tokens: 32768,
        system:     request.system,
        messages:   [{ role: "user", content: request.userPrompt }],
      },
      requestOptions
    );

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
    // PC-01 v2.1: classify every provider failure into the frozen seven-way
    // taxonomy (context_limit / timeout / rate_limit / quota /
    // auth_entitlement / transport / other). SDK retries are disabled under
    // the deadline, so a TRANSIENT primary-call failure (timeout/transport/
    // rate_limit — including 409 and 5xx) is tagged
    // E_REVIEW_PROVIDER_TRANSIENT and rethrown for BullMQ, which is the sole
    // retry layer. Permanent classes stay on the pre-PC-01 null-return path.
    err.gitwireRejectionClass = classifyProviderRejection(err);
    if (TRANSIENT_PROVIDER_FAILURE_CLASSES.has(err.gitwireRejectionClass)) {
      err.gitwireErrorCode = "E_REVIEW_PROVIDER_TRANSIENT";
    }
    logger.warn({ err: err.message, rejectionClass: err.gitwireRejectionClass }, "AI review: Claude call failed");
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
// GitHub PR Review posting
// ════════════════════════════════════════════════════════════════════════════

async function postGitHubReview({ octokit, owner, repo, pr, findings, verdict, confidence, cfg, scopeDroppedCount, adversarialMeta, files, publication, coverage, publicationMarker }) {
  var VERDICT_LABEL = {
    approved:          "\u2705 Approved",
    needs_discussion:  "\uD83D\uDCAC Needs discussion",
    request_changes:   "\u274C Changes requested",
  };
  // PB-01: the human-facing headline derives from the FINALIZED publication
  // outcome, never the raw model verdict. An INCOMPLETE publication must
  // never read as an approval — the model verdict stays visible on the
  // judgment line below, where Evidence: INCOMPLETE qualifies it.
  var OUTCOME_LABEL = {
    APPROVE:          "\u2705 Approved",
    NEEDS_DISCUSSION: "\uD83D\uDCAC Needs discussion",
    REQUEST_CHANGES:  "\u274C Changes requested",
    INCOMPLETE:       "\u26A0\uFE0F Review incomplete",
  };

  var critical = findings.filter(function (f) { return f.severity === "critical"; });
  var high     = findings.filter(function (f) { return f.severity === "high"; });
  var others   = findings.filter(function (f) { return ["critical", "high"].indexOf(f.severity) === -1; });

  // Separate adversarial-discovered findings
  var adversarialFindings = findings.filter(function (f) { return f.adversarial_status === "missed_risk"; });
  var upheldFindings = findings.filter(function (f) { return f.adversarial_status === "upheld"; });

  var summaryLines = [
    "## \uD83E\uDD16 AI Code Review \u2014 " + (OUTCOME_LABEL[publication.publishedOutcome] ?? VERDICT_LABEL[verdict]),
    "",
    "**Confidence:** " + confidence + " \u00B7 **Findings:** " + findings.length,
    "**AI judgment: " + (publication.judgment === "NEEDS_DISCUSSION" ? "NEEDS DISCUSSION" : publication.judgment) + "**" +
    " \u00B7 Evidence: " + publication.integrityState +
    " \u00B7 Authority: " + (publication.policyBlocked ? "repository policy blocked" : "advisory"),
    coverage ? coverageSummaryLine(coverage) : "",
    critical.length ? "\n**" + critical.length + " critical issue" + (critical.length > 1 ? "s" : "") + " require attention before merging.**" : "",
    scopeDroppedCount > 0 ? "\n*" + scopeDroppedCount + " out-of-scope finding" + (scopeDroppedCount !== 1 ? "s" : "") + " filtered out.*" : "",
    "",
  ];

  // An incomplete review is never presented as a clean approval: say so in
  // the published body, with the coverage numbers behind it.
  if (publication.publishedOutcome === "INCOMPLETE" && coverage) {
    const lacking = coverage.files.filter(
      (r) => r.coverage === "partial" || r.coverage === "unavailable"
    ).length;
    summaryLines.push(
      "**INCOMPLETE \u2014 no clean approval was issued.** GitWire could not completely review this change: " +
      lacking + " of " + coverage.totalChangedFiles + " changed files lacked complete review evidence" +
      (coverage.limitsExceeded.length ? " (limits reached: " + coverage.limitsExceeded.join(", ") + ")" : "") + "."
    );
    summaryLines.push("");
  }

  if (critical.length || high.length) {
    summaryLines.push("### Key issues");
    for (var i = 0; i < Math.min(5, critical.length + high.length); i++) {
      var f = (critical.concat(high))[i];
      var badge = f.adversarial_status === "upheld" ? " 🔮" : (f.adversarial_status === "missed_risk" ? " 🔍" : "");
      summaryLines.push("- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " (`" + f.file + "`)" : "") + badge + (f.evidence_valid === false ? " \u26A0\uFE0F *unverified*" : ""));
    }
    summaryLines.push("");
  }

  if (others.length) {
    summaryLines.push("### Other findings (" + others.length + ")");
    for (var j = 0; j < Math.min(5, others.length); j++) {
      summaryLines.push("- **[" + others[j].severity + "]** " + others[j].title + (others[j].evidence_valid === false ? " \u26A0\uFE0F *unverified*" : ""));
    }
    summaryLines.push("");
  }

  // Devil's Advocate summary
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

  // Dropped findings section
  if (adversarialMeta && adversarialMeta.dropped > 0) {
    summaryLines.push("<details><summary>❌ " + adversarialMeta.dropped + " finding" + (adversarialMeta.dropped !== 1 ? "s" : "") + " overruled by Devil's Advocate</summary>");
    summaryLines.push("<em>False positives eliminated by adversarial challenge pass.</em>");
    summaryLines.push("</details>");
    summaryLines.push("");
  }

  summaryLines.push(
    "---",
    "_GitWire AI Review Gate (bundle-driven v2) \u00B7 Structured schema \u00B7 Scope-validated" +
    (adversarialMeta ? " \u00B7 Devil's Advocate" : "") +
    " \u00B7 " + (publication.policyBlocked
      ? "Repository policy blocked this merge"
      : "AI recommendation \u2014 maintainers and repository policy retain authority") + "_"
  );

  // Partition BEFORE the body join: findings NOT emitted inline —
  // unanchorable, no usable location, or beyond the inline cap — carry
  // their full description, suggestion, and location in the body. The
  // finding is never dropped.
  var { anchored, bodyOnly } = partitionAnchored(findings, files);
  summaryLines.push(...renderBodyOnlyDetails(bodyOnly));
  var comments = buildInlineComments(anchored, files);

  // Invisible deterministic publication marker: identifies this logical
  // publication across crash recovery (exactly-once, frozen v1.2 WP-5).
  if (publicationMarker) {
    summaryLines.push("<!-- " + publicationMarker + " -->");
  }

  var body    = summaryLines.filter(function (l) { return l !== ""; }).join("\n");
  var summary = summaryLines.slice(0, 3).join(" ");

  // The publication policy owns the GitHub review event. Advisory mode always
  // publishes COMMENT; only the legacy_stateful rollback mode may emit
  // APPROVE / REQUEST_CHANGES.
  var ghVerdict = publication.githubReviewEvent;

  var { data: review } = await octokit.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner,
      repo,
      pull_number: pr.number,
      commit_id:   pr.head.sha,
      body,
      event:       ghVerdict,
      comments,
    }
  );

  return { reviewId: review.id, summary };
}

// ════════════════════════════════════════════════════════════════════════════
// Exactly-once publication helpers (frozen v1.2, WP-5)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic publication marker for one logical review publication.
 * Stable across retries: the ai_reviews row id is stable for a
 * (repo, PR, head) invocation via the UNIQUE upsert, so a retry computes the
 * same marker the crashed attempt embedded in its review body.
 */
export function buildPublicationMarker(reviewRowId, repoId, prNumber, headSha) {
  return "gitwire-pub:" + reviewRowId + ":" + repoId + ":" + prNumber + ":" + headSha;
}

/**
 * FR-02: mark the latest published review for a PR as superseded when the
 * authoritative PR head has moved past the reviewed SHA. Called from the
 * synchronize path — never enqueues another AI review (a review-frequency
 * policy decision that stays out of scope).
 *
 * Race-safety contract:
 *   - the comparison uses the CURRENT PR head from the GitHub API at
 *     processing time, never the webhook payload's SHA (out-of-order
 *     deliveries cannot downgrade a newer publication);
 *   - only the LATEST published row is considered, so historical reviews
 *     for older heads are preserved as evidence and never re-marked;
 *   - a row already SUPERSEDED is a no-op, and the GitHub notice is
 *     marker-anchored so repeated deliveries never duplicate it.
 *
 * @param {{ octokit: object, repository: object, pr: object }} input
 * @returns {Promise<{action: "superseded"|"noop", reason?: string, from?: string, to?: string}>}
 */
export async function supersedePublishedReviewForPr({ octokit, repository, pr }) {
  const owner = repository.owner?.login;
  const repo = repository.name;
  if (!owner || !repo || !pr?.number) {
    return { action: "noop", reason: "unusable_input" };
  }
  // FR-02: truthfulness only. Compare the AUTHORITATIVE PR head (API at
  // processing time) against the latest PUBLISHED review's SHA; never the
  // event payload. Only the latest published row is considered, so older
  // reviews stay untouched as evidence. Idempotent via early SUPERSEDED
  // no-op plus marker-anchored notice. Never enqueues another AI review.
  const { rows } = await db.query(
    "SELECT id, commit_sha, github_review_id, check_run_id, integrity_state " +
    "FROM ai_reviews " +
    "WHERE repo_id = $1 AND pr_number = $2 " +
    "  AND publication_state = 'published' AND github_review_id IS NOT NULL " +
    "ORDER BY id DESC LIMIT 1",
    [repository.id, pr.number]
  );
  const row = rows[0];
  if (!row) return { action: "noop", reason: "no_published_review" };
  if (row.integrity_state === "SUPERSEDED") return { action: "noop", reason: "already_superseded" };
  const { data: currentPr } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: pr.number }
  );
  const currentHead = currentPr?.head?.sha ?? null;
  if (!currentHead) return { action: "noop", reason: "head_unavailable" };
  if (currentHead === row.commit_sha) return { action: "noop", reason: "head_matches_publication" };
  const marker = "gitwire-pub-superseded:" + row.id + ":" + repository.id + ":" + pr.number + ":" + row.commit_sha;
  let existing;
  try {
    existing = await findMarkerMatches(octokit, owner, repo, pr.number, marker);
  } catch (lookupErr) {
    logger.warn({ err: lookupErr.message || lookupErr, pr: pr.number }, "Supersession notice lookup failed — deferring");
    return { action: "noop", reason: "notice_lookup_failed" };
  }
  if (existing.length > 0) {
    await db.query(
      "UPDATE ai_reviews SET integrity_state = 'SUPERSEDED', terminal_reason = 'head_superseded_post_publication' " +
      "WHERE id = $1 AND integrity_state <> 'SUPERSEDED'",
      [row.id]
    );
    return { action: "noop", reason: "notice_already_present" };
  }
  const banner =
    "## ⚠️ GitWire review superseded\n" +
    "The AI review below addressed head `" + row.commit_sha.slice(0, 12) + "…`; the PR head is now `" + currentHead.slice(0, 12) + "…`. " +
    "The earlier review is retained as evidence but no longer describes the current code. No new AI review was auto-triggered.\n" +
    "<!-- " + marker + " -->";
  await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner, repo, pull_number: pr.number, event: "COMMENT",
    body: banner,
  });
  await db.query(
    "UPDATE ai_reviews SET integrity_state = 'SUPERSEDED', terminal_reason = 'head_superseded_post_publication' " +
    "WHERE id = $1 AND integrity_state <> 'SUPERSEDED'",
    [row.id]
  );
  if (row.check_run_id) {
    await finaliseCheckRun(octokit, owner, repo, row.check_run_id, "neutral", {
      title:   "⚠️ AI Review — superseded (head moved)",
      summary: "This review addressed head " + row.commit_sha.slice(0, 12) + "…; the PR has advanced to " + currentHead.slice(0, 12) + "…. Retained as evidence; no new review was auto-triggered.",
      text:    "",
    });
  }
  logger.info(
    { repo: repository.full_name, pr: pr.number, reviewId: row.id, from: row.commit_sha.slice(0, 12), to: currentHead.slice(0, 12) },
    "Published review superseded after synchronize"
  );
  return { action: "superseded", from: row.commit_sha, to: currentHead };
}

/**
 * Terminate an invocation that lost the publication to a concurrent owner:
 * truthful neutral check, durable terminal reason, no GitHub mutation.
 */
async function suppressConcurrentPublication({ octokit, owner, repo, checkRunId, reviewRowId, summary }) {
  if (checkRunId) {
    await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
      title:   "\u2705 AI review publication handled by another invocation",
      summary,
      text:    "",
    });
  }
  await db.query(
    "UPDATE ai_reviews SET terminal_reason = 'publication_suppressed_concurrent' WHERE id = $1",
    [reviewRowId]
  ).catch(function (persistErr) {
    logger.warn({ err: persistErr.message }, "AI review: suppression persist failed");
  });
  return {
    verdict: "suppressed", suppressedPublication: true,
    blocked: false, findings: [],
    publication: { publicationAllowed: false },
  };
}

const REVIEW_LOOKUP_PAGE_CAP = 20; // safety cap; a full final page fails closed

/**
 * Paginate the PR's reviews and return those whose body carries the exact
 * publication marker. The lookup is bounded at REVIEW_LOOKUP_PAGE_CAP pages;
 * if the cap is reached with a FULL final page, another page may exist, so
 * the lookup is incomplete and throws (E_PUBLICATION_LOOKUP) — it is never
 * reported as zero matches, because a marker beyond the cap must not
 * authorize a second publication (frozen v1.2 criterion 13).
 */
async function findMarkerMatches(octokit, owner, repo, prNumber, marker) {
  const needle = "<!-- " + marker + " -->";
  const matches = [];
  for (let page = 1; page <= REVIEW_LOOKUP_PAGE_CAP; page++) {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { owner, repo, pull_number: prNumber, per_page: 100, page }
    );
    if (!Array.isArray(data) || data.length === 0) break;
    for (const review of data) {
      if (typeof review.body === "string" && review.body.includes(needle)) {
        matches.push({ id: review.id });
      }
    }
    if (data.length < 100) break;
    if (page === REVIEW_LOOKUP_PAGE_CAP) {
      const capped = new Error(
        "marker lookup did not complete — review pagination cap (" +
        REVIEW_LOOKUP_PAGE_CAP * 100 + " reviews) reached with a full final page; " +
        "the marker may exist beyond it"
      );
      capped.gitwireErrorCode = "E_PUBLICATION_LOOKUP";
      throw capped;
    }
  }
  return matches;
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

function buildCheckOutput(findings, verdict, confidence, summary, scopeDroppedCount, coverageLine, publishedOutcome) {
  var ICONS = { approved: "\u2705", needs_discussion: "\uD83D\uDCAC", request_changes: "\u274C" };
  // PB-01: the check title states the FINALIZED publication outcome. An
  // INCOMPLETE publication reads as incomplete evidence, never as approved —
  // the raw verdict glyph set only applies to outcomes it matches.
  var OUTCOME_ICONS = { APPROVE: "\u2705", NEEDS_DISCUSSION: "\uD83D\uDCAC", REQUEST_CHANGES: "\u274C", INCOMPLETE: "\u26A0\uFE0F" };
  var OUTCOME_WORDS = { APPROVE: "approved", NEEDS_DISCUSSION: "needs discussion", REQUEST_CHANGES: "changes requested", INCOMPLETE: "incomplete evidence" };
  var title = (OUTCOME_ICONS[publishedOutcome] ?? ICONS[verdict] ?? "\uD83E\uDD16") +
    " AI Review \u2014 " + (OUTCOME_WORDS[publishedOutcome] ?? verdict.replace(/_/g, " ")) +
    " (" + confidence + " confidence)";

  var details = findings.map(function (f) {
    return "- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " \u2014 `" + f.file + "`" : "") + "\n  " + f.description;
  }).join("\n");

  var scopeNote = scopeDroppedCount > 0
    ? "\n\n*" + scopeDroppedCount + " out-of-scope findings filtered.*"
    : "";

  var coverageNote = coverageLine ? "\n\n" + coverageLine : "";

  return {
    title: title,
    summary: (summary || findings.length + " finding" + (findings.length !== 1 ? "s" : "")) + scopeNote + coverageNote,
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
// Retryability of failed review attempts (PC-01 v2.1 amendment)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Terminal reasons for which a repeated BullMQ attempt should actually
 * re-run the review. Only TRANSIENT token-counting failures retry:
 * timeout, transport, and rate-limit classed conditions a later
 * exponential-backoff attempt can plausibly repair. Permanent classes
 * (auth_entitlement, quota, other) persist as 'token_count_permanent'
 * and never re-enter reviewPR — the queue's remaining attempts cannot
 * repair them. Deterministic enforcement failures
 * ('input_budget_exceeded') and deadline exhaustion
 * ('deadline_exceeded') also never re-run.
 */
const TRANSIENT_PROVIDER_FAILURE_CLASSES = new Set(["timeout", "transport", "rate_limit"]);
const RETRYABLE_REVIEW_FAILURE_REASONS = new Set(["token_count_failed", "provider_failed"]);

function reviewErrorTerminalReason(err) {
  if (err?.gitwireErrorCode === "E_TOKEN_COUNT_FAILED") {
    return TRANSIENT_PROVIDER_FAILURE_CLASSES.has(err.gitwireRejectionClass)
      ? "token_count_failed"
      : "token_count_permanent";
  }
  if (err?.gitwireErrorCode === "E_REVIEW_PROVIDER_TRANSIENT") return "provider_failed";
  if (err?.gitwireErrorCode === "E_INPUT_BUDGET_EXCEEDED") return "input_budget_exceeded";
  if (err?.gitwireErrorCode === "E_REVIEW_DEADLINE_EXCEEDED") return "deadline_exceeded";
  return "error";
}

/**
 * True when the latest persisted attempt for (repo, PR, head) failed with a
 * retryable reason. The worker consults this on a repeated BullMQ attempt
 * whose checkAndMark marker already exists: the marker records processing,
 * not success, so the persisted outcome decides whether the review re-runs.
 *
 * @param {number} repoId
 * @param {number} prNumber
 * @param {string} headSha
 * @returns {Promise<boolean>}
 */
export async function isRetryableReviewFailure(repoId, prNumber, headSha) {
  try {
    const { rows } = await db.query(
      "SELECT terminal_reason FROM ai_reviews " +
      "WHERE repo_id = $1 AND pr_number = $2 AND commit_sha = $3 " +
      "ORDER BY id DESC LIMIT 1",
      [repoId, prNumber, headSha]
    );
    return RETRYABLE_REVIEW_FAILURE_REASONS.has(rows[0]?.terminal_reason ?? "");
  } catch (err) {
    // Fail closed: without the persisted outcome we cannot prove the prior
    // attempt failed retryably, so the marker keeps its dedupe meaning.
    logger.warn({ err: err.message, repoId, prNumber }, "Retryable-failure lookup failed — honoring idempotency marker");
    return false;
  }
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
