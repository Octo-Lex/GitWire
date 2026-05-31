// src/workers/issueFix/generate.js
// Stage 4: Score relevant files + AI Pass 2 to generate full-file fixes.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../config/index.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment, stripCodeFences, extractJSON, fetchFileContents } from "./helpers.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

/**
 * Returns array of fix objects, or null if pipeline should stop.
 * CC target: ~6
 */
export async function generateFixes(ctx, analysis) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo } = ctx;
  const { issue, tree } = ctx._scope;

  // Score and select top files
  const scoredFiles = scoreFiles(analysis.relevant_files || [], issue, tree);
  const topFiles = scoredFiles.slice(0, 5).map((f) => f.path);
  logger.info({ repo, issueNumber, topFiles, scored: scoredFiles.length }, "File scoring complete");

  // Fetch file contents
  const fileContents = await fetchFileContents(octokit, owner, repoName, topFiles);

  if (fileContents.length === 0) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "Could not fetch any target file contents");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u26A0\uFE0F **GitWire Fix - file fetch failed**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "AI identified relevant files but none could be fetched.\n\n" +
      "_Files attempted: " + topFiles.join(", ") + "_"
    );
    return null;
  }

  // AI Pass 2: Generate full-file fixes
  const fixes = await aiGenerateFullFile(issue, analysis, fileContents, repo);
  if (!fixes || !fixes.length) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "AI could not generate fixes");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u26A0\uFE0F **GitWire Fix - no fixes generated**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "AI analyzed the issue but couldn't produce a concrete fix.\n\n" +
      "_Complexity: " + analysis.complexity + " \u00B7 A maintainer should review._"
    );
    return null;
  }

  return { fixes, fileContents };
}

// ── File scoring ───────────────────────────────────────────────────────────

function scoreFiles(files, issue, tree) {
  if (!files || !files.length) return [];

  const titleWords = (issue.title || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const bodyWords = (issue.body || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const allKeywords = [...new Set([...titleWords, ...bodyWords])];

  return files.map((path) => {
    let score = 0;
    const fileName = path.split("/").pop() || "";
    const baseName = fileName.split(".")[0] || "";
    const pathLower = path.toLowerCase();

    for (const kw of allKeywords) {
      if (baseName.includes(kw)) score += 10;
      if (pathLower.includes(kw)) score += 5;
    }

    const depth = (path.match(/\//g) || []).length;
    if (depth === 0) score += 3;
    if (depth === 1) score += 2;

    if (pathLower.endsWith(".py") || pathLower.endsWith(".js") || pathLower.endsWith(".ts")) score += 2;

    if (pathLower.includes("test") && !pathLower.includes("test")) score -= 3;

    if (fileName === "__init__.py") score -= 5;

    return { path, score: Math.max(score, 0) };
  }).sort((a, b) => b.score - a.score);
}

// ── AI Pass 2 ─────────────────────────────────────────────────────────────

async function aiGenerateFullFile(issue, analysis, fileContents, repoFullName) {
  var fence = "```";
  var filesSection = fileContents.map((f) =>
    "--- " + f.path + " ---\n" + fence + "\n" + f.content + "\n" + fence
  ).join("\n\n");

  var prompt =
    "You are fixing a GitHub issue. Return the COMPLETE corrected files.\n\n" +
    "Repository: " + repoFullName + "\n" +
    "Issue #" + issue.number + ": " + issue.title + "\n\n" +
    "Issue body:\n" + (issue.body || "(no body)") + "\n\n" +
    "Fix strategy: " + (analysis.fix_strategy || "") + "\n\n" +
    "Files to fix:\n" + filesSection + "\n\n" +
    "Return ONLY a JSON array of fixed files:\n" +
    '[{"path": "relative/file/path",\n' +
    '  "fixed_content": "the complete fixed file content as a string",\n' +
    '  "commit_message": "fix(scope): brief description",\n' +
    '  "explanation": "one-line summary of what changed"}]\n\n' +
    "Rules:\n" +
    "- Return the COMPLETE file content, not a diff or patch\n" +
    "- Make only the minimal change needed to fix the issue\n" +
    "- Preserve all existing code that doesn't need to change\n" +
    "- If a file doesn't need changes, don't include it\n" +
    "- If no files need fixing, return empty array []";

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
      system: "You are an expert software engineer. Return ONLY valid JSON. Return complete file contents, not diffs.",
    });

    const raw = message.content[0].text;
    const cleaned = stripCodeFences(raw);
    const fixes = extractJSON(cleaned);
    if (!Array.isArray(fixes)) return null;
    return fixes.filter((f) => f.path && f.fixed_content);
  } catch (err) {
    logger.error({ err }, "AI full-file fix generation failed");
    return null;
  }
}
