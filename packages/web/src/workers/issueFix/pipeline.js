// src/workers/issueFix/pipeline.js
// Main pipeline orchestrator for autonomous issue fixing.
//
// Pipeline stages:
//   1. initFixContext()   — config + trusted repository binding
//   2. validateScope()    — label check, fetch issue + exact-head tree
//   3. analyzeIssue()     — AI pass 1, complexity gate
//   4. generateFixes()    — file scoring, AI pass 2
//   5. validateFixes()    — risk, confidence, scope, patches
//   6. submitFix()        — pre-effect binding/head fence, branch, commit, PR
//
// The issue_fix idempotency guard runs at stage 6 (immediately before
// submitFix), NOT at stage 1. This ensures that pre-submission failures
// remain retryable. D0-02 scopes the key by stable repository id so equal
// issue numbers in different repositories do not suppress each other.

import { initFixContext } from "./context.js";
import { validateScope } from "./scopeGuard.js";
import { analyzeIssue } from "./analyze.js";
import { generateFixes } from "./generate.js";
import { validateFixes } from "./validate.js";
import { submitFix } from "./submit.js";
import { checkAndMark } from "../../services/idempotencyService.js";
import { logger } from "../../lib/logger.js";

/** Main pipeline — CC target: ~8 (one early-return per stage). */
export async function processFixIssue(jobData) {
  const ctx = await initFixContext(jobData);
  if (!ctx) return;

  const scope = await validateScope(ctx);
  if (!scope) return;

  ctx._scope = scope;

  const analysis = await analyzeIssue(ctx, scope);
  if (!analysis) return;

  const fixes = await generateFixes(ctx, analysis);
  if (!fixes) return;

  const validated = await validateFixes(ctx, analysis, fixes);
  if (!validated) return;

  // This remains the legacy checkAndMark primitive; Wave 3 will replace it
  // with a durable command/idempotency invariant. The key is nevertheless
  // resource-correct now: issue #42 in repo A is distinct from #42 in repo B.
  const idempotencyKey = "repo-" + ctx.repoId + ":issue-" + ctx.issueNumber;
  if (!(await checkAndMark("issue_fix", idempotencyKey))) {
    logger.info({ repo: ctx.repo, issue: ctx.issueNumber }, "Issue fix already submitted — skipping duplicate submission");
    return;
  }

  await submitFix(ctx, analysis, validated);
}
