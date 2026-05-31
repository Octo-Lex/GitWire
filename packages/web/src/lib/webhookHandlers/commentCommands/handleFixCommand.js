// src/lib/webhookHandlers/commentCommands/handleFixCommand.js
// /gitwire fix — trigger autonomous issue fix.

export async function handleFixCommand(payload, parsed, action, ctx) {
  await ctx.issueFixQueue.add("fix-issue", {
    repo: payload.repository?.full_name,
    issueNumber: parsed.issueNumber,
    installationId: payload.installation?.id,
    triggeredBy: parsed.authorLogin,
  }, { priority: 1 });

  ctx.logger.info(
    { command: "fix", repo: payload.repository?.full_name, issue: parsed.issueNumber },
    "Fix command queued"
  );
}
