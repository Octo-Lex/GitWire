// src/services/feedbackService.js
// Multi-channel developer feedback for Phase 2.
// Adapted for GitWire: no octokit.rest.*, no silent catches.

import { db }     from "../lib/db.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";

// ════════════════════════════════════════════════════════════════════════════
// Main entry point
// ════════════════════════════════════════════════════════════════════════════

export async function sendFeedback({ eventType, repoId, repository, prNumber, octokit, data }) {
  const rules = await loadRules(eventType, repository.full_name);
  if (!rules.length) return;

  const owner = repository.owner.login;
  const repo  = repository.name;

  for (const rule of rules) {
    try {
      if (rule.post_pr_comment && prNumber) {
        const body = buildComment(eventType, data, repository, rule);
        if (body) {
          await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner, repo, issue_number: prNumber, body,
          });
        }
      }

      if (rule.slack_webhook) {
        const payload = buildSlackPayload(eventType, data, repository, prNumber);
        await postWebhook(rule.slack_webhook, payload);
      }

      if (rule.teams_webhook) {
        const payload = buildTeamsPayload(eventType, data, repository, prNumber);
        await postWebhook(rule.teams_webhook, payload);
      }

      await Events.feedbackSent(repoId, {
        prNumber,
        metadata: { rule_id: rule.id, event_type: eventType, channels: getChannels(rule) },
      });

    } catch (err) {
      logger.warn({ rule: rule.id, eventType, err: err.message }, "Feedback: delivery failed (non-fatal)");
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PR comment templates
// ════════════════════════════════════════════════════════════════════════════

function buildComment(eventType, data, repository, rule) {
  const repoUrl = "https://github.com/" + repository.full_name;

  switch (eventType) {
    case "ci_failure":      return ciFailureComment(data, repoUrl, rule);
    case "ci_heal":         return ciHealComment(data, repoUrl);
    case "pr_merged":       return prMergedComment(data, repoUrl);
    case "pr_blocked":      return prBlockedComment(data, repoUrl);
    case "config_failed":   return configFailedComment(data, repoUrl);
    default:                return null;
  }
}

function ciFailureComment(data, repoUrl, rule) {
  const lines = ["## CI failure report", "",
    "**Workflow:** " + (data.workflow_name ?? "unknown") + " **Branch:** " + (data.branch ?? "unknown"), ""];
  if (data.root_cause)   lines.push("### AI diagnosis", "", data.root_cause, "");
  if (data.suggested_fix) lines.push("### Suggested fix", "", data.suggested_fix, "");
  if (data.run_url && rule.include_log_link) lines.push("[View full log](" + data.run_url + ")");
  if (data.heal_pr_url)   lines.push("", "[Auto-fix PR opened](" + data.heal_pr_url + ")");
  lines.push("", "---", "_GitWire CI Feedback_");
  return lines.join("\n");
}

function ciHealComment(data, repoUrl) {
  const lines = ["## Self-healing CI — patch applied", "",
    "**Failure type:** " + data.failure_type, "**Root cause:** " + data.root_cause, ""];
  if (data.pr_url) lines.push("[Review the heal PR](" + data.pr_url + ")", "", "Please review before merging.");
  lines.push("", "---", "_Confidence: " + (data.confidence ?? "unknown") + " · GitWire_");
  return lines.join("\n");
}

function prMergedComment(data, repoUrl) {
  const dur = data.duration_ms ? " in " + Math.round(data.duration_ms / 1000) + "s" : "";
  const lines = ["## Auto-merged" + dur, "", "This PR was automatically merged by the GitWire merge queue."];
  if (data.merge_sha) lines.push("**Merge commit:** " + data.merge_sha.slice(0, 7));
  lines.push("", "---", "_GitWire Auto-Merge Queue_");
  return lines.join("\n");
}

function prBlockedComment(data, repoUrl) {
  const failedList = (data.failed_checks ?? []).map(c => "- " + c).join("\n");
  return ["## Auto-merge blocked", "",
    "Required checks failed:", "", failedList || "- " + (data.reason ?? "Unknown reason"),
    "", "Fix the failures and the PR will be re-evaluated automatically.",
    "", "---", "_GitWire Merge Queue_"].join("\n");
}

function configFailedComment(data, repoUrl) {
  const errorList = (data.errors ?? []).map(e => "- **[" + e.rule + "]** " + e.message).join("\n");
  return ["## Config validation failed", "",
    "**File:** " + data.file_path, "", errorList,
    "", "---", "_GitWire Config Validation_"].join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Slack + Teams payloads
// ════════════════════════════════════════════════════════════════════════════

function buildSlackPayload(eventType, data, repository, prNumber) {
  const repoLink = "<https://github.com/" + repository.full_name + "|" + repository.full_name + ">";
  const prLink   = prNumber ? "<https://github.com/" + repository.full_name + "/pull/" + prNumber + "|PR #" + prNumber + ">" : "";

  const ICONS  = { ci_failure: "x", ci_heal: "zap", pr_merged: "white_check_mark", pr_blocked: "double_vertical_bar", config_failed: "x" };
  const TITLES = { ci_failure: "CI failure", ci_heal: "Self-healing CI", pr_merged: "PR auto-merged", pr_blocked: "Auto-merge blocked", config_failed: "Config validation failed" };

  const fields = [];
  if (prLink)          fields.push({ type: "mrkdwn", text: "*PR:* " + prLink });
  if (data.branch)     fields.push({ type: "mrkdwn", text: "*Branch:* " + data.branch });
  if (data.root_cause) fields.push({ type: "mrkdwn", text: "*Root cause:* " + data.root_cause });
  if (data.run_url)    fields.push({ type: "mrkdwn", text: "<" + data.run_url + "|View CI log>" });

  return {
    text: ":" + (ICONS[eventType] ?? "information_source") + ": *" + (TITLES[eventType] ?? eventType) + "* — " + repoLink,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: ":" + (ICONS[eventType] ?? "information_source") + ": *" + (TITLES[eventType] ?? eventType) + "*\n" + repoLink } },
      ...(fields.length ? [{ type: "section", fields: fields.slice(0, 10) }] : []),
    ],
  };
}

