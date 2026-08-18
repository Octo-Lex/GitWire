// Shared repository-tool presenters for the Phase 9 A/B (RI-9 amendment).
//
// Both arms must derive repository truth from the SAME RepositoryTools v2
// substrate with IDENTICAL model-facing presentation: this module is the
// single source. The Pi arm keeps its TypeBox defineTool wrappers
// (piRepositoryTools.js, signed off in Phase 8); Arm A (CurrentGitWire)
// uses the JSON-schema descriptors and executors here. Both produce the
// exact same presentResult JSON for the same underlying call.

import { createRepositoryTools } from "../../repositoryTools/index.js";

/** Fixed search wall-clock budget — identical in both arms. */
export const HARNESS_GREP_TIMEOUT_MS = 10000;

/** Present a RepositoryTools envelope to the model with internals redacted.
 *  Semantics are byte-identical to the Phase 8 Pi adapter. */
export function presentResult(result) {
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

/**
 * JSON-schema tool descriptors (pi-ai Tool shape) matching the Pi arm's
 * tools one-for-one: same names, same parameters, same descriptions.
 */
export function repositoryToolDescriptors() {
  return [
    {
      name: "read",
      description: "Read an exact byte range of a tracked file at the immutable review HEAD. Returns blobSha, startLine/endLine, totalLines, content, and continuation nextOffset when the window is partial.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "repository-relative path" },
          offset: { type: "integer", description: "1-based starting line (default 1)" },
          limit: { type: "integer", description: "max lines returned (default 2000)" },
        },
        required: ["path"],
      },
    },
    {
      name: "grep",
      description: "Search tracked text content at the immutable review HEAD (binary files are skipped as a class). Zero matches with complete=true is AUTHORITATIVE absence in scope; complete=false means unknown — never treat it as not-found.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "search text or POSIX ERE" },
          path: { type: "string", description: "scope to a tracked file or directory prefix" },
          glob: { type: "string", description: "path filter, e.g. *.js or src/**/*.ts" },
          literal: { type: "boolean", description: "treat pattern as fixed text (default false)" },
          ignoreCase: { type: "boolean", description: "case-insensitive (default false)" },
          context: { type: "integer", description: "context lines around each match (0-50)" },
          limit: { type: "integer", description: "max returned matches (default 200)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "find",
      description: "List tracked repository paths at the immutable review HEAD, optionally filtered by glob. Never searches file contents; untracked files do not exist here.",
      parameters: {
        type: "object",
        properties: {
          glob: { type: "string", description: "path filter (no '/' matches basenames at any depth)" },
          limit: { type: "integer", description: "max returned paths (default 500)" },
        },
      },
    },
    {
      name: "ls",
      description: "List one directory level of the immutable review HEAD tree with entry types and blob identities.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "directory path (default repository root)" },
          limit: { type: "integer", description: "max returned entries (default 500)" },
        },
      },
    },
  ];
}

/**
 * Bind executors to a repository session. Each executor applies the same
 * fixed grep timeout as the Pi arm and returns the presented JSON string.
 */
export function createRepositoryToolExecutors(repositorySession) {
  const repositoryTools = createRepositoryTools(repositorySession);
  return {
    repositoryTools,
    executors: {
      read: async (p) => presentResult(await repositoryTools.read(p)),
      grep: async (p) => presentResult(await repositoryTools.grep({ ...p, timeoutMs: HARNESS_GREP_TIMEOUT_MS })),
      find: async (p) => presentResult(await repositoryTools.find(p)),
      ls: async (p) => presentResult(await repositoryTools.ls(p)),
    },
  };
}
