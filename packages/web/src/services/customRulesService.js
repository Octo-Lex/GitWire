// src/services/customRulesService.js
// Evaluates custom rules from .gitwire.yml against webhook event context
// and dispatches the resulting actions via GitHub API.
//
// Flow:
//   1. Build expression context from webhook payload
//   2. Load config + plugins for the repo
//   3. Call evaluateRules() from @gitwire/rules
//   4. Execute each matched rule's actions (add-label, add-comment, etc.)

import { evaluateRules } from "@gitwire/rules";
import { loadPlugins } from "@gitwire/rules/plugins";
import { getConfigForRepo, getPluginsForRepo } from "./configService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { recordAction } from "./managedActionService.js";
import { logDecision } from "./decisionLogService.js";
import { propose, approve, execute, succeed, fail } from "./actionStateMachine.js";
import { logger } from "../lib/logger.js";

/**
 * Build expression context from a webhook payload.
 * Maps GitHub event shapes to the flat context object used by evaluateRules().
 */
export function buildExpressionContext(eventName, payload) {
  const ctx = {
    author: "",
    branch: "",
    title: "",
    body: "",
    labels: [],
    files: [],
    changes: { added: 0, deleted: 0, modified: 0 },
    repo: "",
    is_new: false,
    is_draft: false,
  };

  const repo = payload.repository;
  if (repo) {
    ctx.repo = repo.full_name;
  }

  if (eventName === "issues") {
    const issue = payload.issue;
    if (issue) {
      ctx.author = issue.user?.login || "";
      ctx.title = issue.title || "";
      ctx.body = issue.body || "";
      ctx.labels = (issue.labels || []).map((l) => typeof l === "string" ? l : l.name);
      ctx.is_new = ["opened", "reopened"].includes(payload.action);
    }
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    if (pr) {
      ctx.author = pr.user?.login || "";
      ctx.branch = pr.head?.ref || "";
      ctx.title = pr.title || "";
      ctx.body = pr.body || "";
      ctx.labels = (pr.labels || []).map((l) => typeof l === "string" ? l : l.name);
      ctx.is_new = ["opened", "reopened", "ready_for_review"].includes(payload.action);
      ctx.is_draft = pr.draft === true;
      // PR size from additions/deletions
      ctx.changes = {
        added: pr.additions || 0,
        deleted: pr.deletions || 0,
        modified: pr.changed_files || 0,
      };
    }
  }

  if (eventName === "issue_comment") {
    const issue = payload.issue;
    if (issue) {
      ctx.author = issue.user?.login || "";
      ctx.title = issue.title || "";
      ctx.body = issue.body || "";
      ctx.labels = (issue.labels || []).map((l) => typeof l === "string" ? l : l.name);
      // If it's a PR comment, set branch info
      if (issue.pull_request) {
        ctx.branch = issue.pull_request?.ref || "";
      }
      // Add comment-specific data
      const comment = payload.comment;
      if (comment) {
        ctx.comment_author = comment.user?.login || "";
        ctx.comment_body = comment.body || "";
        ctx.is_command = comment.body?.trim().startsWith("/gitwire") || false;
      }
    }
  }

  return ctx;
}

/**
 * Fetch changed files for a PR and update the context.
 * Only needed for pull_request events where files aren't in the payload.
 */
async function enrichWithPRFiles(octokit, owner, repo, prNumber, ctx) {
  try {
    const { data: files } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: 100 }
    );
    ctx.files = files.map((f) => f.filename);
    // Also enrich changes if not already set from PR payload
    if (ctx.changes.added === 0 && ctx.changes.deleted === 0 && ctx.changes.modified === 0) {
      let added = 0, deleted = 0;
      for (const f of files) {
        added += f.additions || 0;
        deleted += f.deletions || 0;
      }
      ctx.changes = { added, deleted, modified: files.length };
    }
  } catch (_e) {
    // Non-critical — files context will be empty
  }
}

/**
 * Evaluate custom rules for a webhook event and execute matched actions.
 *
 * @param {string} eventName — GitHub event name (issues, pull_request, etc.)
 * @param {object} payload — webhook payload
 * @param {object} installation — installation object from payload
 * @returns {Promise<Array<{name: string, actions: Array, results: Array}>>}
 */
