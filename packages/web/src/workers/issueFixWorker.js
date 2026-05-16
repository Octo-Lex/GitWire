// src/workers/issueFixWorker.js
// Autonomous Contributor - picks up an issue, analyzes the codebase,
// generates a fix, and submits a PR.
//
// Pipeline:
//   1. Scope guard  - check qualifying labels
//   2. Rate limit    - per-repo daily + per-issue uniqueness
//   3. Analyze (AI)  - pick relevant files + assess complexity
//   4. Generate (AI) - produce file patches
//   5. Submit        - branch → commits → PR → comment on issue

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { maintainerService } from "../services/maintainerService.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/db.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

// No backticks in regex - use char code
const BT = String.fromCharCode(96);
const FENCE_RE = new RegExp("^" + BT + BT + BT + "(?:json)?\\s*\\n?", "i");
const FENCE_END_RE = new RegExp("\\n?" + BT + BT + BT + "\\s*$", "i");

function stripCodeFences(raw) {
  return raw.replace(FENCE_RE, "").replace(FENCE_END_RE, "").trim();
}

// Default scope labels (overridable per repo via maintainer settings)
const DEFAULT_ALLOWED_LABELS = [
  "bug", "good first issue", "help wanted",
  "enhancement", "documentation",
];

// ── Worker entry ───────────────────────────────────────────────────────────

export function startIssueFixWorker() {
  return createWorker(QUEUES.ISSUE_FIX, async (job) => {
    if (job.name === "fix-issue") {
      await processFixIssue(job.data);
    }
  }, { concurrency: 1 }); // one fix at a time to respect rate limits
}

// ── Main pipeline ──────────────────────────────────────────────────────────

