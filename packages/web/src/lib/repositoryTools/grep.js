// RepositoryTools v2 — `grep` (RI-9 amendment, Phase 3.2).
//
// Text search over the immutable tracked tree at HEAD via `git grep`:
//   - binary files are skipped as a semantic class (-I), so an oversized or
//     binary blob can never terminate the search or manufacture absence —
//     the banner.png failure class is structurally eliminated;
//   - search cost is bounded by wall-clock/process budget, NEVER by an
//     "inspected source bytes" allowance;
//   - returned-match count and returned output bytes are bounded, and
//     hitting either bound makes the result PARTIAL with matches-so-far;
//   - exit 1 (genuine zero matches) is SUCCESS/complete/[] — authoritative
//     absence within the declared scope;
//   - timeout/cancellation with zero parsed matches is PARTIAL [] — never
//     "No matches found".

import { makeResult, utf8Bytes, ERROR_CODES } from "./contract.js";
import { validateRepoPath } from "./repositorySession.js";
import { loadTrackedIndex, matchesGlob, validateGlob, intParam, scopeContains } from "./toolShared.js";
import { boundItems } from "./truncation.js";

export const DEFAULT_GREP_LIMIT = 200;
export const DEFAULT_GREP_MAX_OUTPUT_BYTES = 131072;
export const DEFAULT_GREP_TIMEOUT_MS = 10000;

/** Parse one output line against the tracked index; fail loud, never guess. */
function parseGrepLine(line, prefix, index) {
  let rest = line;
  if (line.startsWith(prefix)) {
    rest = line.slice(prefix.length);
  }
  if (rest === "--") return { separator: true };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== ":" && rest[i] !== "-") continue;
    const sep = rest[i];
    const lineNoMatch = rest.slice(i + 1).match(/^(\d+)([:-])(.*)$/);
    if (!lineNoMatch || lineNoMatch[2] !== sep) continue;
    const candidatePath = rest.slice(0, i);
    if (!index.has(candidatePath)) continue;
    return {
      path: candidatePath,
      line: parseInt(lineNoMatch[1], 10),
      text: lineNoMatch[3],
      kind: sep === ":" ? "match" : "context",
    };
  }
  return null;
}

/**
 * @param {object} session repository session
 * @param {object} params
 * @param {string} params.pattern search text (literal) or POSIX ERE
 * @param {string} [params.path] scope to a tracked file or directory prefix
 * @param {string} [params.glob] git-wildmatch-style path filter
 * @param {boolean} [params.literal] treat pattern as fixed string (default false)
 * @param {boolean} [params.ignoreCase] case-insensitive match
 * @param {number} [params.context] context lines around each match
 * @param {number} [params.limit] max returned matches (default 200)
 * @param {number} [params.maxOutputBytes] max returned output bytes
 * @param {number} [params.timeoutMs] wall-clock search budget (default 10s)
 * @param {AbortSignal} [params.signal] cooperative cancellation
 * @returns {Promise<object>} frozen tool-result envelope
 */
