// src/workers/issueFix/scopeGuard.js
// Stage 2: Validate scope — check qualifying labels, fetch issue + exact-head tree.

import { isFixLabelAllowed } from "@gitwire/rules";
import { maintainerService } from "../../services/maintainerService.js";
import { buildIssueFixIssueSnapshot } from "../../services/issueFixTargetService.js";
import { logger } from "../../lib/logger.js";
import { db } from "../../lib/db.js";
import { upsertFixAttempt, postIssueComment } from "./helpers.js";

const DEFAULT_ALLOWED_LABELS = [
  "bug", "good first issue", "help wanted",
  "enhancement", "documentation",
];

/**
 * Returns the scope object (issue + exact repository snapshot), or null if the
 * pipeline should stop. The snapshot commit SHA and canonical issue snapshot are
 * carried through generation and re-checked immediately before external mutation.
 */
export async function validateScope(ctx) {
  const { octokit, owner, repoName, repoId, issueNumber, repoConfig } = ctx;

  const rateLimit = await checkRateLimit(repoId, issueNumber);
  if (!rateLimit.allowed) {
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - rate limited**\n\n" + rateLimit.reason +
      "\n\n_Adjust settings or wait for the limit to reset._"
    );
    return null;
  }

  const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner, repo: repoName, issue_number: issueNumber,
  });
  const issueSnapshot = buildIssueFixIssueSnapshot(issue);
  if (!issueSnapshot) {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "failed", null, null,
      "Could not establish canonical issue target state");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - issue target unavailable**\n\n" +
      "GitWire could not establish a stable issue target. No code mutation was attempted."
    );
    return null;
  }

  // GitHub's Issues API also returns pull requests. Autonomous Contributor is
  // intentionally issue-only: PR review/repair belongs to the review/repair path.
  if (issueSnapshot.is_pull_request) {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "rejected", null, null,
      "Target is a pull request, not an issue");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - issue targets only**\n\n" +
      "Autonomous Contributor does not create issue-fix PRs from an existing pull request."
    );
    return null;
  }

  if (issueSnapshot.state !== "open") {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "rejected", null, null,
      "Issue is not open");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - issue is closed**\n\n" +
      "Autonomous Contributor only fixes open issues. Reopen the issue before retrying."
    );
    return null;
  }

  const settings = await maintainerService.getSettings(repoId);
  const allowedLabels = repoConfig.pillars?.issue_fix?.allowed_labels || DEFAULT_ALLOWED_LABELS;
  const issueLabels = issueSnapshot.labels;
  const hasQualifying = issueLabels.some((label) => isFixLabelAllowed(label, repoConfig));

  if (!hasQualifying) {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "rejected", null, null,
      "No qualifying label. Issue labels: " + issueLabels.join(", "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - not eligible**\n\n" +
      "This issue doesn't have a qualifying label. Accepted labels: `" +
      allowedLabels.join("`, `") + "`\n\n" +
      "_Add one of these labels and try `/gitwire fix` again._"
    );
    return null;
  }

  await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "analyzing");

  const snapshot = await fetchRepositorySnapshot(octokit, owner, repoName);
  if (!snapshot) {
    await upsertFixAttempt(repoId, issueNumber, ctx.branchName, "failed", null, null,
      "Could not establish exact repository head for fix generation");
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - repository snapshot unavailable**\n\n" +
      "GitWire could not establish an exact repository head for this fix. No code mutation was attempted.\n\n" +
      "_Retry when the repository is available._"
    );
    return null;
  }

  return {
    issue,
    issueSnapshot,
    tree: snapshot.files,
    settings,
    baseSha: snapshot.baseSha,
    defaultBranch: snapshot.defaultBranch,
  };
}

async function checkRateLimit(repoId, issueNumber) {
  const settings = await maintainerService.getSettings(repoId);
  const dailyLimit = (settings && settings.fix_daily_limit) || 3;
  const perIssueLimit = (settings && settings.fix_per_issue_limit) || 1;

  // dry_run is evidence of a non-effect simulation. It must not make the real
  // issue-fix path ineligible when live mode is later enabled.
  const { rows: existing } = await db.query(
    "SELECT status FROM fix_attempts WHERE repo_id = $1 AND issue_number = $2 AND status NOT IN ('failed', 'rejected', 'superseded', 'dry_run')",
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
    "SELECT COUNT(*)::int AS cnt FROM fix_attempts WHERE repo_id = $1 AND created_at >= NOW() - INTERVAL '1 day' AND status <> 'dry_run'",
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

async function fetchRepositorySnapshot(octokit, owner, repo) {
  try {
    const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
    const defaultBranch = repoInfo.default_branch;
    if (!defaultBranch) throw new Error("Default branch unavailable");

    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner, repo, branch: defaultBranch,
    });
    const baseSha = ref.object?.sha;
    if (!baseSha) throw new Error("Default branch head SHA unavailable");

    // Git trees are addressed by tree SHA. Resolve the exact commit to its tree
    // first rather than asking the tree endpoint to interpret a moving ref.
    const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner, repo, commit_sha: baseSha,
    });
    const treeSha = commit.tree?.sha;
    if (!treeSha) throw new Error("Default branch tree SHA unavailable");

    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner, repo, tree_sha: treeSha, recursive: 1,
    });
    const allFiles = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);

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
    const isVendor = (path) => excludePrefixes.some((prefix) => path.startsWith(prefix));

    const coreSource = allFiles.filter((path) => {
      const ext = "." + path.split(".").pop();
      return srcExts.has(ext) && !isVendor(path);
    });
    const vendorSource = allFiles.filter((path) => {
      const ext = "." + path.split(".").pop();
      return srcExts.has(ext) && isVendor(path);
    });
    const otherFiles = allFiles.filter((path) => {
      const ext = "." + path.split(".").pop();
      return !srcExts.has(ext);
    });

    return {
      baseSha,
      defaultBranch,
      files: [...coreSource, ...vendorSource, ...otherFiles].slice(0, 500),
    };
  } catch (err) {
    logger.error({ err, owner, repo }, "Failed to establish issue-fix repository snapshot");
    return null;
  }
}
