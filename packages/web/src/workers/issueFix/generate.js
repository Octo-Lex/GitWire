// src/workers/issueFix/generate.js
// Stage 4: Score exact-snapshot files + AI Pass 2 to generate full-file fixes.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../config/index.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment, stripCodeFences, extractJSON, fetchFileContents } from "./helpers.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

/** Returns generated fix objects + their exact-head originals, or null. */
export async function generateFixes(ctx, analysis) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repo } = ctx;
  const { issue, tree, baseSha } = ctx._scope;

  // The model's analysis may hallucinate file paths. Generation may only read
  // paths proven to exist in the immutable tree captured by validateScope().
  const treeSet = new Set(Array.isArray(tree) ? tree : []);
  const relevantFiles = Array.isArray(analysis.relevant_files)
    ? analysis.relevant_files.filter((path) => typeof path === "string" && treeSet.has(path))
    : [];
  const droppedFiles = Array.isArray(analysis.relevant_files)
    ? analysis.relevant_files.filter((path) => typeof path !== "string" || !treeSet.has(path))
    : [];

  if (droppedFiles.length) {
    logger.warn({ repo, issueNumber, droppedFiles }, "Ignoring analysis file paths absent from reviewed repository snapshot");
  }

  const scoredFiles = scoreFiles(relevantFiles, issue);
  const topFiles = scoredFiles.slice(0, 5).map((file) => file.path);
  logger.info({ repo, issueNumber, topFiles, scored: scoredFiles.length, baseSha }, "File scoring complete");

  // Exact-head invariant: generation reads from the same immutable commit that
  // produced the file tree. It never silently follows a moving branch name.
  const fileContents = await fetchFileContents(octokit, owner, repoName, topFiles, baseSha);

  if (fileContents.length === 0) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "Could not fetch any exact-head target file contents");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - file fetch failed**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "AI did not identify any usable target files in the reviewed repository snapshot. No code mutation was attempted.\n\n" +
      "_Files attempted: " + topFiles.join(", ") + "_"
    );
    return null;
  }

  const fixes = await aiGenerateFullFile(issue, analysis, fileContents, repo);
  if (!fixes || !fixes.length) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "AI could not generate fixes");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - no fixes generated**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "AI analyzed the issue but couldn't produce a concrete fix.\n\n" +
      "_Complexity: " + analysis.complexity + " · A maintainer should review._"
    );
    return null;
  }

  return { fixes, fileContents };
}

function scoreFiles(files, issue) {
  if (!files || !files.length) return [];

  const titleWords = (issue.title || "").toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const bodyWords = (issue.body || "").toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const allKeywords = [...new Set([...titleWords, ...bodyWords])];

  return files.map((path) => {
    let score = 0;
    const fileName = path.split("/").pop() || "";
    const baseName = fileName.split(".")[0] || "";
    const pathLower = path.toLowerCase();

    for (const keyword of allKeywords) {
      if (baseName.includes(keyword)) score += 10;
      if (pathLower.includes(keyword)) score += 5;
    }

    const depth = (path.match(/\//g) || []).length;
    if (depth === 0) score += 3;
    if (depth === 1) score += 2;

    if (pathLower.endsWith(".py") || pathLower.endsWith(".js") || pathLower.endsWith(".ts")) score += 2;
    if (fileName === "__init__.py") score -= 5;

    return { path, score: Math.max(score, 0) };
  }).sort((a, b) => b.score - a.score);
}

async function aiGenerateFullFile(issue, analysis, fileContents, repoFullName) {
  const fence = "```";
  const filesSection = fileContents.map((file) =>
    "--- " + file.path + " ---\n" + fence + "\n" + file.content + "\n" + fence
  ).join("\n\n");

  const prompt =
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
    "- Return only paths shown above\n" +
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
    return fixes;
  } catch (err) {
    logger.error({ err }, "AI full-file fix generation failed");
    return null;
  }
}
