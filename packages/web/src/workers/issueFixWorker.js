// src/workers/issueFixWorker.js
// Autonomous Contributor - picks up an issue, analyzes the codebase,
// generates a fix, and submits a PR.
//
// Pipeline stages are in workers/issueFix/:
//   1. context.js     — config + trusted execution context
//   2. scopeGuard.js  — label check, fetch issue + exact-head tree
//   3. analyze.js     — AI pass 1, complexity gate
//   4. generate.js    — file scoring, AI pass 2
//   5. validate.js    — risk, confidence, scope, patches
//   6. submit.js      — current-binding/head fence, branch, commit, PR, comment

import { createWorker, QUEUES } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { processFixIssue } from "./issueFix/pipeline.js";
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";
import { validateIssueFixJob } from "../services/issueFixJobService.js";
import { resolveIssueFixRepositoryById } from "../services/issueFixTargetService.js";

// Re-export extractJSON for E2E tests that import it
export { extractJSON } from "./issueFix/helpers.js";

export function startIssueFixWorker() {
  return createWorker(QUEUES.ISSUE_FIX, async (job) => {
    if (job.name !== "fix-issue") return;

    // D0-02 consumer boundary: stale/direct legacy jobs that still carry a
    // caller-selected installationId are invalid. Fail visibly rather than
    // turning them into authority-bearing work.
    const command = validateIssueFixJob(job.data);

    // Re-resolve the stable repository id immediately before execution. This
    // refreshes installation ownership after transfer/uninstall and prevents a
    // queued snapshot from choosing execution authority.
    const resolution = await resolveIssueFixRepositoryById(command.repository.github_id);
    if (resolution.status !== "resolved") {
      throw new Error(`Issue-fix repository unavailable at execution (${resolution.status})`);
    }
    const repository = resolution.repository;

    if (repository.full_name !== command.repository.full_name) {
      logger.info(
        { repositoryId: repository.github_id, queuedName: command.repository.full_name, currentName: repository.full_name },
        "Issue-fix repository renamed after enqueue — using current server-owned identity",
      );
    }

    const adoption = await adoptWorker({
      workerId: "worker:issueFix",
      permission: "pull_request:create",
      resourceType: "repository",
      installationId: repository.installation_id,
      systemPrincipalName: "system:issue-fix-worker",
      // workerAdoption resolves repositoryId from this lookup key and verifies
      // the installation/repository relationship in server-owned state.
      jobData: { repositoryId: repository.github_id },
      legacyActor: command.trigger.requested_by_login,
    });
    const principalId = workerPrincipalId(adoption.context);

    await processFixIssue({
      repository,
      issueNumber: command.issue_number,
      triggeredBy: command.trigger.kind,
      requestedByLogin: command.trigger.requested_by_login ?? null,
      requestedByPrincipalId: command.trigger.requested_by_principal_id ?? null,
      principalId,
    });
  }, { concurrency: 1 }); // one fix at a time to respect rate limits
}
