// src/services/customRulesService.js
// Evaluates custom rules from .gitwire.yml against webhook event context
// and dispatches the resulting actions via GitHub API.
//
// Flow:
//   1. Build expression context from webhook payload
//   2. Load config + plugins for the repo
//   3. Call evaluateRules() from @gitwire/rules
//   4. Execute each matched rule's actions via the managed-action lifecycle

import { evaluateRules } from "@gitwire/rules";
import { loadPlugins } from "@gitwire/rules/plugins";
import { getConfigForRepo, getPluginsForRepo } from "./configService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { logDecision } from "./decisionLogService.js";
import {
  propose,
  approve,
  execute,
  succeed,
  fail,
  block,
  BLOCKED_REASONS,
} from "./actionStateMachine.js";
import { logger } from "../lib/logger.js";

const PR_FILES_PER_PAGE = 100;
const SUPPORTED_ACTIONS = new Set([
  "add-label",
  "remove-label",
  "add-comment",
  "approve",
  "request-review",
  "set-priority",
  "skip",
]);

class CustomRuleEvidenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "CustomRuleEvidenceError";
    this.detail = detail;
  }
}

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
  if (repo) ctx.repo = repo.full_name;

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

function deriveTarget(eventName, payload) {
  const prBacked = Boolean(
    payload.pull_request ||
    (eventName === "issue_comment" && payload.issue?.pull_request)
  );
  return {
    type: prBacked ? "pr" : "issue",
    number: payload.pull_request?.number || payload.issue?.number || null,
    prBacked,
  };
}

function validateAction(action, target) {
  const name = action?.action;
  const args = action?.args || {};

  if (!SUPPORTED_ACTIONS.has(name)) {
    return `Unknown custom rule action: ${name || "<missing>"}`;
  }

  switch (name) {
    case "add-label":
      return args.label ? null : "add-label requires 'label' arg";
    case "remove-label":
      return args.label ? null : "remove-label requires 'label' arg";
    case "add-comment":
      return (args.comment || args.body) ? null : "add-comment requires 'comment' or 'body' arg";
    case "approve":
      if (target.type !== "pr" || !target.number) return "approve requires a PR target";
      if (!target.headSha) return "approve requires a reviewed PR head SHA";
      return null;
    case "request-review":
      if (target.type !== "pr" || !target.number) return "request-review requires a PR target";
      return (args.user || args.team) ? null : "request-review requires 'user' or 'team' arg";
    case "set-priority":
      return args.priority ? null : "set-priority requires 'priority' arg";
    case "skip":
      return null;
    default:
      return `Unknown custom rule action: ${name || "<missing>"}`;
  }
}

async function fetchFreshPRContext(octokit, owner, repo, prNumber, webhookHeadSha = null) {
  const { data: pr } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: prNumber }
  );

  const currentHeadSha = pr?.head?.sha || null;
  if (!currentHeadSha) {
    throw new CustomRuleEvidenceError("Fresh PR metadata did not include a head SHA", { prNumber });
  }

  if (webhookHeadSha && currentHeadSha !== webhookHeadSha) {
    return { stale: true, pr, headSha: currentHeadSha, files: [], expectedFiles: pr.changed_files };
  }

  const expectedFiles = Number(pr.changed_files);
  if (!Number.isInteger(expectedFiles) || expectedFiles < 0) {
    throw new CustomRuleEvidenceError("Fresh PR metadata did not include a valid changed_files count", {
      prNumber,
      changedFiles: pr.changed_files,
    });
  }

  const files = [];
  let page = 1;
  while (true) {
    const { data: pageFiles } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: PR_FILES_PER_PAGE, page }
    );

    if (!Array.isArray(pageFiles)) {
      throw new CustomRuleEvidenceError("PR changed-files response was not an array", { prNumber, page });
    }

    files.push(...pageFiles);
    if (pageFiles.length < PR_FILES_PER_PAGE) break;
    page += 1;
  }

  if (files.length !== expectedFiles) {
    throw new CustomRuleEvidenceError(
      `Incomplete PR file evidence: expected ${expectedFiles}, retrieved ${files.length}`,
      { prNumber, expectedFiles, retrievedFiles: files.length }
    );
  }

  return { stale: false, pr, headSha: currentHeadSha, files, expectedFiles };
}

