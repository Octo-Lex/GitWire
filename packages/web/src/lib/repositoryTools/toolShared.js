// Shared utilities for the RepositoryTools v2 primitives (RI-9 amendment,
// Phase 3). All repository truth comes from the immutable Git tree at the
// session HEAD — never from live filesystem traversal — so a dirty worktree
// or an untracked file cannot silently change what the reviewer observes.

import { RepositorySessionError } from "./repositorySession.js";

const trackedIndexCache = new WeakMap();

/**
 * Load (and cache per session) the full tracked path index at HEAD:
 * Map(path → {sha, mode, type}) from `git ls-tree -r <headSha>`.
 */
export async function loadTrackedIndex(session) {
  const cached = trackedIndexCache.get(session);
  if (cached) return cached;
  const res = await session.run(["ls-tree", "-r", session.headSha]);
  if (res.code !== 0) {
    throw new RepositorySessionError("E_BACKEND_FAILED", `ls-tree failed: ${res.stderr}`);
  }
  const index = new Map();
  for (const line of res.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = line.match(/^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/);
    if (!match) {
      throw new RepositorySessionError("E_BACKEND_FAILED", `unparseable ls-tree line: ${line}`);
    }
    index.set(match[4], { sha: match[3], mode: match[1], type: match[2] });
  }
  trackedIndexCache.set(session, index);
  return index;
}

/** Does a scope path contain a tracked path? Exact file, or directory prefix. */
export function scopeContains(scopePath, pathname) {
  if (!scopePath) return true;
  if (scopePath === pathname) return true;
  return pathname.startsWith(scopePath.endsWith("/") ? scopePath : scopePath + "/");
}

/**
 * Compile a glob to a RegExp with git-wildmatch-style semantics:
 *   '*'  matches within one path segment (never '/')
 *   '?'  matches one non-'/' character
 *   '**' as a whole segment matches zero or more path segments
 *   a glob containing '/' anchors at the repository root;
 *   a glob without '/' matches the basename at any depth
 */
export function globToRegExp(glob) {
  const segments = glob.split("/");
  let source = glob.includes("/") ? "^" : "^(?:[^/]+/)*";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") {
      source += "(?:[^/]+/)*";
      return;
    }
    source += segment.replace(/[.*+?^${}()|[\]\\]/g, (ch) => {
      if (ch === "*") return "[^/]*";
      if (ch === "?") return "[^/]";
      return "\\" + ch;
    });
    if (!last) source += "/";
  });
  return new RegExp(source + "$");
}

export function matchesGlob(pathname, glob) {
  return globToRegExp(glob).test(pathname);
}

/** Validate a user-supplied glob: repo-relative, no traversal segments. */
export function validateGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > 1024) {
    throw new RepositorySessionError("E_INVALID_INPUT", `invalid glob: ${JSON.stringify(glob)}`);
  }
  if (glob.includes("\\") || glob.startsWith("/")) {
    throw new RepositorySessionError("E_INVALID_INPUT", `glob must be repository-relative: ${glob}`);
  }
  for (const segment of glob.split("/")) {
    if (segment === ".." || segment === "." || segment === "") {
      throw new RepositorySessionError("E_INVALID_INPUT", `glob segment rejected: ${glob}`);
    }
  }
  return glob;
}

/** Validate an integer parameter with a default and minimum. */
export function intParam(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RepositorySessionError("E_INVALID_INPUT", `parameter out of range: ${value}`);
  }
  return value;
}
