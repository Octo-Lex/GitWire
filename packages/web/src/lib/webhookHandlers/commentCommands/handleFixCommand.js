// src/lib/webhookHandlers/commentCommands/handleFixCommand.js
// /gitwire fix — trigger autonomous issue fix.

import { buildIssueFixJob, enqueueIssueFixJob } from "../../../services/issueFixJobService.js";
import { resolveIssueFixRepositoryByFullName } from "../../../services/issueFixTargetService.js";

export async function handleFixCommand(payload, parsed, action, ctx) {
  const repoFullName = payload.repository?.full_name;
  const resolution = await resolveIssueFixRepositoryByFullName(repoFullName);
  if (resolution.status !== "resolved") {
    throw new Error(`Cannot queue issue fix: repository binding ${resolution.status}`);
  }

  const jobData = buildIssueFixJob({
    repository: resolution.repository,
    issueNumber: parsed.issueNumber,
    triggerKind: "comment_command",
    requestedByLogin: parsed.authorLogin,
  });
  await enqueueIssueFixJob(ctx.issueFixQueue, jobData, { priority: 1 });

  ctx.logger.info(
    { command: "fix", repo: repoFullName, issue: parsed.issueNumber, repositoryId: resolution.repository.github_id },
    "Fix command queued with server-owned repository binding"
  );
}
