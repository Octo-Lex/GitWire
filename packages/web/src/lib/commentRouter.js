// src/lib/commentRouter.js
// Parses /gitwire commands from issue/PR comments.
//
// Accepted commands (maintainers only — OWNER, MEMBER, COLLABORATOR):
//   /gitwire status
//   /gitwire stale scan
//   /gitwire clean branches
//   /gitwire fix
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
  if (!body) return null;

  // Only maintainers can issue commands
  if (!MAINTAINER_ROLES.has(authorAssociation)) {
    logger.info({ authorLogin, authorAssociation }, "Comment command ignored — not a maintainer");
    return null;
  }

  // Find /gitwire anywhere in the comment (may be preceded by other text)
  const cmdIndex = body.indexOf(COMMAND_PREFIX);
  if (cmdIndex === -1) return null;

  const afterCmd = body.slice(cmdIndex).trim();
  const tokens = afterCmd.split(/\s+/);
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

    case "fix":
      return { action: "fix_issue" };

    case "run":
      // /gitwire run [triage|review|heal|fix|all]
      return { action: "manual_run", pillar: args[0] || "all" };

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

    case "waive": {
      // /gitwire waive <pillar> for <scope> until <date> reason "<text>"
      // e.g., /gitwire waive ci_healing for release/* until 2026-06-01 reason "release freeze"
      const pillar = args[0];
      if (!pillar) return null;
      let scope = "repo";
      let scopeValue = null;
      let expiresAt = null;
      let reason = "";

      // Parse 'for' clause
      const forIdx = args.indexOf("for");
      if (forIdx !== -1 && args[forIdx + 1]) {
        scopeValue = args[forIdx + 1];
        if (/^\d+$/.test(scopeValue)) {
          scope = "pr"; // numeric = PR or issue number
        } else if (scopeValue.includes("*") || scopeValue.includes("/")) {
          scope = "branch"; // glob or branch name
        } else {
          scope = "branch";
        }
      }

      // Parse 'until' clause
      const untilIdx = args.indexOf("until");
      if (untilIdx !== -1 && args[untilIdx + 1]) {
        const untilStr = args[untilIdx + 1];
        // Accept YYYY-MM-DD or ISO date
        try {
          expiresAt = new Date(untilStr).toISOString();
        } catch (_e) {
          expiresAt = null;
        }
      }

      // Parse 'reason' clause — everything after 'reason' is the reason text
      const reasonIdx = args.indexOf("reason");
      if (reasonIdx !== -1) {
        reason = args.slice(reasonIdx + 1).join(" ").replace(/^['"]|['"]$/g, "");
      }
      if (!reason) reason = "No reason provided";

      return { action: "grant_waiver", pillar, scope, scopeValue, expiresAt, reason };
    }

    case "unwaive": {
      // /gitwire unwaive <id>
      const waiverId = parseInt(args[0], 10);
      if (!waiverId) return null;
      return { action: "revoke_waiver", waiverId };
    }

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

    case "fix_issue":
      return "🔧 **GitWire:** Issue fix analysis started. I'll analyze the codebase and submit a PR if I can fix this.";

    case "manual_run": {
      const pillar = data.pillar || "all";
      const pillarLabel = pillar === "all" ? "all applicable workers" : "**" + pillar + "**";
      return "▶️ **GitWire:** Re-evaluation triggered for " + pillarLabel + ". Results will appear shortly.";
    }

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

    case "grant_waiver": {
      const w = data.waiver;
      const scopeText = w.scope === "repo" ? "entire repo" : w.scope + " `" + w.scope_value + "`";
      const expiryText = w.expires_at ? " until " + w.expires_at.split("T")[0] : " (indefinite)";
      return "🛡️ **GitWire:** Waiver granted — **" + w.pillar + "** paused for " + scopeText + expiryText + ".\n> " + w.reason + " (waiver #" + w.id + ")";
    }

    case "revoke_waiver":
      return "✅ **GitWire:** Waiver #" + data.waiverId + " revoked. Pillar enforcement resumed.";

    default:
      return null;
  }
}
