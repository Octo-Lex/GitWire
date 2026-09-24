// src/workers/issueFix/pipeline.js
// Main pipeline orchestrator for autonomous issue fixing.
//
// Pipeline stages:
//   1. initFixContext()   — config + trusted repository binding
//   2. validateScope()    — label check, fetch issue + exact-head tree
//   3. analyzeIssue()     — AI pass 1, complexity gate
//   4. generateFixes()    — file scoring, AI pass 2
//   5. validateFixes()    — risk, confidence, scope, patches
//   6. submitFix()        — freshness/idempotency fence, branch, commit, PR

import { initFixContext } from "./context.js";
import { validateScope } from "./scopeGuard.js";
import { analyzeIssue } from "./analyze.js";
import { generateFixes } from "./generate.js";
import { validateFixes } from "./validate.js";
import { submitFix } from "./submit.js";

/** Main pipeline — one early-return per stage. */
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

  // Submission idempotency intentionally lives inside submitFix(), after the
  // repository-binding and exact-head fences and immediately before the first
  // GitHub mutation. A stale/superseded attempt therefore does not poison the
  // legacy idempotency marker and remains retryable.
  await submitFix(ctx, analysis, validated);
}
