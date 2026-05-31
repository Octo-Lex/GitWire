// src/lib/webhookHandlers/handleIssueComment.js
// Handler for "issue_comment" webhook events.
// Parses /gitwire commands and routes to the appropriate queue or direct handler.

import { parseGitwireCommand, resolveCommandAction, buildCommandResponse } from "../../lib/commentRouter.js";
import { handleManualRun } from "./commentCommands/handleManualRun.js";
import { handleFixCommand } from "./commentCommands/handleFixCommand.js";
import { handleWaiverCommand } from "./commentCommands/handleWaiverCommand.js";

export async function handleIssueComment(payload, deliveryId, ctx) {
  if (payload.action !== "created" || !payload.comment) return;

  const parsed = parseGitwireCommand(payload.comment.body, {
    repo: payload.repository?.full_name,
    issueNumber: payload.issue?.number,
    commentId: payload.comment.id,
    authorAssociation: payload.comment.author_association,
    authorLogin: payload.comment.user?.login,
  });

  if (!parsed) return;

  const action = resolveCommandAction(parsed);
  if (!action) return;

  // Delegate to the appropriate command handler
  switch (action.action) {
    case "manual_run":
      await handleManualRun(payload, parsed, action, ctx);
      break;
    case "fix_issue":
      await handleFixCommand(payload, parsed, action, ctx);
      break;
    case "grant_waiver":
    case "revoke_waiver":
      await handleWaiverCommand(payload, parsed, action, ctx);
      break;
    default:
      // All other commands → maintainer queue
      await ctx.maintainerQueue.add("comment-command", {
        ...action,
        installationId: payload.installation?.id,
        repoFullName: payload.repository?.full_name,
        issueNumber: parsed.issueNumber,
        commentId: parsed.commentId,
        authorLogin: parsed.authorLogin,
      }, { priority: 1 });
      ctx.logger.info(
        { command: parsed.command, repo: payload.repository?.full_name },
        "Gitwire comment command queued"
      );
  }
}