export async function grep(session, params) {
  const startedAt = performance.now();
  session.assertOpen();
  const errorResult = (code, message) =>
    makeResult({ operation: "grep", session, status: "error", startedAt, error: { code, message } });
  const pattern = params?.pattern;
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 8192) {
    return makeResult({
      operation: "grep", session, status: "error", startedAt,
      error: { code: ERROR_CODES.PATTERN_INVALID, message: "pattern must be a non-empty string" },
    });
  }
  const literal = params?.literal === true;
  const ignoreCase = params?.ignoreCase === true;
  const context = params?.context === undefined || params?.context === null ? 0 : intParam(params.context, 0, { min: 0, max: 50 });
  const limit = intParam(params?.limit, DEFAULT_GREP_LIMIT);
  const maxOutputBytes = intParam(params?.maxOutputBytes, DEFAULT_GREP_MAX_OUTPUT_BYTES);
  const timeoutMs = intParam(params?.timeoutMs, DEFAULT_GREP_TIMEOUT_MS, { min: 1 });
  const signal = params?.signal ?? undefined;

  let scopePath = null;
  if (params?.path !== undefined && params?.path !== null) {
    try {
      scopePath = validateRepoPath(params.path);
    } catch (err) {
      return errorResult(ERROR_CODES.PATH_ESCAPE, err.message);
    }
  }
  let glob = null;
  if (params?.glob !== undefined && params?.glob !== null) {
    try {
      glob = validateGlob(params.glob);
    } catch (err) {
      return errorResult(ERROR_CODES.SCOPE_INVALID, err.message);
    }
  }

  const index = await loadTrackedIndex(session);

  if (scopePath && !index.has(scopePath)) {
    const asDir = [...index.keys()].some((p) => scopeContains(scopePath, p));
    if (!asDir) {
      return makeResult({
        operation: "grep", session, status: "error", startedAt,
        error: { code: ERROR_CODES.SCOPE_INVALID, message: `scope path is not tracked at HEAD: ${scopePath}` },
      });
    }
  }

  // Divergence handling (snapshot mode): binary-kind divergent blobs are
  // excluded from the search pathspecs (deterministic even though -I would
  // skip them); text-kind divergent blobs inside the declared scope make
  // absence unprovable — the result stays partial with unfaithful_scope.
  const partialReasons = [];
  const skippedUnfaithful = [];
  const skippedBinary = [];
  const pathspecs = [];
  if (scopePath) pathspecs.push(scopePath);
  if (glob) pathspecs.push(`:(glob)${glob}`);
  if (session.mode === "snapshot") {
    for (const divergent of session.identityReport.divergent) {
      const inScope = scopeContains(scopePath, divergent.path) && (glob ? matchesGlob(divergent.path, glob) : true);
      if (!inScope) continue;
      pathspecs.push(`:(exclude)${divergent.path}`);
      if (divergent.kind === "binary") {
        skippedBinary.push(divergent.path);
        skippedUnfaithful.push(divergent.path);
      } else {
        skippedUnfaithful.push(divergent.path);
        partialReasons.push("unfaithful_scope");
      }
    }
  }

  const args = [
    "grep", "-n", "-I",
    literal ? "-F" : "-E",
    ...(ignoreCase ? ["-i"] : []),
    ...(context > 0 ? ["-C", String(context)] : []),
    "-e", pattern,
    session.headSha,
    "--",
    ...pathspecs,
  ];

  const res = await session.run(args, {
    timeoutMs,
    signal,
    maxCaptureBytes: Math.max(maxOutputBytes * 4, 4 * 1024 * 1024),
  });

  const prefix = `${session.headSha}:`;

  if (res.code >= 2 && !res.timedOut && !res.cancelled && !res.stdoutCapped) {
    if (/fatal:.*(unmatched|invalid|regex)|unmatched \(/i.test(res.stderr)) {
      return errorResult(ERROR_CODES.PATTERN_INVALID, `invalid pattern: ${res.stderr.trim()}`);
    }
    return errorResult(ERROR_CODES.BACKEND_FAILED, `git grep failed (${res.code}): ${res.stderr.trim()}`);
  }

  if (res.code === 1 && !res.timedOut && !res.cancelled && !res.stdoutCapped) {
    // Genuine zero matches in the declared scope: authoritative absence.
    return makeResult({
      operation: "grep", session, status: partialReasons.length ? "partial" : "success", startedAt,
      partialReasons,
      data: {
        matches: [],
        scope: { path: scopePath, glob },
        skippedBinary,
        skippedUnfaithful,
      },
      returnedBytes: 0,
      returnedItems: 0,
    });
  }

  if (res.timedOut) partialReasons.push("timeout");
  if (res.cancelled) partialReasons.push("cancelled");
  if (res.stdoutCapped) partialReasons.push("output_bytes");

  let rawLines = res.stdout.toString("utf8").split("\n");
  // A killed process can leave a half-written final line — drop it.
  if ((res.timedOut || res.cancelled || res.stdoutCapped) && rawLines.length > 0) {
    rawLines = rawLines.slice(0, -1);
  }

  const matches = [];
  const inDeclaredScope = (pathname) =>
    scopeContains(scopePath, pathname) && (glob ? matchesGlob(pathname, glob) : true);
  // Context attachment: with -C, git prints context lines around each match
  // and merges adjacent groups without separators. A context line after a
  // match is its after-context; a context line before the next match is that
  // match's before-context; a line between two matches is both.
  let pendingBefore = [];
  let currentMatch = null;
  for (const raw of rawLines) {
    if (!raw) continue;
    const parsed = parseGrepLine(raw, prefix, index);
    if (parsed === null) {
      return errorResult(ERROR_CODES.PARSE_FAILED, `unparseable git grep line: ${raw.slice(0, 200)}`);
    }
    if (parsed.separator) {
      pendingBefore = [];
      currentMatch = null;
      continue;
    }
    if (!inDeclaredScope(parsed.path)) continue;
    if (parsed.kind === "match") {
      currentMatch = {
        path: parsed.path,
        line: parsed.line,
        text: parsed.text,
        ...(context > 0 ? { context: pendingBefore.slice() } : {}),
      };
      pendingBefore = [];
      matches.push(currentMatch);
    } else if (context > 0) {
      const contextLine = { line: parsed.line, text: parsed.text };
      if (currentMatch) currentMatch.context.push(contextLine);
      pendingBefore.push(contextLine);
    }
  }

  const weigh = (m) => utf8Bytes(m.path) + String(m.line).length + 1 + utf8Bytes(m.text) +
    (m.context ?? []).reduce((sum, c) => sum + utf8Bytes(c.text) + String(c.line).length + 2, 0);
  const bounded = boundItems({ items: matches, limit, maxBytes: maxOutputBytes, weigh });
  partialReasons.push(...bounded.partialReasons);

  const uniqueReasons = [...new Set(partialReasons)];
  return makeResult({
    operation: "grep", session,
    status: uniqueReasons.length ? "partial" : "success",
    startedAt,
    partialReasons: uniqueReasons,
    data: {
      matches: bounded.kept,
      scope: { path: scopePath, glob },
      skippedBinary,
      skippedUnfaithful,
      truncated: bounded.truncated,
      truncatedBy: bounded.truncatedBy,
      droppedMatches: bounded.dropped,
    },
    returnedBytes: bounded.outputBytes,
    returnedItems: bounded.kept.length,
  });
}
