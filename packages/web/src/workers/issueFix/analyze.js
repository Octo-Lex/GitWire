// src/workers/issueFix/analyze.js
// Stage 3: AI Pass 1 — analyze the issue and determine complexity + relevant files.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../../config/index.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment, stripCodeFences, extractJSON } from "./helpers.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

/**
 * Returns the analysis result, or null if pipeline should stop.
 * CC target: ~5
 */
export async function analyzeIssue(ctx, scope) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo } = ctx;
  const { issue, tree } = scope;

  const analysis = await aiAnalyze(issue, tree, repo);
  if (!analysis) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", null, null,
      "AI analysis returned no result");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u26A0\uFE0F **GitWire Fix - analysis failed**\n\n" +
      "Could not analyze this issue. It may be too complex or unclear.\n\n" +
      "_A maintainer should review manually._"
    );
    return null;
  }

  logger.info({ repo, issueNumber, complexity: analysis.complexity, files: analysis.relevant_files }, "Analysis complete");

  // Reject if complexity is too high
  if (analysis.complexity === "complex") {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Complexity too high for autonomous fix");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u26A0\uFE0F **GitWire Fix - too complex**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "This issue requires human judgment. A maintainer should tackle this.\n\n" +
      "_Complexity: " + analysis.complexity + " \u00B7 Relevant files: " + (analysis.relevant_files || []).join(", ") + "_"
    );
    return null;
  }

  await upsertFixAttempt(repoId, issueNumber, branchName, "generating", analysis.complexity, analysis.explanation);

  return analysis;
}

async function aiAnalyze(issue, tree, repoFullName) {
  var fence = "```";
  var prompt =
    "You are analyzing a GitHub issue to determine if it can be auto-fixed.\n\n" +
    "Repository: " + repoFullName + "\n" +
    "Issue #" + issue.number + ": " + issue.title + "\n\n" +
    "Issue body:\n" + (issue.body || "(no body)") + "\n\n" +
    "Repository file tree:\n" + fence + "\n" + tree.join("\n") + "\n" + fence + "\n\n" +
    "Return ONLY a JSON object:\n" +
    '{"complexity": "trivial" | "simple" | "moderate" | "complex",\n' +
    ' "relevant_files": ["path/to/file1.ext", "path/to/file2.ext"],\n' +
    ' "explanation": "one-line assessment of the issue and fix strategy",\n' +
    ' "fix_strategy": "brief description of the planned approach"}\n\n' +
    "Rules:\n" +
    "- complexity 'complex' = needs human judgment, multi-system changes, or unclear requirements\n" +
    "- complexity 'trivial' = typo fix, config change, single-line change\n" +
    "- complexity 'simple' = single file, clear fix\n" +
    "- complexity 'moderate' = 2-3 files, clear approach\n" +
    "- List at most 10 relevant_files\n" +
    "- Be conservative - when in doubt, set higher complexity";

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      system: "You are an expert software architect. Return ONLY valid JSON - no markdown, no explanation, no text before or after the JSON. Analyze issues precisely.",
    });

    const raw = message.content[0].text;
    const cleaned = stripCodeFences(raw);
    return extractJSON(cleaned);
  } catch (err) {
    logger.error({ err }, "AI analysis failed");
    return null;
  }
}