async function processFixIssue({ repo, issueNumber, installationId, triggeredBy }) {
  const owner = repo.split("/")[0];
  const repoName = repo.split("/")[1];

  logger.info({ repo, issueNumber, triggeredBy }, "Issue fix pipeline started");

  // Resolve repo in DB
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1", [repo]
  );
  if (!repoRows.length) {
    logger.error({ repo }, "Repo not found in DB");
    return;
  }
  const repoId = repoRows[0].github_id;

  const octokit = await getInstallationClient(installationId);
  const branchName = "gitwire/fix-" + issueNumber;

  // ── Step 1: Rate limit check ──────────────────────────────────────────────
  const rateLimit = await checkRateLimit(repoId, issueNumber, repo);
  if (!rateLimit.allowed) {
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - rate limited**\n\n" + rateLimit.reason +
      "\n\n_Adjust settings or wait for the limit to reset._"
    );
    return;
  }

  // ── Step 2: Fetch issue + repo tree ───────────────────────────────────────
  const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner, repo: repoName, issue_number: issueNumber,
  });

  // ── Step 3: Scope guard - qualifying labels ───────────────────────────────
  const settings = await maintainerService.getSettings(repoId);
  const allowedLabels = (settings && settings.fix_allowed_labels) || DEFAULT_ALLOWED_LABELS;
  const issueLabels = issue.labels.map((l) => typeof l === "string" ? l : l.name).map((l) => l.toLowerCase());
  const hasQualifying = issueLabels.some((l) => allowedLabels.map((a) => a.toLowerCase()).includes(l));

  if (!hasQualifying) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", null, null,
      "No qualifying label. Issue labels: " + issueLabels.join(", "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - not eligible**\n\n" +
      "This issue doesn't have a qualifying label. Accepted labels: `" +
      allowedLabels.join("`, `") + "`\n\n" +
      "_Add one of these labels and try `/gitwire fix` again._"
    );
    return;
  }

  // ── Record attempt as analyzing ───────────────────────────────────────────
  await upsertFixAttempt(repoId, issueNumber, branchName, "analyzing");

  // Fetch repo file tree (top 3 levels)
  const tree = await fetchTree(octokit, owner, repoName);

  // ── Step 4: AI Pass 1 - Analyze ───────────────────────────────────────────
  const analysis = await aiAnalyze(issue, tree, repo);
  if (!analysis) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", null, null,
      "AI analysis returned no result");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - analysis failed**\n\n" +
      "Could not analyze this issue. It may be too complex or unclear.\n\n" +
      "_A maintainer should review manually._"
    );
    return;
  }

  logger.info({ repo, issueNumber, complexity: analysis.complexity, files: analysis.relevant_files }, "Analysis complete");

  // Reject if complexity is too high
  if (analysis.complexity === "complex") {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Complexity too high for autonomous fix");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - too complex**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "This issue requires human judgment. A maintainer should tackle this.\n\n" +
      "_Complexity: " + analysis.complexity + " · Relevant files: " + (analysis.relevant_files || []).join(", ") + "_"
    );
    return;
  }

  await upsertFixAttempt(repoId, issueNumber, branchName, "generating", analysis.complexity, analysis.explanation);

  // ── Step 5: Fetch relevant file contents ──────────────────────────────────
  const fileContents = await fetchFileContents(octokit, owner, repoName, analysis.relevant_files || []);

  // ── Step 6: AI Pass 2 - Generate patches ──────────────────────────────────
  const patches = await aiGenerate(issue, analysis, fileContents, repo);
  if (!patches || !patches.length) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "AI could not generate patches");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - no patches generated**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "AI analyzed the issue but couldn't produce a concrete fix.\n\n" +
      "_Complexity: " + analysis.complexity + " · A maintainer should review._"
    );
    return;
  }

  // ── Step 7: Create branch → commit patches → open PR ──────────────────────
  try {
    // Get default branch ref
    const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: repoName });
    const defaultBranch = repoInfo.default_branch;

    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner, repo: repoName, branch: defaultBranch,
    });

    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner, repo: repoName,
      ref: "refs/heads/" + branchName,
      sha: ref.object.sha,
    });

    // Apply search/replace patches to each file
    for (const patch of patches) {
      // Find the original file content (fetched earlier)
      const origFile = fileContents.find((f) => f.path === patch.path);
      if (!origFile) {
        throw new Error("Original content not found for " + patch.path);
      }

      const result = applyPatches(origFile.content, patch.replacements);
      if (result.errors.length > 0) {
        logger.warn({ path: patch.path, errors: result.errors, applied: result.applied },
          "Some replacements failed");
      }
      if (result.applied === 0) {
        throw new Error("No replacements could be applied to " + patch.path);
      }

      logger.info({ path: patch.path, applied: result.applied, failedReplacements: result.errors.length },
        "Patches applied");

      // Commit the patched file using the original SHA
      const patchedB64 = Buffer.from(result.content).toString("base64");
      await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner, repo: repoName,
        path: patch.path,
        message: patch.commit_message || ("fix: " + truncate(patch.explanation || patch.path, 72)),
        content: patchedB64,
        sha: origFile.sha,
        branch: branchName,
      });
    }

    // Open PR
    var prTitle = "🔧 [GitWire] Fix #" + issueNumber + ": " + truncate(issue.title, 60);
    var prBody = buildPRBody(issue, analysis, patches, issueNumber);

    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner, repo: repoName,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    });

    logger.info({ repo, issueNumber, prNumber: pr.number, prUrl: pr.html_url }, "Fix PR created");

    // Comment on issue linking to PR
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🔧 **GitWire Fix - PR submitted**\n\n" +
      "**PR:** [#" + pr.number + "](" + pr.html_url + ")\n" +
      "**Complexity:** " + (analysis.complexity || "unknown") + "\n" +
      "**Changes:** " + patches.length + " file" + (patches.length > 1 ? "s" : "") + "\n\n" +
      "**Assessment:** " + (analysis.explanation || "") + "\n\n" +
      "_Please review before merging._"
    );

    // Record success
    await upsertFixAttempt(repoId, issueNumber, branchName, "submitted",
      analysis.complexity, analysis.explanation, null, pr.number);

  } catch (err) {
    logger.error({ err, repo, issueNumber }, "Fix PR creation failed");
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed",
      analysis.complexity, analysis.explanation, "PR creation failed: " + err.message);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "❌ **GitWire Fix - PR creation failed**\n\n" +
      "The fix was generated but could not be submitted:\n> " + err.message + "\n\n" +
      "**Assessment:** " + (analysis.explanation || "") + "\n\n" +
      "_A maintainer may need to intervene._"
    );
  }
}

// ── Rate limiting ──────────────────────────────────────────────────────────

