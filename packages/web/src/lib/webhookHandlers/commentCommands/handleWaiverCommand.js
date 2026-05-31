// src/lib/webhookHandlers/commentCommands/handleWaiverCommand.js
// /gitwire waive/unwaive — grant or revoke policy waivers.
// Handles DB operations directly and posts a response comment.

import { buildCommandResponse } from "../../../lib/commentRouter.js";

export async function handleWaiverCommand(payload, parsed, action, ctx) {
  const { grantWaiver, revokeWaiver } = await import("../../../services/waiverService.js");
  const repoFullName = payload.repository?.full_name;

  // Resolve repo ID
  const { rows: [repoRow] } = await ctx.db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repoFullName]
  );

  let waiverResult;

  if (action.action === "grant_waiver") {
    if (!repoRow) {
      waiverResult = { error: "Repository not found" };
    } else {
      waiverResult = await grantWaiver({
        repoId: repoRow.github_id,
        pillar: action.pillar,
        scope: action.scope,
        scopeValue: action.scopeValue,
        reason: action.reason,
        grantedBy: parsed.authorLogin,
        expiresAt: action.expiresAt,
      });
    }
  } else {
    waiverResult = await revokeWaiver(action.waiverId, parsed.authorLogin);
  }

  // Post response comment
  const respBody = buildCommandResponse(action.action, {
    waiver: waiverResult,
    waiverId: action.waiverId,
  });

  if (respBody && payload.installation?.id) {
    await postWaiverResponse(payload, parsed, respBody, ctx);
  }

  ctx.logger.info({ command: action.action, repo: repoFullName }, "Waiver command processed");
}

async function postWaiverResponse(payload, parsed, body, ctx) {
  try {
    const octokit = ctx.wrapOctokit(await ctx.getInstallationClient(payload.installation.id));
    const [owner, repo] = payload.repository.full_name.split("/");
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: parsed.issueNumber, body,
    });
  } catch (commentErr) {
    ctx.logger.warn({ err: commentErr.message }, "Failed to post waiver response comment");
  }
}