export async function evaluateAndExecuteCustomRules(eventName, payload, installation) {
  const repo = payload.repository;
  if (!repo) return [];

  const repoFullName = repo.full_name;
  const repoId = repo.id;

  // 1. Get config
  const config = await getConfigForRepo(repoFullName);

  // Check if there are any custom_rules defined
  if (!config.custom_rules || Object.keys(config.custom_rules).length === 0) {
    return [];
  }

  // 2. Build context
  const ctx = buildExpressionContext(eventName, payload);

  // 3. Get Octokit client
  const installationId = installation?.id;
  let octokit;
  try {
    octokit = wrapOctokit(await getInstallationClient(installationId));
  } catch (_e) {
    logger.warn({ repo: repoFullName }, "Cannot get installation client for custom rules");
    return [];
  }

  // 4. Enrich with PR files if applicable
  const prNumber = payload.pull_request?.number || (eventName === "issue_comment" && payload.issue?.pull_request ? payload.issue.number : null);
  if (prNumber) {
    await enrichWithPRFiles(octokit, repo.owner.login, repo.name, prNumber, ctx);
  }

  // 5. Load plugins
  let pluginFilters = {};
  try {
    const pluginSources = await getPluginsForRepo(repoFullName);
    if (Array.isArray(pluginSources) && pluginSources.length > 0) {
      pluginFilters = loadPlugins(pluginSources);
    }
  } catch (_e) {
    // Plugins are optional
  }

  // 6. Evaluate rules
  const matched = evaluateRules(ctx, config, pluginFilters);

  if (matched.length === 0) return [];

  logger.info(
    { repo: repoFullName, matchedRules: matched.map((m) => m.name), event: eventName },
    "Custom rules matched"
  );

  // 7. Execute actions for each matched rule
  const owner = repo.owner.login;
  const repoName = repo.name;
  const issueNumber = payload.issue?.number || payload.pull_request?.number;
  const results = [];

  for (const rule of matched) {
    const ruleResults = [];

    for (const action of rule.actions) {
      try {
        const result = await executeAction(octokit, owner, repoName, issueNumber, action, repoId, rule.name, repo.full_name);
        ruleResults.push({ action: action.action, success: true, result });
      } catch (err) {
        logger.warn(
          { err: err.message, action: action.action, rule: rule.name, repo: repoFullName },
          "Custom rule action failed"
        );
        ruleResults.push({ action: action.action, success: false, error: err.message });
      }
    }

    results.push({ name: rule.name, actions: rule.actions, results: ruleResults });

    // Log decision for audit trail
    await logDecision({
      repoId,
      source: "custom_rules",
      triggerEvent: eventName + "." + (payload.action || ""),
      targetType: payload.pull_request ? "pr" : "issue",
      targetNumber: issueNumber,
      pillar: "custom_rules",
      decision: "acted",
      reason: "Custom rule '" + rule.name + "' matched — executed " + rule.actions.length + " action(s)",
      conditions: [
        { check: "custom_rule(" + rule.name + ")", result: true },
        { check: "actions_count", result: rule.actions.length },
      ],
    });
  }

  return results;
}

/**
 * Execute a single custom rule action via GitHub API.
 */
async function executeAction(octokit, owner, repo, issueNumber, action, repoId, ruleName, repoFullName) {
  const args = action.args || {};

  // Propose the action
  const act = await propose({
    repoFullName: repoFullName || (owner + "/" + repo),
    pillar: "custom_rules",
    actionType: action.action,
    source: "custom_rule:" + ruleName,
    evidence: { ruleName, args, issueNumber },
    repoId,
    targetType: issueNumber ? "issue" : undefined,
    targetNumber: issueNumber,
  });
  await approve(act.id, { rule: ruleName });
  await execute(act.id);

  try {

  switch (action.action) {
    case "add-label": {
      if (!args.label) throw new Error("add-label requires 'label' arg");
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner, repo, issue_number: issueNumber,
        labels: [args.label],
      });
      await recordAction({
        repoId,
        source: "custom_rules",
        issueNumber,
        actionType: "label",
        actionKey: "label:" + args.label,
        actionValue: args.label,
        context: { ruleName },
      });
      await succeed(act.id, { label: args.label });
      return { label: args.label };
    }

    case "remove-label": {
      if (!args.label) throw new Error("remove-label requires 'label' arg");
      await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
        owner, repo, issue_number: issueNumber, name: args.label,
      });
      await succeed(act.id, { removed_label: args.label });
      return { label: args.label };
    }

    case "add-comment": {
      const comment = args.comment || args.body || "";
      if (!comment) throw new Error("add-comment requires 'comment' or 'body' arg");
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner, repo, issue_number: issueNumber, body: comment,
      });
      await recordAction({
        repoId,
        source: "custom_rules",
        issueNumber,
        actionType: "comment",
        actionKey: "comment:custom:" + ruleName,
        actionValue: comment.substring(0, 200),
        context: { ruleName },
      });
      await succeed(act.id, { comment: true });
      return { comment: comment.substring(0, 100) };
    }

    case "approve": {
      // Submit an approving review on the PR
      if (!issueNumber) throw new Error("approve requires an issue/PR number");
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner, repo, pull_number: issueNumber,
        event: "APPROVE",
        body: "Auto-approved by GitWire custom rule: **" + ruleName + "**",
      });
      await recordAction({
        repoId,
        source: "custom_rules",
        prNumber: issueNumber,
        actionType: "approval",
        actionKey: "approval:custom:" + ruleName,
        context: { ruleName },
      });
      await succeed(act.id, { approved: true });
      return { approved: true };
    }

    case "request-review": {
      const reviewArgs = {
        owner, repo,
        pull_number: issueNumber,
        reviewers: [],
        team_reviewers: [],
      };
      if (args.user) reviewArgs.reviewers = [args.user];
      if (args.team) reviewArgs.team_reviewers = [args.team];
      if (reviewArgs.reviewers.length === 0 && reviewArgs.team_reviewers.length === 0) {
        throw new Error("request-review requires 'user' or 'team' arg");
      }
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", reviewArgs);
      const target = args.user || args.team;
      await recordAction({
        repoId,
        source: "custom_rules",
        prNumber: issueNumber,
        actionType: "reviewer",
        actionKey: "reviewer:" + target,
        actionValue: target,
        context: { ruleName },
      });
      await succeed(act.id, { reviewer: target });
      return { reviewer: target };
    }

    case "set-priority": {
      // GitWire doesn't have a native priority field, but we can add a label
      if (!args.priority) throw new Error("set-priority requires 'priority' arg");
      const label = "priority:" + args.priority;
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner, repo, issue_number: issueNumber,
        labels: [label],
      });
      return { priority: args.priority, label };
    }

    case "skip":
      // No-op — signals the worker to stop processing
      return { skipped: true };

    default:
      logger.warn({ action: action.action }, "Unknown custom rule action");
      await succeed(act.id, { unknown: action.action });
      return { unknown: action.action };
  }
} catch (err) {
    await fail(act.id, err.message).catch(() => {});
    throw err;
  }
}