async function checkRateLimit(repoId, issueNumber, repoFullName) {
  const settings = await maintainerService.getSettings(repoId);
  const dailyLimit = (settings && settings.fix_daily_limit) || 3;
  const perIssueLimit = (settings && settings.fix_per_issue_limit) || 1;

  // Per-issue: check if already attempted
  const { rows: existing } = await db.query(
    "SELECT status FROM fix_attempts WHERE repo_id = $1 AND issue_number = $2",
    [repoId, issueNumber]
  );
  if (existing.length >= perIssueLimit) {
    const last = existing[existing.length - 1];
    return {
      allowed: false,
      reason: "This issue already has a fix attempt (status: " + last.status + "). " +
              "Limit: " + perIssueLimit + " per issue.",
    };
  }

  // Per-repo daily: count today's attempts
  const { rows: dailyRows } = await db.query(
    "SELECT COUNT(*)::int AS cnt FROM fix_attempts WHERE repo_id = $1 AND created_at >= NOW() - INTERVAL '1 day'",
    [repoId]
  );
  const dailyCount = dailyRows[0].cnt;
  if (dailyCount >= dailyLimit) {
    return {
      allowed: false,
      reason: "Daily fix limit reached (" + dailyCount + "/" + dailyLimit + " for this repo). " +
              "Try again tomorrow or adjust `fix_daily_limit` in settings.",
    };
  }

  return { allowed: true };
}

// ── DB helpers ─────────────────────────────────────────────────────────────

async function upsertFixAttempt(repoId, issueNumber, branchName, status, complexity, explanation, error, prNumber) {
  await db.query(
    "INSERT INTO fix_attempts (repo_id, issue_number, branch_name, pr_number, status, complexity, explanation, error, updated_at)\n" +
    "  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())\n" +
    "  ON CONFLICT (repo_id, issue_number) DO UPDATE SET\n" +
    "    status = EXCLUDED.status,\n" +
    "    complexity = EXCLUDED.complexity,\n" +
    "    explanation = EXCLUDED.explanation,\n" +
    "    error = EXCLUDED.error,\n" +
    "    pr_number = COALESCE(EXCLUDED.pr_number, fix_attempts.pr_number),\n" +
    "    updated_at = NOW()",
    [repoId, issueNumber, branchName, prNumber || null, status, complexity || null, explanation || null, error || null]
  );
}

// ── Fetch repo file tree ──────────────────────────────────────────────────

async function fetchTree(octokit, owner, repo) {
  try {
    const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner, repo, tree_sha: repoInfo.default_branch, recursive: 1,
    });
    const allFiles = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);

    // Prioritize source files over docs/assets to keep relevant files in view
    // Exclude vendor/bundle/plugin docs that flood the tree
    const srcExts = new Set([
      ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".yaml", ".yml",
      ".toml", ".cfg", ".ini", ".sh", ".bash", ".sql", ".rb", ".go",
      ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".php",
    ]);
    const excludePrefixes = [
      "plugins/bundle/", "node_modules/", "vendor/", "third_party/",
      ".github/", "website/", "docs/", "console/", "deploy/",
      "scripts/pack/", "tests/",
    ];
    const isVendor = (p) => excludePrefixes.some((pre) => p.startsWith(pre));

    const coreSource = allFiles.filter((p) => {
      const ext = "." + p.split(".").pop();
      return srcExts.has(ext) && !isVendor(p);
    });
    const vendorSource = allFiles.filter((p) => {
      const ext = "." + p.split(".").pop();
      return srcExts.has(ext) && isVendor(p);
    });
    const otherFiles = allFiles.filter((p) => {
      const ext = "." + p.split(".").pop();
      return !srcExts.has(ext);
    });

    // Core source first, then vendor source, then others - up to 500
    const prioritized = [...coreSource, ...vendorSource, ...otherFiles].slice(0, 500);
    return prioritized;
  } catch (err) {
    logger.error({ err, owner, repo }, "Failed to fetch tree");
    return [];
  }
}

// ── Fetch file contents ───────────────────────────────────────────────────

async function fetchFileContents(octokit, owner, repo, paths) {
  const results = [];
  for (const p of paths.slice(0, 10)) { // max 10 files
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner, repo, path: p,
      });
      const content = Buffer.from(data.content, "base64").toString("utf8");
      const sha = data.sha;
      results.push({ path: p, content, sha }); // full content - no truncation
    } catch (_) {
      // Skip files we can't read (e.g. too large, binary)
    }
  }
  return results;
}

// ── AI Pass 1: Analyze ────────────────────────────────────────────────────

