// RepositoryTools v2 — `find` (RI-9 amendment, Phase 3.3).
//
// Tracked-path truth only (`git ls-tree -r <headSha>`): file contents are
// never examined to locate filenames, untracked files are invisible, and
// the result carries explicit truncation metadata.

import { makeResult, utf8Bytes, ERROR_CODES } from "./contract.js";
import { loadTrackedIndex, matchesGlob, validateGlob, intParam, applyItemBudget } from "./toolShared.js";

export const DEFAULT_FIND_LIMIT = 500;
export const DEFAULT_FIND_MAX_OUTPUT_BYTES = 131072;

/**
 * @param {object} session repository session
 * @param {object} [params]
 * @param {string} [params.glob] git-wildmatch-style filter (no '/' → basename
 *        match at any depth; with '/' → anchored at repository root)
 * @param {number} [params.limit] max returned paths (default 500)
 * @param {number} [params.maxOutputBytes] max returned output bytes
 * @returns {Promise<object>} frozen tool-result envelope
 */
export async function find(session, params = {}) {
  const startedAt = performance.now();
  session.assertOpen();
  let glob = null;
  if (params?.glob !== undefined && params?.glob !== null) {
    try {
      glob = validateGlob(params.glob);
    } catch (err) {
      return makeResult({
        operation: "find", session, status: "error", startedAt,
        error: { code: ERROR_CODES.SCOPE_INVALID, message: err.message },
      });
    }
  }
  const limit = intParam(params?.limit, DEFAULT_FIND_LIMIT);
  const maxOutputBytes = intParam(params?.maxOutputBytes, DEFAULT_FIND_MAX_OUTPUT_BYTES);

  const index = await loadTrackedIndex(session);
  const allPaths = [...index.keys()].sort();
  const matched = glob ? allPaths.filter((p) => matchesGlob(p, glob)) : allPaths;

  const { kept, partialReasons } = applyItemBudget(matched, {
    limit,
    maxBytes: maxOutputBytes,
    weigh: (p) => utf8Bytes(p),
  });

  return makeResult({
    operation: "find", session,
    status: partialReasons.length ? "partial" : "success",
    startedAt,
    partialReasons,
    data: { paths: kept, totalMatched: matched.length, glob },
    returnedBytes: kept.reduce((sum, p) => sum + utf8Bytes(p), 0),
    returnedItems: kept.length,
  });
}
