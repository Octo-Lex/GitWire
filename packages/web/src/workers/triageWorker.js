// src/workers/triageWorker.js
// Processes issues and PRs from the triage queue.
// Uses Claude to classify, suggest labels, and recommend assignees.

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { issueService } from "../services/issueService.js";
import { detectDuplicates } from "../services/duplicateDetectionService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, isDryRun } from "@gitwire/rules";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { recordAction } from "../services/managedActionService.js";
import { logDecision } from "../services/decisionLogService.js";

const anthropic = new Anthropic({ 
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

export function startTriageWorker() {
  return createWorker(QUEUES.TRIAGE, async (job) => {
    switch (job.name) {
      case "triage-issue":
        await triageIssue(job.data);
        break;
      case "triage-pr":
        await triagePR(job.data);
        break;
    }
  });
}

// ── Issue triage ─────────────────────────────────────────────────────────────
async function triageIssue({ payload }) {
  const { issue, repository, installation } = payload;
  if (!issue || !installation) return;

  logger.info({ repo: repository?.full_name, issue: issue.number }, "Triaging issue");

  // ── Check .gitwire.yml pillar config ────────────────────────────────────
  const repoConfig = await getConfigForRepo(repository.full_name);
  if (!isPillarEnabled("triage", repoConfig)) {
    logger.info({ repo: repository.full_name, issue: issue.number }, "Triage disabled for repo — skipping");
    await logDecision({
      repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
      targetType: "issue", targetNumber: issue.number, pillar: "triage",
      decision: "skipped", reason: "Pillar triage disabled in config",
      conditions: [{ check: "pillar_enabled(triage)", result: false }],
    });
    return;
  }

  let octokit;
  try {
    octokit = await getInstallationClient(installation.id);
  } catch (err) {
    logger.error({ err, installationId: installation.id }, "Failed to get installation client");
    return;
  }

  if (!octokit?.request) {
    logger.error({ installationId: installation.id }, "Invalid Octokit client — check GitHub App credentials");
    return;
  }

  // Fetch existing labels for this repo so Claude can choose from them
  const { data: repoLabels } = await octokit.request('GET /repos/{owner}/{repo}/labels', {
    owner: repository.owner.login,
    repo:  repository.name,
    per_page: 100,
  });

  const labelNames = repoLabels.map((l) => l.name);

  // ── Ask Claude to classify the issue ──────────────────────────────────────
  const prompt = buildIssueTriagePrompt(issue, labelNames);
  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages:   [{ role: "user", content: prompt }],
    system:
      "You are a GitHub triage assistant. Respond only with valid JSON matching the schema in the user prompt. No explanation, no markdown.",
  });

  let classification;
  try {
    let raw = message.content[0].text.trim();
    // Strip markdown code fences if Claude wrapped the JSON
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    classification = JSON.parse(raw);
  } catch (err) {
    logger.error({ err, raw: message.content[0].text }, "Failed to parse Claude triage response");
    return;
  }

  logger.info({ issue: issue.number, classification }, "Issue classified");

  // ── Apply labels ──────────────────────────────────────────────────────────
  const triageOpts = repoConfig.pillars?.triage || {};
  const labelsToApply = classification.labels.filter((l) =>
    labelNames.includes(l)
  );

  if (labelsToApply.length > 0 && triageOpts.auto_label !== false) {
    if (isDryRun(repoConfig)) {
      logger.info({ issue: issue.number, labels: labelsToApply }, "DRY RUN: would apply labels");
    } else {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner:  repository.owner.login,
        repo:   repository.name,
        issue_number: issue.number,
        labels: labelsToApply,
      });
      // Managed action: record each label
      for (const lbl of labelsToApply) {
        await recordAction({ repoId: repository.id, source: "triage", issueNumber: issue.number, actionType: "label", actionKey: "label:" + lbl, actionValue: lbl, context: { issueId: issue.id, title: issue.title } });
      }
    }
  }

  // ── Persist triage result to database ────────────────────────────────────
  await issueService.saveTriage(issue.id, {
    type:     classification.type,
    priority: classification.priority,
    summary:  classification.triage_summary,
  });

  logger.info({ issue: issue.number, type: classification.type, priority: classification.priority }, "Issue triage persisted");

  // ── Log decision ──────────────────────────────────────────────────────────
  await logDecision({
    repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
    targetType: "issue", targetNumber: issue.number, pillar: "triage",
    decision: labelsToApply.length > 0 ? (isDryRun(repoConfig) ? "dry_run" : "acted") : "skipped",
    reason: labelsToApply.length > 0
      ? "Classified as " + classification.type + " (" + classification.priority + "), applied labels: " + labelsToApply.join(", ")
      : "Classified as " + classification.type + " (" + classification.priority + "), no labels to apply",
    conditions: [
      { check: "pillar_enabled(triage)", result: true },
      { check: "auto_label", result: triageOpts.auto_label !== false },
      { check: "is_dry_run()", result: isDryRun(repoConfig) },
      { check: "labels_match_repo(" + labelsToApply.length + ")", result: labelsToApply.length > 0 },
    ],
    configUsed: { auto_label: triageOpts.auto_label !== false },
  });

  // ── Post triage comment if needed ─────────────────────────────────────────
  if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {
    if (isDryRun(repoConfig)) {
      logger.info({ issue: issue.number }, "DRY RUN: would post triage comment");
    } else {
      const { data: comment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner:        repository.owner.login,
        repo:         repository.name,
        issue_number: issue.number,
        body:         buildTriageComment(classification),
      });
      // Managed action: record comment
      await recordAction({ repoId: repository.id, source: "triage", issueNumber: issue.number, actionType: "comment", actionKey: "comment:triage:summary", actionValue: classification.triage_summary, githubId: comment.id, context: { issueId: issue.id, title: issue.title } });
    }
  }

  // ── Run duplicate detection (best-effort) ────────────────────────────────
  // Runs after classification so the embedding is stored alongside triage data.
  // detectDuplicates handles its own GitHub comment — separate from triage comment.
  // Controlled by pillars.triage.duplicate_detection in .gitwire.yml.
  if (triageOpts.duplicate_detection === false) {
    logger.debug({ issue: issue.number }, "Duplicate detection disabled for repo — skipping");
  } else {
    try {
      const { duplicates, related } = await detectDuplicates({
        issue,
        repository,
        octokit,
      });

      if (duplicates.length) {
        logger.info(
          { issue: issue.number, topMatch: duplicates[0].number, similarity: duplicates[0].similarity.toFixed(3) },
          "Duplicate detected"
        );
      } else if (related.length) {
        logger.info(
          { issue: issue.number, relatedCount: related.length },
          "Related issues found"
        );
      }
    } catch (err) {
      // Duplicate detection is best-effort — never fail the triage job over it
      logger.warn({ err: err.message, issue: issue.number }, "Duplicate detection failed (non-fatal)");
    }
  }
}