async function aiAnalyze(issue, tree, repoFullName) {
  var fence = BT + BT + BT;
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

// ── AI Pass 2: Generate patches ───────────────────────────────────────────

async function aiGenerate(issue, analysis, fileContents, repoFullName) {
  var fence = BT + BT + BT;
  // Include full file contents - Claude only returns diffs
  var filesSection = fileContents.map((f) =>
    "--- " + f.path + " ---\n" + fence + "\n" + f.content + "\n" + fence
  ).join("\n\n");

  var prompt =
    "You are fixing a GitHub issue. Generate search/replace patches.\n\n" +
    "Repository: " + repoFullName + "\n" +
    "Issue #" + issue.number + ": " + issue.title + "\n\n" +
    "Issue body:\n" + (issue.body || "(no body)") + "\n\n" +
    "Fix strategy: " + (analysis.fix_strategy || "") + "\n\n" +
    "Files to modify:\n" + filesSection + "\n\n" +
    "Return ONLY a JSON array of patches:\n" +
    '[{"path": "relative/file/path",\n' +
    '  "replacements": [{"old": "exact text to find", "new": "replacement text"}],\n' +
    '  "commit_message": "fix(scope): description",\n' +
    '  "explanation": "what changed"}]\n\n' +
    "Rules:\n" +
    "- The 'old' field must be an EXACT substring from the file above - copy it verbatim\n" +
    "- The 'new' field is what replaces it\n" +
    "- You can have multiple replacements per file\n" +
    "- Make minimal changes - only what is needed to fix the issue\n" +
    "- Include ALL files that need to change\n" +
    "- If no files need changing, return empty array []\n" +
    "- Do NOT modify unrelated code";

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      system: "You are an expert software engineer. Return ONLY valid JSON. Generate minimal, precise search/replace patches. The 'old' text must match the file exactly.",
    });

    const raw = message.content[0].text;
    const cleaned = stripCodeFences(raw);
    const patches = extractJSON(cleaned);
    if (!Array.isArray(patches)) return null;
    // Filter out patches with no replacements
    return patches.filter((p) => p.path && p.replacements && p.replacements.length > 0);
  } catch (err) {
    logger.error({ err }, "AI patch generation failed");
    return null;
  }
}

// ── Apply search/replace patches to file contents ──────────────────────────

function applyPatches(originalContent, replacements) {
  var content = originalContent;
  var applied = 0;
  var errors = [];

  for (const rep of replacements) {
    if (!rep.old || !rep.new) {
      errors.push("replacement missing 'old' or 'new' field");
      continue;
    }
    if (!content.includes(rep.old)) {
      errors.push("'old' text not found in file (len=" + rep.old.length + "): " + rep.old.substring(0, 80) + "...");
      continue;
    }
    content = content.replace(rep.old, rep.new);
    applied++;
  }

  return { content, applied, errors };
}

// ── Build PR body ──────────────────────────────────────────────────────────

function buildPRBody(issue, analysis, patches, issueNumber) {
  var lines = [
    "## 🔧 GitWire Autonomous Fix",
    "",
    "Fixes #" + issueNumber,
    "",
    "**Complexity:** " + (analysis.complexity || "unknown"),
    "**Strategy:** " + (analysis.fix_strategy || ""),
    "",
    "### Assessment",
    analysis.explanation || "",
    "",
    "### Changes",
    "",
  ];

  for (const p of patches) {
    lines.push("- **" + p.path + "**" + (p.explanation ? ": " + p.explanation : ""));
    if (p.replacements) {
      for (const r of p.replacements) {
        var oldShort = truncate(r.old.trim(), 80);
        var newShort = truncate(r.new.trim(), 80);
        lines.push("  - Replace '" + oldShort + "' -> '" + newShort + "'");
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("*This PR was automatically generated by [GitWire](https://gitwire.erlab.uk).*");
  lines.push("*Review carefully before merging. Triggered by `/gitwire fix`.*");

  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function postIssueComment(octokit, owner, repo, issueNumber, body) {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: issueNumber, body,
    });
  } catch (err) {
    logger.error({ err, owner, repo, issueNumber }, "Failed to post issue comment");
  }
}

function truncate(str, max) {
  return str && str.length > max ? str.slice(0, max - 1) + "..." : str;
}

// ── Robust JSON extraction ─────────────────────────────────────────────────
// Claude sometimes prefixes JSON with text like "I'll generate...".
// Extract the first valid JSON object or array from the string.

function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}

  // Find the first { or [
  let start = -1;
  let isOpenObj = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { start = i; isOpenObj = true; break; }
    if (text[i] === "[") { start = i; isOpenObj = false; break; }
  }
  if (start === -1) return null;

  const openCh = isOpenObj ? "{" : "[";
  const closeCh = isOpenObj ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === openCh || ch === "[" || ch === "{") depth++;
    else if (ch === closeCh || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}
