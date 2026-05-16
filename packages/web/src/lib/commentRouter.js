// src/lib/commentRouter.js
// Parses /gitwire commands from issue/PR comments.
//
// Accepted commands (maintainers only — OWNER, MEMBER, COLLABORATOR):
//   /gitwire status
//   /gitwire stale scan
//   /gitwire clean branches
//   /gitwire stop
//   /gitwire settings stale <days>
//   /gitwire settings pr-stale <days>
//
// The router only parses. Execution happens in the webhook handler or worker.

import { logger } from "./logger.js";

const COMMAND_PREFIX = "/gitwire";
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Parsed command result
// { command, args[], repo, issueNumber, commentId, authorAssociation }

export function parseGitwireCommand(body, { repo, issueNumber, commentId, authorAssociation, authorLogin }) {
  if (!body || !body.startsWith(COMMAND_PREFIX)) return null;

  // Only maintainers can issue commands
  if (!MAINTAINER_ROLES.has(authorAssociation)) {
    logger.info({ authorLogin, authorAssociation }, "Comment command ignored — not a maintainer");
    return null;
  }

  const tokens = body.trim().split(/\s+/);
  const command = tokens[1] || null;

  if (!command) return null;

  const args = tokens.slice(2);

  return {
    command: command,
    args: args,
    repo: repo,
    issueNumber: issueNumber,
    commentId: commentId,
    authorLogin: authorLogin,
    authorAssociation: authorAssociation,
  };
}

// Resolve a parsed command to an action
export function resolveCommandAction(parsed) {
  if (!parsed) return null;

  const { command, args } = parsed;

  switch (command) {
    case "status":
      return { action: "status" };

    case "stale":
      if (args[0] === "scan") {
        return { action: "stale_scan" };
      }
      return null;

    case "clean":
      if (args[0] === "branches") {
        return { action: "branch_cleanup" };
      }
      return null;

    case "stop":
      return { action: "stop" };

    case "settings":
      if (args[0] === "stale" && args[1] && !isNaN(parseInt(args[1], 10))) {
        return { action: "set_stale_issue_days", value: parseInt(args[1], 10) };
      }
      if (args[0] === "pr-stale" && args[1] && !isNaN(parseInt(args[1], 10))) {
        return { action: "set_stale_pr_days", value: parseInt(args[1], 10) };
      }
      return { action: "show_settings" };

    default:
      return null;
  }
}

// Build a response body for a command
export function buildCommandResponse(action, data) {
  switch (action) {
    case "status":
      return [
        "**GitWire Status**",
        "",
        "Repos: " + (data.repoCount || 0),
        "Issues triaged: " + (data.triagedCount || 0),
        "CI healed: " + (data.healedCount || 0),
        "Stale actions (7d): " + (data.staleActions || 0),
        "",
        "_Maintainer is " + (data.enabled ? "enabled" : "disabled") + " on this repo._",
      ].join("\n");

    case "stale_scan":
      return "✅ **GitWire:** Stale scan triggered for this repo. Results will appear in issue comments.";

    case "branch_cleanup":
      return "✅ **GitWire:** Branch cleanup triggered for this repo.";

    case "stop":
      return "⏸️ **GitWire:** Maintainer automation paused for this repo. Use `/gitwire settings enable` to resume.";

    case "show_settings":
      return [
        "**GitWire Maintainer Settings**",
        "",
        "Stale issue threshold: **" + (data.stale_issue_days || 60) + " days**",
        "Stale PR threshold: **" + (data.stale_pr_days || 30) + " days**",
        "Warning period: **" + (data.stale_warn_days || 7) + " days**",
        "Branch cleanup: **" + (data.cleanup_branches ? "on" : "off") + "**",
        "",
        "Change with: `/gitwire settings stale <days>` or `/gitwire settings pr-stale <days>`",
      ].join("\n");

    case "set_stale_issue_days":
      return "✅ **GitWire:** Stale issue threshold set to **" + data.value + " days**.";

    case "set_stale_pr_days":
      return "✅ **GitWire:** Stale PR threshold set to **" + data.value + " days**.";

    default:
      return null;
  }
}
