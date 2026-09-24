// src/services/issueFixTargetService.js
// D0-02: server-owned repository/installation resolution and issue-target
// freshness evidence for Autonomous Contributor.
//
// Clients may identify a target repository by name. They may never select the
// GitHub App installation used to execute the fix. The stable GitHub repository
// id is carried through the queue only as a lookup key; workers re-resolve the
// current active repository + installation binding immediately before use.
//
// Current Wave-2 auth helpers still convert GitHub installation/repository ids
// through JavaScript Number. Until that substrate is made bigint/string-safe,
// this service fails closed for ids above Number.MAX_SAFE_INTEGER rather than
// claiming lossless authority binding that downstream code cannot preserve.

import { db } from "../lib/db.js";

const PG_BIGINT_MAX = 9223372036854775807n;
const JS_SAFE_ID_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function normalizePositivePgBigint(value) {
  const raw = String(value ?? "");
  if (!/^\d+$/.test(raw)) return null;
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n || parsed > PG_BIGINT_MAX) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeFullName(value) {
  const fullName = String(value ?? "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) return null;
  return fullName;
}

function normalizeIssueLabels(labels) {
  if (!Array.isArray(labels)) return [];
  const names = labels
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((name) => typeof name === "string" && name.length > 0)
    .map((name) => name.toLowerCase());
  return [...new Set(names)].sort();
}

function toRuntimeSafeTarget(row) {
  const repositoryId = normalizePositivePgBigint(row?.github_id);
  const installationId = normalizePositivePgBigint(row?.installation_id);
  const fullName = normalizeFullName(row?.full_name);
  if (!repositoryId || !installationId || !fullName) return null;
  if (repositoryId > JS_SAFE_ID_MAX || installationId > JS_SAFE_ID_MAX) return null;

  // `full_name` is the canonical repository coordinate tracked by the identity
  // reconciliation path. Historical/full-sync rows can carry stale denormalized
  // owner/name columns after a rename or transfer, so never use those columns as
  // GitHub request authority. Derive both API coordinates from canonical full_name.
  const [owner, name] = fullName.split("/");

  return {
    github_id: repositoryId.toString(),
    installation_id: installationId.toString(),
    full_name: fullName,
    owner,
    name,
    default_branch: row.default_branch,
  };
}

function classifyRows(rows) {
  if (rows.length === 0) return { status: "not_found" };
  if (rows.length > 1) return { status: "ambiguous" };
  const repository = toRuntimeSafeTarget(rows[0]);
  if (!repository) return { status: "unsupported_identifier" };
  return { status: "resolved", repository };
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

  return classifyRows(rows);
}

/**
 * Re-resolve a queued stable GitHub repository id against current server state.
 * This is intentionally performed at worker execution time so a stale queued
 * installation binding cannot survive a repository transfer/uninstall.
 */
export async function resolveIssueFixRepositoryById(value) {
  const parsed = normalizePositivePgBigint(value);
  if (!parsed) return { status: "invalid" };
  if (parsed > JS_SAFE_ID_MAX) return { status: "unsupported_identifier" };
  const githubId = parsed.toString();

  const { rows } = await db.query(
    `${TARGET_SELECT}
     WHERE r.github_id = $1::bigint
       AND r.deleted_at IS NULL
     LIMIT 2`,
    [githubId],
  );

  return classifyRows(rows);
}

/** Verify that the authoritative repository binding has not drifted. */
export function sameIssueFixRepositoryBinding(expected, current) {
  if (!expected || !current) return false;
  return String(expected.github_id) === String(current.github_id)
    && String(expected.installation_id) === String(current.installation_id)
    && expected.full_name === current.full_name;
}

/**
 * Canonicalize only the issue fields that are relevant to autonomous-fix intent.
 * `updated_at` is retained as evidence but is intentionally not an equality
 * input: unrelated comments can advance it without changing the problem to fix.
 */
export function buildIssueFixIssueSnapshot(issue) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return null;

  const issueNumber = Number(issue.number);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;

  const githubId = issue.id == null ? null : String(issue.id);
  if (!githubId) return null;

  const state = typeof issue.state === "string" ? issue.state.toLowerCase() : null;
  if (state !== "open" && state !== "closed") return null;

  return Object.freeze({
    github_id: githubId,
    number: issueNumber,
    state,
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.body === "string" ? issue.body : "",
    labels: Object.freeze(normalizeIssueLabels(issue.labels)),
    is_pull_request: !!issue.pull_request,
    updated_at: issue.updated_at == null ? null : String(issue.updated_at),
  });
}

/**
 * Compare the fields that define the problem statement and eligibility. This
 * deliberately ignores `updated_at` so a new discussion comment alone does not
 * invalidate a fix, while edits, relabeling, close/reopen, target replacement,
 * or an Issues-API pull-request target do invalidate it.
 */
export function sameIssueFixIssueSnapshot(expected, current) {
  if (!expected || !current) return false;
  return expected.github_id === current.github_id
    && expected.number === current.number
    && expected.state === current.state
    && expected.title === current.title
    && expected.body === current.body
    && expected.is_pull_request === current.is_pull_request
    && JSON.stringify(expected.labels) === JSON.stringify(current.labels);
}
