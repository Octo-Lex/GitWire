// Custom repository-tool adapter for the Pi harness (RI-9 amendment,
// Phase 8, Commit 3).
//
// Maps Pi tool calls onto the ALREADY-QUALIFIED RepositoryTools v2 —
// semantics untouched, the envelope boundary and audit trace still apply:
//
//   pi read  → RepositoryTools.read   (exact blob at immutable HEAD)
//   pi grep  → RepositoryTools.grep   (tracked-tree text search)
//   pi find  → RepositoryTools.find   (tracked-path truth)
//   pi ls    → RepositoryTools.ls     (bounded directory listing)
//
// Contract distinctions survive verbatim into the model-facing JSON:
//   SUCCESS + complete=true
//   PARTIAL + complete=false + partialReasons
//   ERROR   + complete=false + error.code
// A partial zero-result can never be presented as "not found", and a tool
// error can never be presented as an empty success — the envelope boundary
// makes both shapes impossible to construct.
//
// Redaction: the model NEVER receives the repository session id, the
// session/worktree root, Git object-store paths, or any credential. It DOES
// receive the immutable evidence identity (headSha/snapshotRef, blobSha) —
// that is what RI-4 evidence references are built from.

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createRepositoryTools } from "../../repositoryTools/index.js";

/** Fixed search wall-clock budget — the model cannot widen it. */
export const HARNESS_GREP_TIMEOUT_MS = 10000;

/** Present a RepositoryTools envelope to the model with internals redacted. */
function presentResult(result) {
  const presented = {
    operation: result.operation,
    status: result.status,
    complete: result.complete,
    headSha: result.headSha,
    snapshotRef: result.snapshotRef ?? null,
    partialReasons: [...result.partialReasons],
    returnedBytes: result.returnedBytes,
    ...(result.returnedItems !== undefined ? { returnedItems: result.returnedItems } : {}),
  };
  if (result.data !== undefined) presented.data = result.data;
  if (result.error !== undefined) presented.error = { code: result.error.code, message: result.error.message };
  return presented;
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(presentResult(result)) }],
    details: {
      envelopeStatus: result.status,
      complete: result.complete,
      ...(result.error ? { errorCode: result.error.code } : {}),
      ...(result.partialReasons.length ? { partialReasons: [...result.partialReasons] } : {}),
    },
  };
}

function piTool(name, label, description, parameters, invoke) {
  return defineTool({
    name,
    label,
    description,
    parameters,
    execute: async (_toolCallId, params) => toolResult(await invoke(params)),
  });
}

/**
 * Build the four Pi custom tools bound to one repository session.
 *
 * @param {object} input
 * @param {object} input.repositorySession a prepareRepository() session
 * @returns {{tools: Array, repositoryTools: object}}
 */
export function createPiRepositoryTools({ repositorySession }) {
  if (!repositorySession || typeof repositorySession.recordOperation !== "function") {
    throw new Error("createPiRepositoryTools requires a repository session");
  }
  const repositoryTools = createRepositoryTools(repositorySession);

  const tools = [
    piTool(
      "read",
      "Read repository file",
      "Read an exact byte range of a tracked file at the immutable review HEAD. Returns blobSha, startLine/endLine, totalLines, content, and continuation nextOffset when the window is partial.",
      Type.Object({
        path: Type.String({ description: "repository-relative path" }),
        offset: Type.Optional(Type.Integer({ description: "1-based starting line (default 1)" })),
        limit: Type.Optional(Type.Integer({ description: "max lines returned (default 2000)" })),
      }),
      (p) => repositoryTools.read(p)
    ),
    piTool(
      "grep",
      "Search repository text",
      "Search tracked text content at the immutable review HEAD (binary files are skipped as a class). Zero matches with complete=true is AUTHORITATIVE absence in scope; complete=false means unknown — never treat it as not-found.",
      Type.Object({
        pattern: Type.String({ description: "search text or POSIX ERE" }),
        path: Type.Optional(Type.String({ description: "scope to a tracked file or directory prefix" })),
        glob: Type.Optional(Type.String({ description: "path filter, e.g. *.js or src/**/*.ts" })),
        literal: Type.Optional(Type.Boolean({ description: "treat pattern as fixed text (default false)" })),
        ignoreCase: Type.Optional(Type.Boolean({ description: "case-insensitive (default false)" })),
        context: Type.Optional(Type.Integer({ description: "context lines around each match (0-50)" })),
        limit: Type.Optional(Type.Integer({ description: "max returned matches (default 200)" })),
      }),
      (p) => repositoryTools.grep({ ...p, timeoutMs: HARNESS_GREP_TIMEOUT_MS })
    ),
    piTool(
      "find",
      "Find tracked paths",
      "List tracked repository paths at the immutable review HEAD, optionally filtered by glob. Never searches file contents; untracked files do not exist here.",
      Type.Object({
        glob: Type.Optional(Type.String({ description: "path filter (no '/' matches basenames at any depth)" })),
        limit: Type.Optional(Type.Integer({ description: "max returned paths (default 500)" })),
      }),
      (p) => repositoryTools.find(p)
    ),
    piTool(
      "ls",
      "List directory",
      "List one directory level of the immutable review HEAD tree with entry types and blob identities.",
      Type.Object({
        path: Type.Optional(Type.String({ description: "directory path (default repository root)" })),
        limit: Type.Optional(Type.Integer({ description: "max returned entries (default 500)" })),
      }),
      (p) => repositoryTools.ls(p)
    ),
  ];

  return { tools, repositoryTools };
}
