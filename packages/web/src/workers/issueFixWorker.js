// src/workers/issueFixWorker.js
// Autonomous Contributor - picks up an issue, analyzes the codebase,
// generates a fix, and submits a PR.
//
// Pipeline stages are in workers/issueFix/:
//   1. context.js     — config + trusted execution context
//   2. scopeGuard.js  — label check, fetch issue + exact-head tree
//   3. analyze.js     — AI pass 1, complexity gate
//   4. generate.js    — exact-tree file selection, AI pass 2
//   5. validate.js    — deterministic candidate/risk/policy guards
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

    // Consumer boundary: stale/direct legacy jobs carrying caller-selected
    // installationId are invalid and fail visibly.
    const command = validateIssueFixJob(job.data);

    // Re-resolve the stable repository id immediately before execution. The
    // queued installation snapshot is a fence only; it is never used to open a
    // GitHub client or authorize execution.
    const resolution = await resolveIssueFixRepositoryById(command.repository.github_id);
    if (resolution.status !== "resolved") {
      throw new Error(`Issue-fix repository unavailable at execution (${resolution.status})`);
    }
    const repository = resolution.repository;

    // A queued request must not silently follow a rename/transfer/reinstall into
    // a different authority domain. The user/operator can retrigger against the
    // current repository identity after the move.
    if (
      repository.full_name !== command.repository.full_name ||
      String(repository.installation_id) !== String(command.repository.expected_installation_id)
    ) {
      throw new Error("Issue-fix repository binding changed after enqueue");
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
