// src/workers/issueFixWorker.js
// Autonomous Contributor - picks up an issue, analyzes the codebase,
// generates a fix, and submits a PR.
//
// Pipeline stages are in workers/issueFix/:
//   1. context.js     — idempotency, config, rate limit
//   2. scopeGuard.js  — label check, fetch issue + tree
//   3. analyze.js     — AI pass 1, complexity gate
//   4. generate.js    — file scoring, AI pass 2
//   5. validate.js    — risk, confidence, scope, patches
//   6. submit.js      — branch, commit, PR, comment

import { createWorker, QUEUES } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { processFixIssue } from "./issueFix/pipeline.js";

// Re-export extractJSON for E2E tests that import it
export { extractJSON } from "./issueFix/helpers.js";

export function startIssueFixWorker() {
  return createWorker(QUEUES.ISSUE_FIX, async (job) => {
    if (job.name === "fix-issue") {
      await processFixIssue(job.data);
    }
  }, { concurrency: 1 }); // one fix at a time to respect rate limits
}