function applyFreshPRContext(ctx, fresh) {
  const pr = fresh.pr;
  ctx.author = pr.user?.login || ctx.author;
  ctx.branch = pr.head?.ref || ctx.branch;
  ctx.title = pr.title || "";
  ctx.body = pr.body || "";
  ctx.labels = (pr.labels || []).map((l) => typeof l === "string" ? l : l.name);
  ctx.is_draft = pr.draft === true;
  ctx.files = fresh.files.map((f) => f.filename);
  ctx.changes = {
    added: pr.additions || 0,
    deleted: pr.deletions || 0,
    modified: fresh.expectedFiles,
  };
}

async function logRuleDecision({
  repoId,
  eventName,
  payload,
  target,
  principalId,
  decision,
  reason,
  conditions,
  commitSha = null,
}) {
  await logDecision({
    repoId,
    source: "custom_rules",
    triggerEvent: eventName + "." + (payload.action || ""),
    targetType: target.type,
    targetNumber: target.number,
    pillar: "custom_rules",
    decision,
    reason,
    conditions,
    commitSha,
    principalId,
    surfaceId: "custom_rules:evaluate",
  });
}

async function recordFailure(actionId, err, context) {
  try {
    await fail(actionId, err.message);
  } catch (stateErr) {
    logger.error(
      {
        err: stateErr.message,
        originalError: err.message,
        actionId,
        action: context.action,
        rule: context.ruleName,
        repo: context.repoFullName,
      },
      "Failed to record Custom Rules action failure"
    );
  }
}

async function recordBlocked(actionId, reason, detail, context) {
  try {
    await block(actionId, reason, detail);
  } catch (stateErr) {
    logger.error(
      {
        err: stateErr.message,
        actionId,
        action: context.action,
        rule: context.ruleName,
        repo: context.repoFullName,
      },
      "Failed to record blocked Custom Rules action"
    );
    throw stateErr;
  }
}

