// RepositoryTools v2 — `ls` (RI-9 amendment, Phase 3.4).
//
// Bounded single-level directory listing over the exact Git tree at HEAD:
// `git ls-tree <headSha>:<dir>`. Sorted entries, explicit truncation.

import { makeResult, utf8Bytes, ERROR_CODES } from "./contract.js";
import { validateRepoPath } from "./repositorySession.js";
import { loadTrackedIndex, intParam, applyItemBudget } from "./toolShared.js";

export const DEFAULT_LS_LIMIT = 500;
export const DEFAULT_LS_MAX_OUTPUT_BYTES = 131072;

/**
 * @param {object} session repository session
 * @param {object} [params]
 * @param {string} [params.path] directory path (default "." — repository root)
 * @param {number} [params.limit] max returned entries (default 500)
 * @param {number} [params.maxOutputBytes] max returned output bytes
 * @returns {Promise<object>} frozen tool-result envelope
 */
export async function ls(session, params = {}) {
  const startedAt = performance.now();
  session.assertOpen();
  const rawPath = params?.path === undefined || params?.path === null ? "." : params.path;
  const normalized = typeof rawPath === "string" ? rawPath.replace(/\/+$/, "") : rawPath;
  let dirPath;
  try {
    dirPath = validateRepoPath(normalized, { allowDot: true }) || ".";
  } catch (err) {
    return makeResult({
      operation: "ls", session, status: "error", startedAt,
      error: { code: ERROR_CODES.PATH_ESCAPE, message: err.message },
    });
  }
  const limit = intParam(params?.limit, DEFAULT_LS_LIMIT);
  const maxOutputBytes = intParam(params?.maxOutputBytes, DEFAULT_LS_MAX_OUTPUT_BYTES);

  const index = await loadTrackedIndex(session);
  if (dirPath !== "." && index.has(dirPath)) {
    return makeResult({
      operation: "ls", session, status: "error", startedAt,
      error: { code: ERROR_CODES.PATH_IS_FILE, message: `path is a tracked file, not a directory: ${dirPath}` },
    });
  }

  const res = await session.run(["ls-tree", dirPath === "." ? session.headSha : `${session.headSha}:${dirPath}`]);
  if (res.code !== 0) {
    const known = dirPath === "." || [...index.keys()].some((p) => p.startsWith(dirPath + "/"));
    return makeResult({
      operation: "ls", session, status: "error", startedAt,
      error: {
        code: known ? ERROR_CODES.BACKEND_FAILED : ERROR_CODES.PATH_NOT_FOUND,
        message: known
          ? `ls-tree failed for ${dirPath}: ${res.stderr}`
          : `directory not tracked at HEAD: ${dirPath}`,
      },
    });
  }

  const entries = [];
  for (const line of res.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = line.match(/^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/);
    if (!match) {
      return makeResult({
        operation: "ls", session, status: "error", startedAt,
        error: { code: ERROR_CODES.PARSE_FAILED, message: `unparseable ls-tree line: ${line}` },
      });
    }
    entries.push({
      name: match[4],
      type: match[2],
      kind: match[1] === "120000" ? "symlink" : match[2],
      mode: match[1],
      sha: match[3],
    });
  }

  const { kept, partialReasons } = applyItemBudget(entries, {
    limit,
    maxBytes: maxOutputBytes,
    weigh: (e) => utf8Bytes(e.name) + e.sha.length,
  });

  return makeResult({
    operation: "ls", session,
    status: partialReasons.length ? "partial" : "success",
    startedAt,
    partialReasons,
    data: { path: dirPath, entries: kept, totalEntries: entries.length },
    returnedBytes: kept.reduce((sum, e) => sum + utf8Bytes(e.name) + e.sha.length, 0),
    returnedItems: kept.length,
  });
}
