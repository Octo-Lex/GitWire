// src/workers/issueFix/scopeGuard.js
// Stage 2: Validate scope — check qualifying labels, fetch issue + tree.

import { isFixLabelAllowed } from "@gitwire/rules";
import { maintainerService } from "../../services/maintainerService.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../lib/db.js";
import { upsertFixAttempt, postIssueComment } from "./helpers.js";

const DEFAULT_ALLOWED_LABELS = [
  "bug", "good first issue", "help wanted",
  "enhancement", "documentation",
];

/**
 * Returns the scope object (issue + tree), or null if pipeline should stop.
 * CC target: ~4
 */
export async function validateScope(ctx) {
  const { octokit, owner, repoName, repoId, issueNumber, repoConfig, repo } = ctx;

  // ── Rate limit check ─────────────────────────────────────────────────────
  const rateLimit = await checkRateLimit(repoId, issueNumber, repo, repoConfig);
  if (!rateLimit.allowed) {
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - rate limited**\n\n" + rateLimit.reason +
      "\n\n_Adjust settings or wait for the limit to reset._"
    );
    return null;
  }

  // ── Fetch issue from GitHub ──────────────────────────────────────────────
  const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner: owner, repo: repoName, issue_number: issueNumber,
  });

  // ── Scope guard: qualifying labels ───────────────────────────────────────
  const settings = await maintainerService.getSettings(repoId);
  const allowedLabels = (settings && settings.fix_allowed_labels) || repoConfig.pillars?.issue_fix?.allowed_labels || DEFAULT_ALLOWED_LABELS;
  const issueLabels = issue.labels.map((l) => typeof l === "string" ? l : l.name).map((l) => l.toLowerCase());
  const hasQualifying = issueLabels.some((l) => isFixLabelAllowed(l, repoConfig));

  if (!hasQualifying) {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "rejected", null, null,
      "No qualifying label. Issue labels: " + issueLabels.join(", "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - not eligible**\n\n" +
      "This issue doesn't have a qualifying label. Accepted labels: `" +
      allowedLabels.join("`, `") + "`\n\n" +
      "_Add one of these labels and try `/gitwire fix` again._"
    );
    return null;
  }

  // ── Record attempt ───────────────────────────────────────────────────────
  await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "analyzing");

  // ── Fetch repo file tree ─────────────────────────────────────────────────
  const tree = await fetchTree(octokit, owner, repoName);

  return { issue, tree, settings };
}

// ── Rate limiting ──────────────────────────────────────────────────────────

async function checkRateLimit(repoId, issueNumber, repoFullName, repoConfig) {
  const settings = await maintainerService.getSettings(repoId);
  const dailyLimit = (settings && settings.fix_daily_limit) || 3;
  const perIssueLimit = (settings && settings.fix_per_issue_limit) || 1;

  const { rows: existing } = await db.query(
    "SELECT status FROM fix_attempts WHERE repo_id = $1 AND issue_number = $2 AND status NOT IN ('failed', 'rejected', 'superseded')",
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

// ── Fetch repo file tree ──────────────────────────────────────────────────

async function fetchTree(octokit, owner, repo) {
  try {
    const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner, repo, tree_sha: repoInfo.default_branch, recursive: 1,
    });
    const allFiles = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);

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

    return [...coreSource, ...vendorSource, ...otherFiles].slice(0, 500);
  } catch (err) {
    logger.error({ err, owner, repo }, "Failed to fetch tree");
    return [];
  }
}