export async function evaluateAndExecuteCustomRules(eventName, payload, installation, principalId = null) {
  const repo = payload.repository;
  if (!repo) return [];

  const repoFullName = repo.full_name;
  const repoId = repo.id;
  const target = deriveTarget(eventName, payload);

  const config = await getConfigForRepo(repoFullName);
  if (!config.custom_rules || Object.keys(config.custom_rules).length === 0) return [];

  const ctx = buildExpressionContext(eventName, payload);

  const installationId = installation?.id;
  let octokit;
  let freshOctokit;
  try {
    const rawClient = await getInstallationClient(installationId);
    octokit = wrapOctokit(rawClient);
    freshOctokit = wrapOctokit(rawClient, { skipCache: true });
  } catch (_e) {
    logger.warn({ repo: repoFullName }, "Cannot get installation client for custom rules");
    return [];
  }

  if (target.prBacked) {
    const webhookHeadSha = eventName === "pull_request" ? payload.pull_request?.head?.sha || null : null;
    let fresh;
    try {
      fresh = await fetchFreshPRContext(
        freshOctokit,
        repo.owner.login,
        repo.name,
        target.number,
        webhookHeadSha
      );
    } catch (err) {
      logger.warn(
        { err: err.message, repo: repoFullName, pr: target.number, detail: err.detail },
        "Custom Rules PR evidence unavailable — failing closed"
      );
      await logRuleDecision({
        repoId,
        eventName,
        payload,
        target,
        principalId,
        decision: "blocked",
        reason: "PR evidence incomplete or unavailable; Custom Rules mutation suppressed",
        conditions: [
          { check: "pr_evidence_complete", result: false },
          { check: "error", result: err.message },
        ],
        commitSha: webhookHeadSha,
      });
      return [];
    }

    target.headSha = fresh.headSha;
    if (fresh.stale) {
      logger.warn(
        { repo: repoFullName, pr: target.number, webhookHead: webhookHeadSha, currentHead: fresh.headSha },
        "Custom Rules stale PR webhook rejected"
      );
      await logRuleDecision({
        repoId,
        eventName,
        payload,
        target,
        principalId,
        decision: "blocked",
        reason: "Webhook PR head is stale; Custom Rules mutation suppressed",
        conditions: [
          { check: "pr_head_matches_webhook", result: false },
          { check: "webhook_head", result: webhookHeadSha },
          { check: "current_head", result: fresh.headSha },
        ],
        commitSha: webhookHeadSha,
      });
      return [];
    }

    applyFreshPRContext(ctx, fresh);
  }

  let pluginFilters = {};
  try {
    const pluginSources = await getPluginsForRepo(repoFullName);
    if (Array.isArray(pluginSources) && pluginSources.length > 0) {
      pluginFilters = loadPlugins(pluginSources);
    }
  } catch (_e) {
    // Plugins are optional and remain outside the D0-03 isolation boundary.
  }

  const matched = evaluateRules(ctx, config, pluginFilters);
  if (matched.length === 0) return [];

  logger.info(
    { repo: repoFullName, matchedRules: matched.map((m) => m.name), event: eventName },
    "Custom rules matched"
  );

  const owner = repo.owner.login;
  const repoName = repo.name;
  const results = [];
  const dryRun = config.settings?.dry_run === true;
  let stopProcessing = false;

  for (const rule of matched) {
    const ruleResults = [];

    for (const action of rule.actions) {
      try {
        const result = await executeAction({
          octokit,
          owner,
          repo: repoName,
          target,
          action,
          repoId,
          ruleName: rule.name,
          repoFullName,
          principalId,
          dryRun,
        });

        ruleResults.push({
          action: action.action,
          success: ["succeeded", "skipped", "dry_run"].includes(result.outcome),
          outcome: result.outcome,
          result: result.result,
        });

        if (result.stopProcessing) {
          stopProcessing = true;
          break;
        }
      } catch (err) {
        logger.warn(
          { err: err.message, action: action.action, rule: rule.name, repo: repoFullName },
          "Custom rule action failed"
        );
        ruleResults.push({ action: action.action, success: false, outcome: "failed", error: err.message });
      }
    }

    results.push({ name: rule.name, actions: rule.actions, results: ruleResults });

    const mutationSucceeded = ruleResults.some((r) => r.outcome === "succeeded");
    const skipped = ruleResults.some((r) => r.outcome === "skipped");
    const blockedOnly = ruleResults.length > 0 && ruleResults.every((r) => r.outcome === "blocked");
    const failed = ruleResults.some((r) => r.outcome === "failed");
    const decision = dryRun
      ? "dry_run"
      : mutationSucceeded
        ? "acted"
        : skipped
          ? "skipped"
          : blockedOnly
            ? "blocked"
            : failed
              ? "error"
              : "skipped";

    await logRuleDecision({
      repoId,
      eventName,
      payload,
      target,
      principalId,
      decision,
      reason: dryRun
        ? `Custom rule '${rule.name}' matched — GitHub mutations suppressed by dry-run`
        : stopProcessing
          ? `Custom rule '${rule.name}' matched — skip stopped remaining Custom Rules processing`
          : `Custom rule '${rule.name}' matched — processed ${ruleResults.length} action(s)`,
      conditions: [
        { check: "custom_rule(" + rule.name + ")", result: true },
        { check: "actions_processed", result: ruleResults.length },
        { check: "dry_run", result: dryRun },
      ],
      commitSha: target.headSha || null,
    });

    if (stopProcessing) break;
  }

  return results;
}

