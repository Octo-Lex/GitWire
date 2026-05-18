/**
 * @module mergeQueueService
 * Auto-merge queue for Phase 2.
 *
 * Manages a FIFO queue of PRs waiting to be merged automatically
 * once all required checks pass.
 *
 * Public API:
 *   - admitToQueue({ pr, repository, octokit }) — add PR to queue
 *   - removeFromQueue({ repoId, prNumber, reason }) — remove PR from queue
 *   - onChecksUpdated({ checkSuite, repository, octokit }) — update check status
 *   - processQueue(repoId, repository, octokit) — merge ready PRs
 */

/**
 * Admit a PR to the auto-merge queue.
 * Checks eligibility (non-draft, correct base branch, has approvals)
 * then inserts into merge_queue_entries.
 *
 * @param {Object} params
 * @param {Object} params.pr         - GitHub PR object
 * @param {Object} params.repository - GitHub repository object
 * @param {Object} params.octokit    - Authenticated Octokit instance
 * @returns {Promise<Object|null>} Inserted queue entry or null if ineligible
 */

import { db }  from "../lib/db.js";
import { Events } from "./pipelineEvents.js";
import { sendFeedback } from "./feedbackService.js";
import { logger } from "../lib/logger.js";

// ════════════════════════════════════════════════════════════════════════════
// Admit a PR to the queue
// ════════════════════════════════════════════════════════════════════════════

export async function admitToQueue({ pr, repository, octokit }) {
  const repoId = repository.id;

  const cfg = await getQueueConfig(repoId);
  if (!cfg?.enabled) {
    logger.debug({ repo: repository.full_name, pr: pr.number }, "Merge queue: not enabled for repo");
    return null;
  }

  const eligible = await checkEligibility({ pr, repository, octokit, cfg });
  if (!eligible.ok) {
    logger.info({ pr: pr.number, reason: eligible.reason }, "Merge queue: PR not eligible");
    return null;
  }

  const { rows: [{ count }] } = await db.query(
    "SELECT COUNT(*) FROM merge_queue_entries WHERE repo_id = $1 AND status IN ('pending','ready','merging')",
    [repoId]
  );
  if (Number(count) >= cfg.max_queue_depth) {
    await postQueueComment(octokit, repository.owner.login, repository.name, pr.number,
      "Queue full (" + cfg.max_queue_depth + " entries). This PR will be admitted when space opens.");
    return null;
  }

  const { rows: [{ max_pos }] } = await db.query(
    "SELECT COALESCE(MAX(position), 0) AS max_pos FROM merge_queue_entries WHERE repo_id = $1 AND status IN ('pending','ready','merging')",
    [repoId]
  );
  const position = Number(max_pos) + 1;

  const requiredChecks = cfg.required_checks?.length
    ? cfg.required_checks
    : await getRequiredChecks(octokit, repository.owner.login, repository.name, pr.base.ref);

  const { rows: [entry] } = await db.query(
    `INSERT INTO merge_queue_entries
       (repo_id, pr_number, pr_title, head_sha, head_branch, base_branch,
        author_login, position, required_checks, merge_method, delete_branch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (repo_id, pr_number) DO UPDATE SET
       head_sha = EXCLUDED.head_sha, status = 'pending', updated_at = NOW()
     RETURNING *`,
    [repoId, pr.number, pr.title, pr.head.sha,
     pr.head.ref, pr.base.ref, pr.user.login, position,
     requiredChecks, cfg.merge_method, cfg.delete_branch]
  );

  await ensureLabelAndApply(octokit, repository.owner.login, repository.name, pr.number, {
    name: "queued-for-merge", color: "0075ca", description: "In the auto-merge queue",
  });

  const checkNames = requiredChecks.length ? requiredChecks.map(c => '`' + c + '`').join(", ") : "all branch-protection checks";
  await postQueueComment(octokit, repository.owner.login, repository.name, pr.number,
    "Admitted to the auto-merge queue (position #" + position + ")\n\n" +
    "This PR will be merged automatically once all required checks pass.\n" +
    "Required: " + checkNames + "\n\n" +
    "_Remove the `queued-for-merge` label to dequeue._");

  await Events.prAdmitted(repoId, {
    prNumber: pr.number, ref: pr.head.ref, actor: pr.user.login,
    metadata: { position, required_checks: requiredChecks },
  });

  logger.info({ repo: repository.full_name, pr: pr.number, position }, "Merge queue: admitted");
  return entry;
}

