// src/workers/issueFix/helpers.js
// Shared helpers for the issue fix pipeline stages.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

export async function upsertFixAttempt(repoId, issueNumber, branchName, status, complexity, explanation, error, prNumber) {
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

export async function postIssueComment(octokit, owner, repo, issueNumber, body) {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: issueNumber, body,
    });
  } catch (err) {
    logger.error({ err, owner, repo, issueNumber }, "Failed to post issue comment");
  }
}

export function truncate(str, max) {
  return str && str.length > max ? str.slice(0, max - 1) + "..." : str;
}

const FENCE_RE = /^```(?:json)?\s*\n?/i;
const FENCE_END_RE = /\n?```\s*$/i;

export function stripCodeFences(raw) {
  return raw.replace(FENCE_RE, "").replace(FENCE_END_RE, "").trim();
}

/**
 * Robust JSON extraction — handles Claude prefixing JSON with text.
 */
export function extractJSON(text) {
  try { return JSON.parse(text); } catch (_) {}

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

export async function fetchFileContents(octokit, owner, repo, paths) {
  const results = [];
  for (const p of paths.slice(0, 10)) {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner, repo, path: p,
      });
      const content = Buffer.from(data.content, "base64").toString("utf8");
      const sha = data.sha;
      results.push({ path: p, content, sha });
    } catch (_) {
      // Skip files we can't read
    }
  }
  return results;
}
