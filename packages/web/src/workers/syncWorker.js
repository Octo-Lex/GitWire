// src/workers/syncWorker.js
// Periodic full sync: walks every installation → every repo → issues, PRs, CI runs.
//
// Triggered two ways:
//   1. Scheduled: a repeatable BullMQ job runs every 30 minutes
//   2. On-demand: the REST API can enqueue an immediate sync per repo or installation
//
// The sync is incremental — it uses `since` timestamps so only changed items
// are fetched after the first full pass.

import { createWorker, createQueue, QUEUES } from "../lib/queue.js";
import { forEachInstallation, forEachRepo, getInstallationClient } from "../lib/github.js";
import { syncMembers, syncCollaborators, syncBranchRules } from "../services/maintainerService.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// ── Start the worker ─────────────────────────────────────────────────────────
export function startSyncWorker() {
  return createWorker(QUEUES.SYNC, async (job) => {
    switch (job.name) {
      case "full-sync":
        await runFullSync();
        break;
      case "sync-installation":
        await syncInstallation(job.data.installationId);
        break;
      case "sync-repo":
        await syncRepo(job.data.installationId, job.data.repoFullName);
        break;
      default:
        logger.warn({ jobName: job.name }, "Unknown sync job");
    }
  }, { concurrency: 2 }); // limit concurrency — we're hitting the GitHub API
}

// ── Schedule the repeating full-sync job ─────────────────────────────────────
// Call this once at startup. BullMQ deduplicates repeatable jobs by key.
export async function scheduleSyncJobs() {
  const syncQueue = createQueue(QUEUES.SYNC);

  await syncQueue.add(
    "full-sync",
    {},
    {
      repeat:   { every: 30 * 60 * 1000 }, // every 30 minutes
      jobId:    "full-sync-repeatable",
      attempts: 2,
    }
  );

  // Also kick off an immediate sync on startup so the DB is fresh from the start
  await syncQueue.add("full-sync", {}, { jobId: "full-sync-startup" });

  logger.info("Sync jobs scheduled (every 30 min + immediate startup sync)");
}

// ── Full sync: walk every installation ───────────────────────────────────────
async function runFullSync() {
  logger.info("Starting full sync across all installations");
  const start = Date.now();
  let repoCount = 0;

  await forEachInstallation(async (octokit, installation) => {
    await upsertInstallation(installation);

    // Sync org members (best-effort — needs org:read scope)
    if (installation.account?.type === 'Organization') {
      await syncMembers(octokit, installation.id, installation.account.login).catch(() => {});
    }

    await forEachRepo(octokit, async (repo) => {
      await upsertRepo(repo, installation.id);
      await syncRepoDetails(octokit, repo);
      repoCount++;
    });
  });

  logger.info({ repoCount, durationMs: Date.now() - start }, "Full sync complete");
}

// ── Sync a single installation ────────────────────────────────────────────────
async function syncInstallation(installationId) {
  const octokit = await getInstallationClient(installationId);

  const { data: installation } = await octokit.request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  });

  await upsertInstallation(installation);

  await forEachRepo(octokit, async (repo) => {
    await upsertRepo(repo, installationId);
    await syncRepoDetails(octokit, repo);
  });
}

// ── Sync a single repo by full name ──────────────────────────────────────────
async function syncRepo(installationId, repoFullName) {
  const octokit = await getInstallationClient(installationId);
  const [owner, name] = repoFullName.split("/");

  const { data: repo } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo: name });
  await upsertRepo(repo, installationId);
  await syncRepoDetails(octokit, repo);
}

// ── Sync issues + PRs + recent runs for one repo ──────────────────────────────
async function syncRepoDetails(octokit, repo) {
  const since = await getLastSyncedAt(repo.id);

  await Promise.all([
    syncIssues(octokit, repo, since),
    syncPullRequests(octokit, repo, since),
    syncWorkflowRuns(octokit, repo),
    syncCollaborators(octokit, repo.owner.login, repo.name, repo.id).catch(() => {}),
    syncBranchRules(octokit, repo.owner.login, repo.name, repo.id).catch(() => {}),
  ]);

  await db.query(
    `UPDATE repositories SET last_synced_at = NOW() WHERE github_id = $1`,
    [repo.id]
  );
}