// ════════════════════════════════════════════════════════════════════════════
// Update check status for a queued PR
// ════════════════════════════════════════════════════════════════════════════

export async function onChecksUpdated({ checkSuite, repository, octokit }) {
  const repoId   = repository.id;
  const headSha  = checkSuite.head_sha;

  const { rows: [entry] } = await db.query(
    "SELECT * FROM merge_queue_entries WHERE repo_id = $1 AND head_sha = $2 AND status IN ('pending','ready')",
    [repoId, headSha]
  );
  if (!entry) return;

  const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    owner: repository.owner.login, repo: repository.name, ref: headSha, per_page: 100,
  });
  const check_runs = data.check_runs ?? data ?? [];

  const passed  = check_runs.filter(c => c.conclusion === "success").map(c => c.name);
  const failed  = check_runs.filter(c => c.conclusion === "failure").map(c => c.name);

  const requiredChecks = entry.required_checks ?? [];
  const allPassed = requiredChecks.length === 0
    ? check_runs.every(c => ["success","skipped","neutral"].includes(c.conclusion))
    : requiredChecks.every(name => passed.includes(name));

  const anyFailed = requiredChecks.length > 0
    ? requiredChecks.some(name => failed.includes(name))
    : failed.length > 0;

  if (anyFailed) {
    await db.query(
      "UPDATE merge_queue_entries SET status = 'blocked', checks_failed = $1, checks_passed = $2, blocked_at = NOW(), updated_at = NOW() WHERE id = $3",
      [failed, passed, entry.id]
    );

    await sendFeedback({
      eventType: "pr_blocked", repoId, repository, prNumber: entry.pr_number, octokit,
      data: { reason: "Required checks failed: " + failed.join(", "), failed_checks: failed },
    });

    await Events.prBlocked(repoId, {
      prNumber: entry.pr_number, ref: entry.head_sha,
      metadata: { failed_checks: failed },
    });

    logger.info({ pr: entry.pr_number, failed }, "Merge queue: blocked by failed checks");
    return;
  }

  if (allPassed) {
    await db.query(
      "UPDATE merge_queue_entries SET status = 'ready', checks_passed = $1, ready_at = NOW(), updated_at = NOW() WHERE id = $2",
      [passed, entry.id]
    );
    await processQueue(repoId, repository, octokit);
  } else {
    await db.query(
      "UPDATE merge_queue_entries SET checks_passed = $1, updated_at = NOW() WHERE id = $2",
      [passed, entry.id]
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Process the queue — merge the front 'ready' entry
// ════════════════════════════════════════════════════════════════════════════

export async function processQueue(repoId, repository, octokit) {
  const { rows: [entry] } = await db.query(
    "SELECT * FROM merge_queue_entries WHERE repo_id = $1 AND status = 'ready' ORDER BY position ASC LIMIT 1",
    [repoId]
  );
  if (!entry) return;

  const { rowCount } = await db.query(
    "UPDATE merge_queue_entries SET status = 'merging', updated_at = NOW() WHERE id = $1 AND status = 'ready'",
    [entry.id]
  );
  if (!rowCount) return;

  logger.info({ repo: repository.full_name, pr: entry.pr_number }, "Merge queue: merging");

  const owner = repository.owner.login;
  const repo  = repository.name;
  const start = Date.now();

  try {
    const { data: livePR } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner, repo, pull_number: entry.pr_number,
    });

    if (livePR.state !== "open") {
      await db.query("UPDATE merge_queue_entries SET status = 'removed', updated_at = NOW() WHERE id = $1", [entry.id]);
      return;
    }
    if (livePR.head.sha !== entry.head_sha) {
      await db.query("UPDATE merge_queue_entries SET status = 'pending', head_sha = $1, updated_at = NOW() WHERE id = $2",
        [livePR.head.sha, entry.id]);
      return;
    }

    // Merge
    const { data: merge } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner, repo,
      pull_number:   entry.pr_number,
      merge_method:  entry.merge_method,
      commit_title:  livePR.title + " (#" + entry.pr_number + ")",
      commit_message: "Auto-merged by GitWire merge queue.\n\nApproved and all checks passed.",
    });

    await db.query(
      "UPDATE merge_queue_entries SET status = 'merged', merged_at = NOW(), updated_at = NOW() WHERE id = $1",
      [entry.id]
    );

    if (entry.delete_branch) {
      await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        owner, repo, ref: "heads/" + entry.head_branch,
      }).catch(err => logger.warn({ err: err.message }, "Merge queue: could not delete branch"));
    }

    await rebalancePositions(repoId);

    const durationMs = Date.now() - start;

    await Events.prMerged(repoId, {
      prNumber: entry.pr_number, ref: entry.head_branch,
      actor: "gitwire[bot]", durationMs, success: true,
      metadata: { merge_sha: merge.sha, method: entry.merge_method },
    });

    await sendFeedback({
      eventType: "pr_merged", repoId, repository, prNumber: entry.pr_number, octokit,
      data: { merge_sha: merge.sha, duration_ms: durationMs },
    });

    logger.info({ pr: entry.pr_number, sha: merge.sha }, "Merge queue: merged successfully");

    // Process next in queue
    await processQueue(repoId, repository, octokit);

  } catch (err) {
    logger.error({ pr: entry.pr_number, err: err.message }, "Merge queue: merge failed");

    await db.query(
      "UPDATE merge_queue_entries SET status = 'blocked', merge_error = $1, updated_at = NOW() WHERE id = $2",
      [err.message, entry.id]
    );

    await postQueueComment(octokit, owner, repo, entry.pr_number,
      "Auto-merge failed\n\n" + err.message + "\n\nPlease resolve the issue and re-add the queued-for-merge label.");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Remove a PR from the queue
// ════════════════════════════════════════════════════════════════════════════

export async function removeFromQueue({ repoId, prNumber, reason = "removed" }) {
  await db.query(
    "UPDATE merge_queue_entries SET status = $1, updated_at = NOW() WHERE repo_id = $2 AND pr_number = $3 AND status NOT IN ('merged','removed')",
    [reason, repoId, prNumber]
  );
  await rebalancePositions(repoId);
  logger.info({ repoId, prNumber, reason }, "Merge queue: entry removed");
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

async function checkEligibility({ pr, repository, octokit, cfg }) {
  if (pr.draft) return { ok: false, reason: "draft PR" };
  if (pr.base.ref !== (cfg.base_branch ?? "main") && cfg.base_branch) {
    return { ok: false, reason: "targets " + pr.base.ref + ", not " + cfg.base_branch };
  }

  const { data: reviews } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner: repository.owner.login, repo: repository.name, pull_number: pr.number,
  });
  const approvals = reviews.filter(r => r.state === "APPROVED");
  if (!approvals.length) return { ok: false, reason: "no approvals yet" };

  return { ok: true };
}

