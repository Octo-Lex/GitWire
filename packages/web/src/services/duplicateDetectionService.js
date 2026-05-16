// src/services/duplicateDetectionService.js
// Orchestrates the full duplicate detection flow for a single issue:
//   1. Generate + store embedding for the new issue
//   2. Fetch candidate embeddings from the same repo
//   3. Rank by cosine similarity
//   4. Persist duplicate_signals rows
//   5. Post a structured GitHub comment if duplicates found
//   6. Apply "duplicate" label if confidence is high
//
// GitWire adaptation: uses octokit.request() instead of octokit.rest.*
// (because @octokit/app returns core Octokit without REST plugin).

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  upsertIssueEmbedding,
  fetchCandidateEmbeddings,
  rankBySimilarity,
  DUPLICATE_THRESHOLD,
  RELATED_THRESHOLD,
} from "./embeddingService.js";

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run duplicate detection for a newly opened (or edited) issue.
 *
 * @param {object} opts
 * @param {object} opts.issue      — GitHub issue payload
 * @param {object} opts.repository — GitHub repository payload
 * @param {object} opts.octokit    — Authenticated Octokit instance (core, no REST plugin)
 * @returns {Promise<{ duplicates: Array, related: Array }>}
 */
export async function detectDuplicates({ issue, repository, octokit }) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const repoId = repository.id;

  logger.info({ repo: repository.full_name, issue: issue.number }, "Dup detection: start");

  // ── 0. Ensure the issue exists in the DB (may not be synced yet for new issues) ──
  await db.query(
    `INSERT INTO issues (github_id, repo_id, number, title, state, labels, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (github_id) DO UPDATE SET
       title     = EXCLUDED.title,
       state     = EXCLUDED.state,
       labels    = EXCLUDED.labels,
       updated_at = NOW()`,
    [issue.id, repoId, issue.number, issue.title, issue.state ?? 'open', issue.labels?.map(l => l.name) ?? []]
  );

  // ── 1. Embed the new issue ─────────────────────────────────────────────────
  const { vector: queryVector } = await upsertIssueEmbedding({
    github_id: issue.id,
    repo_id: repoId,
    title: issue.title,
    body: issue.body,
  });

  // ── 2. Load candidates ─────────────────────────────────────────────────────
  const candidates = await fetchCandidateEmbeddings(repoId, issue.id);

  if (!candidates.length) {
    logger.info({ issue: issue.number }, "Dup detection: no candidates yet, skipping");
    return { duplicates: [], related: [] };
  }

  // ── 3. Rank ────────────────────────────────────────────────────────────────
  const ranked = rankBySimilarity(queryVector, candidates);

  const duplicates = ranked.filter((r) => r.similarity >= DUPLICATE_THRESHOLD).slice(0, 3);
  const related = ranked.filter((r) => r.similarity >= RELATED_THRESHOLD && r.similarity < DUPLICATE_THRESHOLD).slice(0, 5);

  logger.info(
    { issue: issue.number, duplicates: duplicates.length, related: related.length },
    "Dup detection: ranked"
  );

  // ── 4. Persist signals ─────────────────────────────────────────────────────
  for (const dup of [...duplicates, ...related]) {
    await db.query(
      `INSERT INTO duplicate_signals
         (source_issue_id, target_issue_id, repo_id, similarity, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (source_issue_id, target_issue_id) DO UPDATE SET
         similarity = EXCLUDED.similarity,
         updated_at = NOW()`,
      [issue.id, dup.issueId, repoId, dup.similarity]
    );
  }

  // ── 5. Post GitHub comment ─────────────────────────────────────────────────
  if (duplicates.length || related.length) {
    const commentBody = buildDuplicateComment(issue, duplicates, related, owner, repo);

    const { data: comment } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo,
      issue_number: issue.number,
      body: commentBody,
    });

    // Store comment ID so we can edit it if the signal is confirmed/dismissed
    if (duplicates.length) {
      await db.query(
        `UPDATE duplicate_signals
         SET comment_id = $1
         WHERE source_issue_id = $2
           AND target_issue_id = $3`,
        [comment.id, issue.id, duplicates[0].issueId]
      );
    }

    logger.info({ issue: issue.number, commentId: comment.id }, "Dup detection: comment posted");
  }

  // ── 6. Apply label if high-confidence duplicate found ─────────────────────
  if (duplicates.length) {
    await ensureLabelAndApply(octokit, owner, repo, issue.number, {
      name: "duplicate",
      color: "cfd3d7",
      description: "This issue or pull request already exists",
    });

    // Update issues table
    await db.query(
      `UPDATE issues SET duplicate_of = $1 WHERE github_id = $2`,
      [duplicates[0].issueId, issue.id]
    );
  }

  return { duplicates, related };
}

// ── Batch embed all existing issues for a repo ────────────────────────────────

/**
 * Back-fill embeddings for all open issues in a repo that don't have one yet.
 * Called by the sync worker on the first sync after the feature is enabled.
 *
 * @param {object} opts
 * @param {number} opts.repoId        — repositories.github_id
 * @param {string} opts.repoFullName  — for logging
 */