async function executeAction({
  octokit,
  owner,
  repo,
  target,
  action,
  repoId,
  ruleName,
  repoFullName,
  principalId,
  dryRun,
}) {
  const args = action.args || {};
  const context = { action: action.action, ruleName, repoFullName };

  const evidence = {
    ruleName,
    args,
    targetNumber: target.number,
    principalId,
    surfaceId: "custom_rules:evaluate",
  };
  if (target.headSha) {
    evidence.target_snapshot = { head_sha: target.headSha };
    evidence.reviewed_head_sha = target.headSha;
  }

  const act = await propose({
    repoFullName: repoFullName || (owner + "/" + repo),
    pillar: "custom_rules",
    actionType: action.action || "unknown",
    source: "custom_rule:" + ruleName,
    evidence,
    repoId,
    targetType: target.type,
    targetNumber: target.number,
  });

  const validationError = validateAction(action, target);
  if (validationError) {
    await recordBlocked(
      act.id,
      BLOCKED_REASONS.POLICY_DENIED,
      { validation_error: validationError, deterministic: true },
      context
    );
    return { outcome: "blocked", result: { blocked: true, reason: validationError } };
  }

  if (dryRun && action.action !== "skip") {
    await recordBlocked(
      act.id,
      BLOCKED_REASONS.POLICY_DENIED,
      { dry_run: true, mutation_suppressed: true },
      context
    );
    return { outcome: "dry_run", result: { dry_run: true } };
  }

  await approve(act.id, { rule: ruleName, reviewed_head_sha: target.headSha || null });
  await execute(act.id);

  try {
    switch (action.action) {
      case "add-label":
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner, repo, issue_number: target.number, labels: [args.label],
        });
        await succeed(act.id, { label: args.label });
        return { outcome: "succeeded", result: { label: args.label } };

      case "remove-label":
        await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
          owner, repo, issue_number: target.number, name: args.label,
        });
        await succeed(act.id, { removed_label: args.label });
        return { outcome: "succeeded", result: { label: args.label } };

      case "add-comment": {
        const comment = args.comment || args.body;
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner, repo, issue_number: target.number, body: comment,
        });
        await succeed(act.id, { comment: true });
        return { outcome: "succeeded", result: { comment: comment.substring(0, 100) } };
      }

      case "approve":
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
          owner,
          repo,
          pull_number: target.number,
          commit_id: target.headSha,
          event: "APPROVE",
          body: "Auto-approved by GitWire custom rule: **" + ruleName + "**",
        });
        await succeed(act.id, { approved: true, commit_id: target.headSha });
        return { outcome: "succeeded", result: { approved: true, commit_id: target.headSha } };

      case "request-review": {
        const reviewArgs = {
          owner,
          repo,
          pull_number: target.number,
          reviewers: [],
          team_reviewers: [],
        };
        if (args.user) reviewArgs.reviewers = [args.user];
        if (args.team) reviewArgs.team_reviewers = [args.team];
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", reviewArgs);
        const reviewerTarget = args.user || args.team;
        await succeed(act.id, { reviewer: reviewerTarget });
        return { outcome: "succeeded", result: { reviewer: reviewerTarget } };
      }

      case "set-priority": {
        const label = "priority:" + args.priority;
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner, repo, issue_number: target.number, labels: [label],
        });
        await succeed(act.id, { priority: args.priority, label });
        return { outcome: "succeeded", result: { priority: args.priority, label } };
      }

      case "skip":
        await succeed(act.id, { skipped: true });
        return { outcome: "skipped", result: { skipped: true }, stopProcessing: true };

      default:
        await recordBlocked(
          act.id,
          BLOCKED_REASONS.POLICY_DENIED,
          { validation_error: `Unknown custom rule action: ${action.action}`, deterministic: true },
          context
        );
        return { outcome: "blocked", result: { blocked: true } };
    }
  } catch (err) {
    await recordFailure(act.id, err, context);
    throw err;
  }
}