async function getRequiredChecks(octokit, owner, repo, branch) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", { owner, repo, branch });
    return data.required_status_checks?.contexts ?? [];
  } catch {
    return [];
  }
}

async function getQueueConfig(repoId) {
  const { rows: [cfg] } = await db.query("SELECT * FROM merge_queue_config WHERE repo_id = $1", [repoId]);
  return cfg ?? null;
}

async function rebalancePositions(repoId) {
  await db.query(
    `UPDATE merge_queue_entries AS mq SET position = sub.new_pos
     FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY admitted_at) AS new_pos
           FROM merge_queue_entries WHERE repo_id = $1 AND status IN ('pending','ready','merging')) sub
     WHERE mq.id = sub.id`,
    [repoId]
  );
}

async function postQueueComment(octokit, owner, repo, prNumber, body) {
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner, repo, issue_number: prNumber, body,
  }).catch(err => logger.warn({ err: err.message }, "Merge queue: could not post comment"));
}

async function ensureLabelAndApply(octokit, owner, repo, prNumber, label) {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/labels", { owner, repo, ...label });
  } catch { /* already exists */ }
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner, repo, issue_number: prNumber, labels: [label.name],
  }).catch(err => logger.warn({ err: err.message }, "Merge queue: could not apply label"));
}
