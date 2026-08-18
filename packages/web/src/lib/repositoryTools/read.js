// RepositoryTools v2 — `read` (RI-9 amendment, Phase 3.1).
//
// Reads the exact blob at the immutable HEAD tree entry for a path — never
// the live worktree. Returns blob identity, line windowing with explicit
// completeness, and continuation. A snapshot whose recorded blob is not
// faithfully recoverable fails closed (E_UNFAITHFUL_BLOB), never fake
// content.

import { makeResult, utf8Bytes, ERROR_CODES } from "./contract.js";
import { validateRepoPath } from "./repositorySession.js";
import { loadTrackedIndex, intParam } from "./toolShared.js";
import { windowTextLines } from "./truncation.js";

export const DEFAULT_READ_LIMIT = 2000;
export const DEFAULT_READ_MAX_BYTES = 65536;

const BINARY_SNIFF_BYTES = 8000;

function isBinaryBuffer(buf) {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Split content into lines; a trailing newline does not create a phantom line. */
export function splitLines(content) {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * @param {object} session repository session
 * @param {object} params
 * @param {string} params.path repository-relative path (required)
 * @param {number} [params.offset] 1-based starting line (default 1)
 * @param {number} [params.limit] max lines returned (default 2000)
 * @param {number} [params.maxBytes] max UTF-8 bytes of returned content
 * @returns {Promise<object>} frozen tool-result envelope
 */
export async function read(session, params) {
  const startedAt = performance.now();
  session.assertOpen();
  let pathname;
  try {
    pathname = validateRepoPath(params?.path);
  } catch (err) {
    return makeResult({
      operation: "read", session, status: "error", startedAt,
      error: { code: ERROR_CODES.PATH_ESCAPE, message: err.message },
    });
  }
  const offset = intParam(params?.offset, 1);
  const limit = intParam(params?.limit, DEFAULT_READ_LIMIT);
  const maxBytes = intParam(params?.maxBytes, DEFAULT_READ_MAX_BYTES);

  const index = await loadTrackedIndex(session);
  const entry = index.get(pathname);
  if (!entry) {
    const isDir = [...index.keys()].some((p) => p.startsWith(pathname + "/"));
    return makeResult({
      operation: "read", session, status: "error", startedAt,
      error: {
        code: isDir ? ERROR_CODES.PATH_IS_DIRECTORY : ERROR_CODES.PATH_NOT_FOUND,
        message: isDir ? `path is a directory: ${pathname}` : `path not tracked at HEAD: ${pathname}`,
      },
    });
  }
  if (entry.type === "tree") {
    return makeResult({
      operation: "read", session, status: "error", startedAt,
      error: { code: ERROR_CODES.PATH_IS_DIRECTORY, message: `path is a directory: ${pathname}` },
    });
  }

  if (session.mode === "snapshot" && session.identityReport.divergent.some((d) => d.path === pathname)) {
    return makeResult({
      operation: "read", session, status: "error", startedAt,
      error: {
        code: ERROR_CODES.UNFAITHFUL_BLOB,
        message: `snapshot blob for ${pathname} is not faithfully recoverable; content is unavailable and its absence/presence semantics fail closed`,
      },
    });
  }

  const blob = await session.run(["cat-file", "blob", entry.sha]);
  if (blob.code !== 0) {
    return makeResult({
      operation: "read", session, status: "error", startedAt,
      error: { code: ERROR_CODES.BACKEND_FAILED, message: `cat-file failed for ${pathname}: ${blob.stderr}` },
    });
  }
  const buf = blob.stdout;

  if (entry.mode === "120000") {
    return makeResult({
      operation: "read", session, status: "success", startedAt,
      data: { path: pathname, kind: "symlink", blobSha: entry.sha, target: buf.toString("utf8"), byteSize: buf.length },
      returnedBytes: buf.length, returnedItems: 1,
    });
  }

  if (isBinaryBuffer(buf)) {
    return makeResult({
      operation: "read", session, status: "success", startedAt,
      data: { path: pathname, kind: "binary", blobSha: entry.sha, byteSize: buf.length },
      returnedBytes: 0, returnedItems: 0,
    });
  }

  const lines = splitLines(buf.toString("utf8"));
  const windowed = windowTextLines({ lines, offset, limit, maxBytes, totalBytes: buf.length });

  return makeResult({
    operation: "read", session,
    status: windowed.complete ? "success" : "partial",
    startedAt,
    partialReasons: windowed.complete ? [] : [windowed.truncation.truncatedBy],
    data: {
      path: pathname,
      kind: "text",
      blobSha: entry.sha,
      startLine: windowed.startLine,
      endLine: windowed.endLine,
      totalLines: windowed.truncation.totalLines,
      totalBytes: buf.length,
      content: windowed.content,
      nextOffset: windowed.nextOffset,
      truncation: windowed.truncation,
    },
    returnedBytes: utf8Bytes(windowed.content),
    returnedItems: windowed.outputLines,
  });
}