// ── PR triage ────────────────────────────────────────────────────────────────
async function triagePR({ payload }) {
  const { pull_request: pr, repository, installation } = payload;
  if (!pr || !installation) return;

  logger.info({ repo: repository.full_name, pr: pr.number }, "Triaging PR");

  // ── Check .gitwire.yml pillar config ────────────────────────────────────
  const repoConfig = await getConfigForRepo(repository.full_name);
  if (!isPillarEnabled("triage", repoConfig)) {
    logger.info({ repo: repository.full_name, pr: pr.number }, "Triage disabled for repo — skipping PR");
    return;
  }

  const octokit = await getInstallationClient(installation.id);

  const message = await anthropic.messages.create({
    model:      "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages:   [{ role: "user", content: buildPRTriagePrompt(pr) }],
    system:
      "You are a GitHub triage assistant. Respond only with valid JSON matching the schema in the user prompt. No explanation, no markdown.",
  });

  let classification;
  try {
    classification = JSON.parse(message.content[0].text);
  } catch (err) {
    logger.error({ err }, "Failed to parse Claude PR triage response");
    return;
  }

  // Apply size label
  if (classification.size_label) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner:        repository.owner.login,
      repo:         repository.name,
      issue_number: pr.number,
      labels:       [classification.size_label],
    });
    // Managed action: record size label
    await recordAction({ repoId: repository.id, source: "triage", prNumber: pr.number, actionType: "label", actionKey: "label:" + classification.size_label, actionValue: classification.size_label, context: { prId: pr.id, additions: pr.additions, deletions: pr.deletions } });
  }

  logger.info({ pr: pr.number, classification }, "PR classified");
}

// ── Prompt builders ──────────────────────────────────────────────────────────
function buildIssueTriagePrompt(issue, availableLabels) {
  return `Classify this GitHub issue and return JSON:

Title: ${issue.title}
Body: ${(issue.body || "").slice(0, 1500)}

Available labels: ${availableLabels.join(", ")}

Return this exact JSON schema:
{
  "type": "bug" | "feature" | "question" | "documentation" | "other",
  "priority": "critical" | "high" | "medium" | "low",
  "labels": [<pick 1-3 from available labels that fit best>],
  "needs_more_info": true | false,
  "duplicate_hint": "<null or brief reason if looks like a duplicate>",
  "triage_summary": "<one sentence summary for maintainers>"
}`;
}

function buildPRTriagePrompt(pr) {
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;
  const total = additions + deletions;
  const sizeLabel =
    total < 10   ? "size/XS" :
    total < 50   ? "size/S"  :
    total < 200  ? "size/M"  :
    total < 500  ? "size/L"  : "size/XL";

  return `Classify this GitHub pull request and return JSON:

Title: ${pr.title}
Body: ${(pr.body || "").slice(0, 1000)}
Changed lines: +${additions} -${deletions}

Return this exact JSON schema:
{
  "type": "feature" | "bugfix" | "refactor" | "chore" | "docs" | "test",
  "size_label": "${sizeLabel}",
  "risk": "low" | "medium" | "high",
  "triage_summary": "<one sentence for reviewers>"
}`;
}

function buildTriageComment(classification) {
  const lines = ["👋 **Automated triage**", ""];

  if (classification.triage_summary) {
    lines.push(`_${classification.triage_summary}_`, "");
  }
  if (classification.needs_more_info) {
    lines.push(
      "⚠️ This issue may need more information to reproduce or act on. Could you provide:",
      "- Steps to reproduce",
      "- Expected vs actual behaviour",
      "- Environment details (OS, version, etc.)",
      ""
    );
  }
  if (classification.duplicate_hint) {
    lines.push(`🔍 **Possible duplicate:** ${classification.duplicate_hint}`, "");
  }

  lines.push("_Labels applied automatically. A maintainer will review shortly._");
  return lines.join("\n");
}
