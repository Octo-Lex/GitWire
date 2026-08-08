// src/workers/issueFix/pipeline.js
// Main pipeline orchestrator for autonomous issue fixing.
//
// Pipeline stages:
//   1. initFixContext()   — config, rate limit, DB lookup
//   2. validateScope()    — label check, fetch issue + tree
//   3. analyzeIssue()     — AI pass 1, complexity gate
//   4. generateFixes()    — file scoring, AI pass 2
//   5. validateFixes()    — risk, confidence, scope, patches
//   6. submitFix()        — branch, commit, PR, comment
//
// The issue_fix idempotency guard runs at stage 6 (immediately before
// submitFix), NOT at stage 1. This ensures that pre-submission failures
// (disabled pillar, scope rejection, file-not-found, low confidence) do
// not poison the idempotency marker and block retries. The guard still
// prevents duplicate submissions of the same fix for the same issue.

import { initFixContext } from "./context.js";
import { validateScope } from "./scopeGuard.js";
import { analyzeIssue } from "./analyze.js";
import { generateFixes } from "./generate.js";
import { validateFixes } from "./validate.js";
import { submitFix } from "./submit.js";
import { checkAndMark } from "../../services/idempotencyService.js";
import { logger } from "../../lib/logger.js";

/**
 * Main pipeline — CC target: ~8 (one early-return per stage)
 */
export async function processFixIssue(jobData) {
  const ctx = await initFixContext(jobData);
  if (!ctx) return;

  const scope = await validateScope(ctx);
  if (!scope) return;

  // Attach scope to context for downstream stages
  ctx._scope = scope;

  const analysis = await analyzeIssue(ctx, scope);
  if (!analysis) return;

  const fixes = await generateFixes(ctx, analysis);
  if (!fixes) return;

  const validated = await validateFixes(ctx, analysis, fixes);
  if (!validated) return;

  // ── Submission idempotency guard ─────────────────────────────────────────
  // Placed here (not at pipeline entry) so that pre-submission failures do
  // not write the marker. A failed analysis, file fetch, or validation must
  // remain retryable through /gitwire fix without Redis intervention.
  // The guard prevents a duplicate submission for the same issue within
  // the dedup window (1 hour by default).
  if (!(await checkAndMark("issue_fix", "issue-" + ctx.issueNumber))) {
    logger.info({ issue: ctx.issueNumber }, "Issue fix already submitted — skipping duplicate submission");
    return;
  }

  await submitFix(ctx, analysis, validated);
}