function buildTeamsPayload(eventType, data, repository, prNumber) {
  const TITLES = { ci_failure: "CI failure", ci_heal: "Self-healing CI fix", pr_merged: "PR auto-merged", pr_blocked: "Auto-merge blocked", config_failed: "Config validation failed" };

  const facts = [];
  if (data.branch)     facts.push({ title: "Branch", value: data.branch });
  if (data.root_cause) facts.push({ title: "Root cause", value: data.root_cause });
  if (prNumber)        facts.push({ title: "PR", value: "#" + prNumber });

  const actions = [];
  if (data.run_url)     actions.push({ "@type": "OpenUri", name: "View CI log", targets: [{ os: "default", uri: data.run_url }] });
  if (data.heal_pr_url) actions.push({ "@type": "OpenUri", name: "Review fix PR", targets: [{ os: "default", uri: data.heal_pr_url }] });

  return {
    "@type": "MessageCard", "@context": "http://schema.org/extensions",
    themeColor: eventType === "pr_merged" ? "00d97e" : "ff4d6a",
    summary: (TITLES[eventType] ?? eventType) + " — " + repository.full_name,
    sections: [{ activityTitle: TITLES[eventType] ?? eventType, activitySubtitle: repository.full_name, facts }],
    potentialAction: actions,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════

async function loadRules(eventType, fullName) {
  const { rows } = await db.query(
    "SELECT * FROM feedback_rules WHERE event_type = $1 AND enabled = TRUE", [eventType]
  );
  return rows.filter(r => !r.repo_filter || matchGlob(r.repo_filter, fullName));
}

async function postWebhook(url, payload) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("Webhook returned " + res.status);
}

export function matchGlob(pattern, str) {
  const re = new RegExp("^" + pattern.replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$");
  return re.test(str);
}

function getChannels(rule) {
  const ch = [];
  if (rule.post_pr_comment) ch.push("pr_comment");
  if (rule.slack_webhook)   ch.push("slack");
  if (rule.teams_webhook)   ch.push("teams");
  return ch;
}