// ── Issues sync ───────────────────────────────────────────────────────────────
async function syncIssues(octokit, repo, since) {
  const params = {
    owner:    repo.owner.login,
    repo:     repo.name,
    state:    "all",
    per_page: 100,
    ...(since ? { since: since.toISOString() } : {}),
  };

  let count = 0;
  let page = 1;
  while (true) {
    const { data: issues } = await octokit.request('GET /repos/{owner}/{repo}/issues', {
      ...params,
      page,
    });
    if (!issues.length) break;
    for (const issue of issues) {
      if (issue.pull_request) continue;
      await upsertIssue(issue, repo.id);
      count++;
    }
    page++;
  }

  if (count > 0) {
    logger.debug({ repo: repo.full_name, count }, "Issues synced");
  }
}

// ── Pull requests sync ────────────────────────────────────────────────────────
async function syncPullRequests(octokit, repo, since) {
  const params = {
    owner:    repo.owner.login,
    repo:     repo.name,
    state:    "all",
    per_page: 100,
    sort:     "updated",
    direction: "desc",
  };

  let count = 0;
  let page = 1;
  while (true) {
    const { data: prs } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
      ...params,
      page,
    });
    if (!prs.length) break;
    for (const pr of prs) {
      if (since && new Date(pr.updated_at) < since) break;
      await upsertPR(pr, repo.id);
      count++;
    }
    page++;
  }

  if (count > 0) {
    logger.debug({ repo: repo.full_name, count }, "PRs synced");
  }
}

// ── Workflow runs sync (last 20 runs per repo) ───────────────────────────────
async function syncWorkflowRuns(octokit, repo) {
  let runs;
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner:    repo.owner.login,
      repo:     repo.name,
      per_page: 20,
    });
    runs = data.workflow_runs;
  } catch (err) {
    // Actions API returns 404 if the repo has no workflows — that's fine
    if (err.status === 404) return;
    throw err;
  }

  for (const run of runs) {
    await upsertCIRun(run, repo.id);
  }
}

// ── DB upsert helpers ─────────────────────────────────────────────────────────

async function upsertInstallation(inst) {
  await db.query(
    `INSERT INTO installations (github_id, account_login, account_type, target_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       account_login = EXCLUDED.account_login,
       updated_at    = NOW()`,
    [inst.id, inst.account.login, inst.account.type, inst.target_id]
  );
}

async function upsertRepo(repo, installationId) {
  await db.query(
    `INSERT INTO repositories
       (github_id, installation_id, full_name, owner, name, private,
        default_branch, language, stars, open_issues, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       full_name      = EXCLUDED.full_name,
       default_branch = EXCLUDED.default_branch,
       language       = EXCLUDED.language,
       stars          = EXCLUDED.stars,
       open_issues    = EXCLUDED.open_issues,
       updated_at     = NOW()`,
    [
      repo.id, installationId, repo.full_name, repo.owner.login,
      repo.name, repo.private, repo.default_branch,
      repo.language, repo.stargazers_count, repo.open_issues_count,
    ]
  );
}

async function upsertIssue(issue, repoId) {
  await db.query(
    `INSERT INTO issues
       (github_id, repo_id, number, title, state, labels, assignees, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       title     = EXCLUDED.title,
       state     = EXCLUDED.state,
       labels    = EXCLUDED.labels,
       assignees = EXCLUDED.assignees,
       updated_at = NOW()`,
    [
      issue.id, repoId, issue.number, issue.title, issue.state,
      issue.labels.map((l) => l.name),
      issue.assignees.map((a) => a.login),
      issue.created_at,
    ]
  );
}

async function upsertPR(pr, repoId) {
  const state = pr.merged_at ? "merged" : pr.state;
  await db.query(
    `INSERT INTO pull_requests
       (github_id, repo_id, number, title, state, draft,
        head_branch, base_branch, labels, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       title       = EXCLUDED.title,
       state       = EXCLUDED.state,
       draft       = EXCLUDED.draft,
       labels      = EXCLUDED.labels,
       updated_at  = NOW()`,
    [
      pr.id, repoId, pr.number, pr.title, state, pr.draft,
      pr.head.ref, pr.base.ref,
      pr.labels.map((l) => l.name),
      pr.created_at,
    ]
  );
}

async function upsertCIRun(run, repoId) {
  await db.query(
    `INSERT INTO ci_runs
       (github_run_id, repo_id, workflow_name, branch, head_sha, conclusion, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (github_run_id) DO UPDATE SET
       conclusion = EXCLUDED.conclusion,
       updated_at = NOW()`,
    [
      run.id, repoId, run.name, run.head_branch,
      run.head_sha, run.conclusion, run.created_at,
    ]
  );
}

async function getLastSyncedAt(repoGithubId) {
  const { rows } = await db.query(
    `SELECT last_synced_at FROM repositories WHERE github_id = $1`,
    [repoGithubId]
  );
  return rows[0]?.last_synced_at ?? null;
}