export async function backfillEmbeddings({ repoId, repoFullName }) {
  const { rows: issues } = await db.query(
    `SELECT github_id, title FROM issues
     WHERE repo_id = $1
       AND state   = 'open'
       AND embedding_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1000`,
    [repoId]
  );

  logger.info({ repo: repoFullName, count: issues.length }, "Dup detection: backfill start");

  let done = 0;
  for (const issue of issues) {
    try {
      await upsertIssueEmbedding({
        github_id: issue.github_id,
        repo_id: repoId,
        title: issue.title,
        body: null,
      });
      done++;
      // Polite rate limiting — Voyage AI free tier is 3 req/s
      await sleep(350);
    } catch (err) {
      logger.warn({ issueId: issue.github_id, err: err.message }, "Dup detection: embed failed, skipping");
    }
  }

  logger.info({ repo: repoFullName, done }, "Dup detection: backfill complete");
  return done;
}

// ── Update a duplicate signal status ─────────────────────────────────────────

/**
 * Confirm or dismiss a duplicate signal (called from the API).
 * Updates the duplicate_signals row and edits the GitHub comment.
 *
 * @param {object} opts
 * @param {number} opts.sourceIssueId
 * @param {number} opts.targetIssueId
 * @param {'confirmed'|'dismissed'} opts.status
 * @param {object} opts.octokit
 * @param {string} opts.owner
 * @param {string} opts.repo
 */
export async function updateDuplicateStatus({ sourceIssueId, targetIssueId, status, octokit, owner, repo }) {
  const { rows: [signal] } = await db.query(
    `UPDATE duplicate_signals
     SET status = $1, updated_at = NOW()
     WHERE source_issue_id = $2 AND target_issue_id = $3
     RETURNING *`,
    [status, sourceIssueId, targetIssueId]
  );

  if (!signal) return;

  // Edit the comment to reflect the new status
  if (signal.comment_id) {
    const statusLine =
      status === "confirmed"
        ? "\n\n> **A maintainer has confirmed this is a duplicate.**"
        : "\n\n> **A maintainer has dismissed this duplicate signal.**";

    try {
      const { data: existing } = await octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner, repo, comment_id: signal.comment_id,
      });
      await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        owner, repo,
        comment_id: signal.comment_id,
        body: existing.body + statusLine,
      });
    } catch (err) {
      logger.warn({ commentId: signal.comment_id, err: err.message }, "Failed to update dup comment");
    }
  }

  // If confirmed: apply duplicate label and close the source issue
  if (status === "confirmed") {
    const { rows: [src] } = await db.query(
      `SELECT i.number FROM issues i WHERE i.github_id = $1`, [sourceIssueId]
    );
    if (src) {
      await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        owner, repo,
        issue_number: src.number,
        state: "closed",
        state_reason: "duplicate",
      }).catch((err) => logger.warn({ err: err.message }, "Failed to close duplicate issue"));
    }
  }

  return signal;
}

// ── Comment builder ───────────────────────────────────────────────────────────

function buildDuplicateComment(issue, duplicates, related, owner, repo) {
  const lines = [
    `> **Duplicate issue detection** — automated scan`,
    ``,
  ];

  if (duplicates.length) {
    lines.push(
      `### Likely duplicate${duplicates.length > 1 ? "s" : ""}`,
      ``,
      `The following issue${duplicates.length > 1 ? "s" : ""} appear${duplicates.length === 1 ? "s" : ""} to describe the same problem:`,
      ``
    );

    for (const d of duplicates) {
      const pct = Math.round(d.similarity * 100);
      lines.push(
        `- **#${d.number}** — ${d.title}`,
        `  Similarity: ${pct}% — ${similarityLabel(d.similarity)}`,
        ``
      );
    }

    lines.push(
      `If this is indeed a duplicate, please close this issue and reference the existing one. `,
      `A maintainer can confirm or dismiss this signal from the [dashboard](https://gitwire.erlab.uk/duplicates).`,
      ``
    );
  }

  if (related.length) {
    lines.push(
      `### Related issues`,
      ``,
      `These issues may be relevant but are likely distinct:`,
      ``
    );

    for (const r of related) {
      const pct = Math.round(r.similarity * 100);
      lines.push(`- #${r.number} — ${r.title} _(${pct}% similar)_`);
    }
    lines.push(``);
  }

  lines.push(
    `---`,
    `_Powered by [GitWire](https://gitwire.erlab.uk) duplicate detection_`
  );

  return lines.join("\n");
}

function similarityLabel(score) {
  if (score >= 0.97) return "almost identical";
  if (score >= 0.95) return "very high confidence";
  if (score >= 0.92) return "high confidence";
  return "moderate confidence";
}

async function ensureLabelAndApply(octokit, owner, repo, issueNumber, label) {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/labels', { owner, repo, ...label });
  } catch (err) {
    // Label already exists — that's fine
    if (!err.message?.includes("already_exists")) {
      logger.warn({ err: err.message }, "Failed to create duplicate label");
    }
  }
  try {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
      owner, repo, issue_number: issueNumber, labels: [label.name],
    });
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to apply duplicate label");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
