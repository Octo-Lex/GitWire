// src/services/conventionDetector.js
// Detects the commit/PR title convention used by a repository.
// Caches the result in Redis for 24 hours.

import { logger } from "../lib/logger.js";

// Convention indicators — files whose presence suggests conventional commits
const CONVENTIONAL_FILES = [
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yml",
  ".commitlintrc.yaml",
  ".versionrc",
  ".versionrc.json",
];

// Regex for conventional commit PR titles: "type(scope): description"
const CONVENTIONAL_RE = /^[a-z]+(\([^)]+\))?:\s+.+/;

// All known conventional commit types
const CONVENTIONAL_TYPES = new Set([
  "feat", "fix", "docs", "style", "refactor", "perf", "test",
  "chore", "build", "ci", "revert", "bump", "improve",
]);

const CACHE_TTL = 86400; // 24 hours

/**
 * Detect the commit/PR convention for a repo.
 * Returns { style: "conventional" | "default" }
 */
export async function detectConvention(octokit, owner, repo) {
  // Check Redis cache first
  const cacheKey = "gitwire:convention:" + owner + "/" + repo;
  try {
    const { redis } = await import("../lib/queue.js");
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (_e) { /* corrupt cache, re-detect */ }
    }
  } catch (_e) { /* Redis unavailable, continue */ }

  let style = "default";

  try {
    // Strategy 1: Check for convention config files
    const hasConfig = await checkConventionFiles(octokit, owner, repo);
    if (hasConfig) {
      style = "conventional";
    }

    // Strategy 2: Check recent merged PR titles
    if (style === "default") {
      const recentPattern = await checkRecentPRs(octokit, owner, repo);
      if (recentPattern) {
        style = "conventional";
      }
    }

    // Strategy 3: Check package.json for commitlint/semantic-release deps
    if (style === "default") {
      const hasDeps = await checkPackageDeps(octokit, owner, repo);
      if (hasDeps) {
        style = "conventional";
      }
    }
  } catch (err) {
    logger.debug({ err, owner, repo }, "Convention detection failed, using default");
  }

  const result = { style };

  // Cache the result
  try {
    const { redis } = await import("../lib/queue.js");
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result));
  } catch (_e) { /* Redis unavailable, skip cache */ }

  return result;
}

/**
 * Format a PR title according to the detected convention.
 */
export function formatPRTitle(convention, type, scope, description, issueNumber) {
  if (convention.style === "conventional") {
    // "fix(file_io): avoid raw spreadsheet reads (#1)"
    const scopePart = scope ? "(" + scope + ")" : "";
    const issueRef = issueNumber ? " (#" + issueNumber + ")" : "";
    return type + scopePart + ": " + description + issueRef;
  }

  // Default GitWire style
  const prefix = type === "fix" ? "🔧 [GitWire] Fix" : "🔧 [GitWire] " + type;
  const issueRef = issueNumber ? " #" + issueNumber + ":" : ":";
  return prefix + issueRef + " " + truncate(description, 60);
}

/**
 * Extract a scope from a file path.
 * e.g. "src/qwenpaw/agents/tools/file_io.py" → "file_io"
 */
export function extractScope(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/\\/g, "/").split("/");
  const filename = parts[parts.length - 1];
  // Strip extension
  const base = filename.replace(/\.[^.]+$/, "");
  // If it's "index" or too generic, use parent directory
  if (base === "index" || base === "mod" || base.length < 2) {
    return parts.length > 1 ? parts[parts.length - 2] : base;
  }
  return base;
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.substring(0, maxLen - 1) + "…" : str;
}

// ── Detection helpers ──────────────────────────────────────────────────

async function checkConventionFiles(octokit, owner, repo) {
  for (const filename of CONVENTIONAL_FILES) {
    try {
      await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner, repo, path: filename,
      });
      return true; // file exists → conventional
    } catch (_e) {
      // 404 = not found, continue
    }
  }
  return false;
}

async function checkRecentPRs(octokit, owner, repo) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner, repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 10,
    });

    if (data.length === 0) return false;

    // If 6+ of last 10 merged PRs match conventional pattern → conventional
    let matches = 0;
    for (const pr of data) {
      if (pr.merged_at && CONVENTIONAL_RE.test(pr.title)) {
        const typeMatch = pr.title.match(/^([a-z]+)/);
        if (typeMatch && CONVENTIONAL_TYPES.has(typeMatch[1])) {
          matches++;
        }
      }
    }

    return matches >= 6;
  } catch (_e) {
    return false;
  }
}

async function checkPackageDeps(octokit, owner, repo) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner, repo, path: "package.json",
    });
    const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
    const allDeps = {
      ...(content.devDependencies || {}),
      ...(content.dependencies || {}),
    };
    // Check for conventional commit tooling
    const indicators = [
      "@commitlint/cli",
      "commitlint",
      "semantic-release",
      "standard-version",
      "conventional-changelog-cli",
      "@commitlint/config-conventional",
    ];
    return indicators.some((name) => name in allDeps);
  } catch (_e) {
    return false;
  }
}
