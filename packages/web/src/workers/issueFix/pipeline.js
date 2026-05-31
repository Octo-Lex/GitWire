// src/workers/issueFix/pipeline.js
// Main pipeline orchestrator for autonomous issue fixing.
//
// Pipeline stages:
//   1. initFixContext()   — idempotency, config, rate limit
//   2. validateScope()    — label check, fetch issue + tree
//   3. analyzeIssue()     — AI pass 1, complexity gate
//   4. generateFixes()    — file scoring, AI pass 2
//   5. validateFixes()    — risk, confidence, scope, patches
//   6. submitFix()        — branch, commit, PR, comment

import { initFixContext } from "./context.js";
import { validateScope } from "./scopeGuard.js";
import { analyzeIssue } from "./analyze.js";
import { generateFixes } from "./generate.js";
import { validateFixes } from "./validate.js";
import { submitFix } from "./submit.js";
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

  await submitFix(ctx, analysis, validated);
}
