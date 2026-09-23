// src/services/issueFixTargetService.js
// D0-02: server-owned repository/installation resolution for Autonomous Contributor.
//
// Clients may identify a target repository by name. They may never select the
// GitHub App installation used to execute the fix. The stable GitHub repository
// id is carried through the queue only as a lookup key; workers re-resolve the
// current active repository + installation binding immediately before use.

import { db } from "../lib/db.js";

const PG_BIGINT_MAX = 9223372036854775807n;

function normalizePositiveBigintIdentifier(value) {
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) return null;
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n || parsed > PG_BIGINT_MAX) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeFullName(value) {
  const fullName = String(value ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) return null;
  return fullName;
}

function toTarget(row) {
  return {
    github_id: String(row.github_id),
    installation_id: String(row.installation_id),
    full_name: row.full_name,
    owner: row.owner,
    name: row.name,
    default_branch: row.default_branch,
  };
}

const TARGET_SELECT = `SELECT
  r.github_id,
  r.installation_id,
  r.full_name,
  r.owner,
  r.name,
  r.default_branch
FROM repositories r
JOIN installations i
  ON i.github_id = r.installation_id
 AND i.deleted_at IS NULL`;

/** Resolve an active repository by owner/name. Ambiguity fails closed. */
export async function resolveIssueFixRepositoryByFullName(value) {
  const fullName = normalizeFullName(value);
  if (!fullName) return { status: "invalid" };

  const { rows } = await db.query(
    `${TARGET_SELECT}
     WHERE r.full_name = $1
       AND r.deleted_at IS NULL
     LIMIT 2`,
    [fullName],
  );

  if (rows.length === 0) return { status: "not_found" };
  if (rows.length > 1) return { status: "ambiguous" };
  return { status: "resolved", repository: toTarget(rows[0]) };
}

/**
 * Re-resolve a queued stable GitHub repository id against current server state.
 * This is intentionally performed at worker execution time so a stale queued
 * installation binding cannot survive a repository transfer/uninstall.
 */
export async function resolveIssueFixRepositoryById(value) {
  const githubId = normalizePositiveBigintIdentifier(value);
  if (!githubId) return { status: "invalid" };

  const { rows } = await db.query(
    `${TARGET_SELECT}
     WHERE r.github_id = $1::bigint
       AND r.deleted_at IS NULL
     LIMIT 2`,
    [githubId],
  );

  if (rows.length === 0) return { status: "not_found" };
  if (rows.length > 1) return { status: "ambiguous" };
  return { status: "resolved", repository: toTarget(rows[0]) };
}

/** Verify that the authoritative repository binding has not drifted. */
export function sameIssueFixRepositoryBinding(expected, current) {
  if (!expected || !current) return false;
  return String(expected.github_id) === String(current.github_id)
    && String(expected.installation_id) === String(current.installation_id)
    && expected.full_name === current.full_name;
}
