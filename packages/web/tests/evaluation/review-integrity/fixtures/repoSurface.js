// tests/evaluation/review-integrity/fixtures/repoSurface.js
// Loader for the faithful repository-surface snapshots (RI-9 evaluation
// integrity correction).
//
// Surfaces live in snapshots/repos/:
//   <repoKey>-<sha>.tree.json — the ACTUAL full recursive tree at that commit
//   <repoKey>-blobs.json      — deduped UTF-8 text blobs (blob sha → content)
//
// Semantics enforced here:
//   path in tree + blob stored        → serve real content
//   path in tree + blob NOT stored    → FIXTURE GAP (size cap / binary) —
//                                        the run is invalid; NEVER report
//                                        not_found to the reviewer
//   path not in tree                  → genuine repository 404

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = path.join(__dirname, "snapshots", "repos");

/** Distinctive error for a snapshot-coverage hole. Harnesses must mark the
 *  evaluation run invalid when one occurs. */
export class FixtureGapError extends Error {
  constructor(message) {
    super("FIXTURE GAP: " + message);
    this.name = "FixtureGapError";
    this.fixtureGap = true;
  }
}

const _treeCache = new Map(); // `${repoKey}:${sha}` → Map(path → entry) | null
const _blobCache = new Map(); // repoKey → Map(blobSha → text) | null
const _treeShaIndex = new Map(); // `${repoKey}:${sha}` → Set(blobSha) | null

function loadTree(repoKey, sha) {
  const key = repoKey + ":" + sha;
  if (_treeCache.has(key)) return _treeCache.get(key);
  const file = path.join(REPOS_DIR, `${repoKey}-${sha}.tree.json`);
  if (!fs.existsSync(file)) {
    _treeCache.set(key, null);
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = new Map();
  const shas = new Set();
  for (const entry of parsed.tree || []) {
    map.set(entry.path, entry);
    shas.add(entry.sha);
  }
  _treeCache.set(key, map);
  _treeShaIndex.set(key, shas);
  return map;
}

function loadBlobs(repoKey) {
  if (_blobCache.has(repoKey)) return _blobCache.get(repoKey);
  const file = path.join(REPOS_DIR, `${repoKey}-blobs.json`);
  if (!fs.existsSync(file)) {
    _blobCache.set(repoKey, null);
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  _blobCache.set(repoKey, new Map(Object.entries(parsed)));
  return _blobCache.get(repoKey);
}

/**
 * Whether a faithful surface exists for the given repo+sha.
 * When false, the fixture falls back to the legacy curated-only surface
 * (used by old deterministic tests that never read outside the bundle).
 */
export function hasSurface(repoKey, sha) {
  return loadTree(repoKey, sha) !== null;
}

/**
 * Resolve a repository path at a sha against the faithful surface.
 *
 * @returns {{ status: "served", content: string, blobSha: string, size: number }
 *          | { status: "not_found" }
 *          | { status: "gap" }}
 */
export function resolveSurfacePath(repoKey, sha, pathname) {
  const tree = loadTree(repoKey, sha);
  if (!tree) return { status: "not_found" };
  const entry = tree.get(pathname);
  if (!entry) return { status: "not_found" };
  const blobs = loadBlobs(repoKey);
  const content = blobs ? blobs.get(entry.sha) : undefined;
  if (content === undefined) {
    return { status: "gap", path: pathname, sha, blobSha: entry.sha, size: entry.size };
  }
  return { status: "served", content, blobSha: entry.sha, size: entry.size };
}

/**
 * Serve a git blob by sha against the faithful surface.
 * @returns {{ status: "served", content: string } | { status: "unknown" } | { status: "gap" }}
 */
export function resolveSurfaceBlob(repoKey, sha, blobSha) {
  const tree = loadTree(repoKey, sha);
  if (!tree) return { status: "unknown" };
  const shas = _treeShaIndex.get(repoKey + ":" + sha);
  const blobs = loadBlobs(repoKey);
  const content = blobs ? blobs.get(blobSha) : undefined;
  if (content !== undefined) return { status: "served", content };
  if (shas && shas.has(blobSha)) {
    return { status: "gap", path: "(blob " + blobSha.slice(0, 10) + ")", sha, blobSha, size: -1 };
  }
  return { status: "unknown" };
}

/** Full tree listing at a sha (for git/trees/{sha}?recursive=1), or null. */
export function surfaceTree(repoKey, sha) {
  const tree = loadTree(repoKey, sha);
  if (!tree) return null;
  return [...tree.entries()].map(([p, e]) => ({ path: p, type: "blob", sha: e.sha, size: e.size, mode: "100644" }));
}

/** Derive the surface repoKey from a fixture's source metadata. */
export function repoKeyForFixture(fixture) {
  const repo = fixture?.source?.repo || "";
  return repo.includes("AlCode") ? "alcode" : "gitwire";
}
