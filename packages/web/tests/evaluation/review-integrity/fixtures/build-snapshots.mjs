#!/usr/bin/env node
/**
 * build-snapshots.mjs — Fetch and store exact fixture data for review-integrity tests.
 *
 * Snapshots capture the EXACT data (changed-file patches + context-file contents)
 * from real Git commits and GitHub APIs for the four review-integrity fixtures
 * (RI-01, RI-02, RI-03, RI-04). Each fixture has a "broken" and "fixed" variant.
 *
 * Idempotent: if a snapshot JSON file already exists, fetching is skipped.
 *
 * Data sources:
 *   - RI-01 / RI-02: GitHub API for AgentGears/AlCode PR #2 (via `gh` CLI)
 *       broken  base dd07fb2  -> head 0181b19f00dc
 *       fixed   base 0181b19  -> head 20219bd384
 *   - RI-03: local git for GitWire PR #123
 *       broken  base 5f48600  -> head ef071ff
 *       fixed   base 5f48600  -> head 67908f7
 *   - RI-04: local git for GitWire PR #124
 *       broken  base b8ccfb8  -> head 624732c
 *       fixed   base b8ccfb8  -> head a32a07e
 *
 * Output JSON shape per snapshot:
 *   {
 *     caseId, variant, source,
 *     prMetadata: { title, body, head, base, author },
 *     changedFiles: [{ filename, status, additions, deletions, patch, sha }],
 *     contextFiles: [{ path, sha, content }]
 *   }
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAPSHOTS_DIR = join(__dirname, "snapshots");

const GITWIRE_REPO_ROOT = "C:\\Next-Era\\GitWire";
const ALCODE_REPO = "AgentGears/AlCode";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Run a shell command synchronously and return stdout as a UTF-8 string. */
function run(cmd, opts = {}) {
  return execSync(cmd, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 64, // 64 MiB — patches can be large
    ...opts,
  }).toString("utf8");
}

/** Get the real Git blob SHA for a file at a given revision. */
function gitBlobSha(rev, path) {
  try {
    return run(`git -C "${GITWIRE_REPO_ROOT}" rev-parse "${rev}:${path}"`).trim();
  } catch (_e) {
    return null; // file doesn't exist at this revision
  }
}

/** Get the real GitHub blob SHA for an AlCode file via gh api. */
function ghBlobSha(repo, path, ref) {
  try {
    const sha = run(`gh api "repos/${repo}/contents/${path}?ref=${ref}" --jq ".sha"`).trim();
    return sha || null;
  } catch (_e) {
    return null;
  }
}

/** Map a git `--name-status` letter to a GitHub-style status word. */
function gitStatusLetterToWord(letter) {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "modified"; // type-change — treat as modified for our purposes
    default:
      return "modified";
  }
}

/** Parse `git diff --name-status A..B` output into [{ status, filename }]. */
function parseGitNameStatus(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Format: "<LETTER>\t<path>" or "R100\t<old>\t<new>" (rename)
      const parts = line.split("\t");
      if (line.startsWith("R") || line.startsWith("C")) {
        const code = parts[0];
        const letter = code.charAt(0);
        const newPath = parts[2] || parts[1];
        return { status: gitStatusLetterToWord(letter), filename: newPath };
      }
      const letter = parts[0].charAt(0);
      return { status: gitStatusLetterToWord(letter), filename: parts[1] };
    });
}

/** Parse `git diff --numstat A..B` into { [filename]: { additions, deletions } }. */
function parseGitNumstat(text) {
  const map = new Map();
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      // Format: "<add>\t<del>\t<path>"
      const parts = line.split("\t");
      const adds = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
      const dels = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
      const path = parts.slice(2).join("\t");
      map.set(path, { additions: adds, deletions: dels });
    });
  return map;
}

/**
 * Strip git diff headers to match GitHub's PR-file patch representation.
 * GitHub's GET /pulls/{n}/files[].patch starts at the @@ hunk header,
 * not at the `diff --git` line. This makes the stored patch byte-equivalent
 * to what the real fetchDiff() would receive from the GitHub API.
 */
function toGitHubPatch(rawDiff) {
  const lines = rawDiff.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  if (hunkStart === -1) return rawDiff; // no hunks (binary, etc.)
  return lines.slice(hunkStart).join("\n");
}

/** Build changedFiles[] from a local git diff range, with real blob SHAs and head/base content. */
function gitChangedFiles(base, head) {
  const nameStatus = run(
    `git -C "${GITWIRE_REPO_ROOT}" diff --name-status ${base}..${head}`
  );
  const numstat = run(
    `git -C "${GITWIRE_REPO_ROOT}" diff --numstat ${base}..${head}`
  );
  const stats = parseGitNumstat(numstat);
  const entries = parseGitNameStatus(nameStatus);

  return entries.map(({ status, filename }) => {
    const rawPatch = run(
      `git -C "${GITWIRE_REPO_ROOT}" diff ${base}..${head} -- "${filename}"`,
      { maxBuffer: 1024 * 1024 * 64 }
    );
    const patch = toGitHubPatch(rawPatch);
    const counts = stats.get(filename) || { additions: 0, deletions: 0 };
    // Get real blob SHAs and file contents at base and head
    const headBlobSha = gitBlobSha(head, filename);
    const baseBlobSha = gitBlobSha(base, filename);
    let headContent = null;
    let baseContent = null;
    try { headContent = gitShow(head, filename); } catch (_e) { /* new file */ }
    try { baseContent = gitShow(base, filename); } catch (_e) { /* deleted file */ }
    return {
      filename,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
      sha: headBlobSha || baseBlobSha || "unknown",
      headBlobSha,
      baseBlobSha,
      headContent,
      baseContent,
    };
  });
}

/** Read a file from the local git repo at a specific revision. */
function gitShow(rev, path) {
  return run(`git -C "${GITWIRE_REPO_ROOT}" show "${rev}:${path}"`, {
    maxBuffer: 1024 * 1024 * 64,
  });
}

/** gh CLI: fetch the `.files` array from a compare call (AgentGears/AlCode). */
function ghCompareFiles(base, head) {
  const raw = run(
    `gh api repos/${ALCODE_REPO}/compare/${base}...${head} --jq ".files"`
  );
  return JSON.parse(raw);
}

/** gh CLI: fetch base64 content of a path at a revision, return decoded UTF-8. */
function ghContents(repo, path, ref) {
  const b64 = run(
    `gh api repos/${repo}/contents/${path}?ref=${ref} --jq ".content"`
  ).trim();
  // The content may contain newlines (GitHub pretty-prints); strip them before decoding.
  const clean = b64.replace(/\s+/g, "");
  return Buffer.from(clean, "base64").toString("utf-8");
}

/** gh CLI: get PR metadata (title, body, author login) for a PR number. */
function ghPrMeta(repo, prNumber) {
  const raw = run(
    `gh pr view ${prNumber} --repo ${repo} --json title,body,author`
  );
  const j = JSON.parse(raw);
  return {
    title: j.title || "",
    body: j.body || "",
    author: (j.author && j.author.login) || null,
  };
}

/**
 * Build a "normalised" changedFiles[] entry from a raw GitHub compare `files[]`
 * item. Preserves the real GitHub blob SHA and fetches head/base content.
 */
function normalizeGhFile(f, base, head) {
  // GitHub compare gives us the blob sha of the file at the head commit
  const sha = f.sha || null;
  return {
    filename: f.filename,
    status: f.status,
    additions: typeof f.additions === "number" ? f.additions : 0,
    deletions: typeof f.deletions === "number" ? f.deletions : 0,
    patch: typeof f.patch === "string" ? f.patch : "",
    sha: sha || "unknown",
    headBlobSha: sha,
    baseBlobSha: null, // populated by enrichGhFiles
    headContent: null, // populated by enrichGhFiles
    baseContent: null,
  };
}

/** Enrich normalized GitHub files with head/base content and blob SHAs from the API. */
function enrichGhFiles(files, base, head, repo) {
  for (const f of files) {
    try { f.headContent = ghContents(repo, f.filename, head); } catch (_e) { /* new file */ }
    try { f.headBlobSha = ghBlobSha(repo, f.filename, head); } catch (_e) { /* keep existing */ }
    if (f.status !== "added") {
      try {
        f.baseContent = ghContents(repo, f.filename, base);
        f.baseBlobSha = ghBlobSha(repo, f.filename, base);
      } catch (_e) { /* removed */ }
    }
  }
  return files;
}

/** Write a snapshot file (idempotent: caller checks existence first). */
function writeSnapshot(name, payload) {
  if (!existsSync(SNAPSHOTS_DIR)) mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const path = join(SNAPSHOTS_DIR, name);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  console.log(`  wrote ${path}`);
}

/** Skip-with-message if the snapshot file already exists. */
function have(name) {
  const path = join(SNAPSHOTS_DIR, name);
  if (existsSync(path)) {
    console.log(`  skip (exists): ${path}`);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RI-01 / RI-02 — AgentGears/AlCode PR #2.
 *
 * Broken compare:  dd07fb2   -> 0181b19f00dc  (adds docs/roadmap.md, edits phase-0-spec.md)
 * Fixed  compare:  0181b19   -> 20219bd384    (reverts the doc churn cleanly)
 *
 * RI-01 is the "whole PR" view; RI-02 is a single-file slice.
 */

/**
 * RI-01 / RI-02 — AgentGears/AlCode PR #2.
 *
 * RI-01 and RI-02 are two expected findings against the SAME historical PR state.
 * Both broken fixtures use dd07fb2 → 0181b19 (the PR's first commit).
 * Both fixed fixtures use dd07fb2 → 20219bd (the PR's final merged state).
 * The changedFiles bundle is identical within each variant.
 * Context files differ per finding but do not change the review bundle.
 */

function buildAlcodeBroken() {
  const base = "dd07fb2";
  const head = "0181b19f00dc";

  if (have("ri01-broken.json") && have("ri02-broken.json")) return;

  console.log("  fetching PR #2 metadata, compare dd07fb2...0181b19, and context files...");
  const pr = ghPrMeta(ALCODE_REPO, 2);
  const rawFiles = ghCompareFiles(base, head);
  const files = enrichGhFiles(
    rawFiles.map((f) => normalizeGhFile(f, base, head)),
    base, head, ALCODE_REPO
  );

  // RI-01 and RI-02 share the SAME changedFiles bundle.
  // Context files differ per finding.

  // RI-01 context: README.md + constitution.md at base (the stale declarations)
  const ri01Context = [
    { path: "README.md", sha: ghBlobSha(ALCODE_REPO, "README.md", base) || base, content: ghContents(ALCODE_REPO, "README.md", base), refs: [base, head] },
    { path: "docs/constitution.md", sha: ghBlobSha(ALCODE_REPO, "docs/constitution.md", base) || base, content: ghContents(ALCODE_REPO, "docs/constitution.md", base), refs: [base, head] },
  ];

  // RI-02 context: phase-0-spec.md at base (the gate 0.5 definition lacking Agent-replacement assertion)
  const ri02Context = [
    { path: "docs/phase-0-spec.md", sha: ghBlobSha(ALCODE_REPO, "docs/phase-0-spec.md", base) || base, content: ghContents(ALCODE_REPO, "docs/phase-0-spec.md", base), refs: [base, head] },
  ];

  if (!have("ri01-broken.json")) {
    writeSnapshot("ri01-broken.json", {
      caseId: "RI-01", variant: "broken",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: { title: pr.title, body: pr.body, head, base, author: pr.author },
      changedFiles: files,
      contextFiles: ri01Context,
    });
  }

  if (!have("ri02-broken.json")) {
    writeSnapshot("ri02-broken.json", {
      caseId: "RI-02", variant: "broken",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: { title: pr.title, body: pr.body, head, base, author: pr.author },
      changedFiles: files, // SAME bundle as RI-01
      contextFiles: ri02Context,
    });
  }
}

function buildAlcodeFixed() {
  const base = "dd07fb2";
  const head = "20219bd384";

  if (have("ri01-fixed.json") && have("ri02-fixed.json")) return;

  console.log("  fetching PR #2 fixed compare dd07fb2...20219bd384...");
  const pr = ghPrMeta(ALCODE_REPO, 2);
  const rawFiles = ghCompareFiles(base, head);
  const files = enrichGhFiles(
    rawFiles.map((f) => normalizeGhFile(f, base, head)),
    base, head, ALCODE_REPO
  );

  // RI-01 and RI-02 fixed share the SAME full 4-file bundle.
  if (!have("ri01-fixed.json")) {
    writeSnapshot("ri01-fixed.json", {
      caseId: "RI-01", variant: "fixed",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: { title: pr.title, body: pr.body, head, base, author: pr.author },
      changedFiles: files,
      contextFiles: [],
    });
  }

  if (!have("ri02-fixed.json")) {
    writeSnapshot("ri02-fixed.json", {
      caseId: "RI-02", variant: "fixed",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: { title: pr.title, body: pr.body, head, base, author: pr.author },
      changedFiles: files, // SAME bundle as RI-01
      contextFiles: [],
    });
  }
}

/**
 * RI-03 — GitWire PR #123 (local git).
 *
 * Broken: 5f48600..ef071ff   (9 files)
 * Fixed:  5f48600..67908f7   (9 files)
 * Context: packages/web-dashboard/next.config.ts at 5f48600 (both variants).
 */

function gitwirePrMeta(base, head, label) {
  // GitWire PRs are local; synthesise prMetadata from the merge commits.
  // Author = committer of the head commit; title = subject line.
  const headInfo = run(
    `git -C "${GITWIRE_REPO_ROOT}" show -s --format="%an|%s" ${head}`
  ).trim();
  const [author, ...titleParts] = headInfo.split("|");
  const title = titleParts.join("|");
  return {
    title,
    body: `GitWire PR #${label} snapshot — base ${base}, head ${head}`,
    head,
    base,
    author,
  };
}

function buildRi03() {
  const base = "5f48600";
  const ctxPath = "packages/web-dashboard/next.config.ts";

  // Broken
  if (!have("ri03-broken.json")) {
    const head = "ef071ff";
    console.log(`  RI-03 broken: git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    const ctxSha = gitBlobSha(base, ctxPath);
    const ctx = gitShow(base, ctxPath);
    writeSnapshot("ri03-broken.json", {
      caseId: "RI-03", variant: "broken",
      source: { repo: "local/GitWire", pr: 123, base, head },
      prMetadata: gitwirePrMeta(base, head, 123),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: ctxSha || base, content: ctx, refs: [base, head] }],
    });
  }

  // Fixed
  if (!have("ri03-fixed.json")) {
    const head = "67908f7";
    console.log(`  RI-03 fixed:  git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    const ctxSha = gitBlobSha(base, ctxPath);
    const ctx = gitShow(base, ctxPath);
    writeSnapshot("ri03-fixed.json", {
      caseId: "RI-03", variant: "fixed",
      source: { repo: "local/GitWire", pr: 123, base, head },
      prMetadata: gitwirePrMeta(base, head, 123),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: ctxSha || base, content: ctx, refs: [base, head] }],
    });
  }
}

/**
 * RI-04 — GitWire PR #124 (local git).
 *
 * Broken: b8ccfb8..624732c   (3 files)
 * Fixed:  b8ccfb8..a32a07e   (5 files)
 * Context (broken only): packages/web/src/lib/commentMarkers.js at 624732c.
 */

function buildRi04() {
  const base = "b8ccfb8";
  const ctxPath = "packages/web/src/lib/commentMarkers.js";

  // Broken
  if (!have("ri04-broken.json")) {
    const head = "624732c";
    console.log(`  RI-04 broken: git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    const ctxSha = gitBlobSha(head, ctxPath);
    const ctx = gitShow(head, ctxPath); // unpaginated version at broken head
    writeSnapshot("ri04-broken.json", {
      caseId: "RI-04", variant: "broken",
      source: { repo: "local/GitWire", pr: 124, base, head },
      prMetadata: gitwirePrMeta(base, head, 124),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: ctxSha || head, content: ctx, refs: [base, head] }],
    });
  }

  // Fixed
  if (!have("ri04-fixed.json")) {
    const head = "a32a07e";
    console.log(`  RI-04 fixed:  git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    writeSnapshot("ri04-fixed.json", {
      caseId: "RI-04", variant: "fixed",
      source: { repo: "local/GitWire", pr: 124, base, head },
      prMetadata: gitwirePrMeta(base, head, 124),
      changedFiles: files,
      contextFiles: [],
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Faithful repository surfaces (RI-9 evaluation-integrity correction)
//
// The Context Broker performs arbitrary bounded reads/searches at the exact
// base/head SHAs. A curated contextFiles[] surface manufactures false 404s
// for every other path (RI-02 fixed proved this: the reviewer was told
// package.json / CI / gate scripts do not exist).
//
// Surface snapshots capture the ACTUAL immutable repository:
//   snapshots/repos/<repoKey>-<sha>.tree.json — full recursive tree
//     (path, blob sha, size) at that commit
//   snapshots/repos/<repoKey>-blobs.json — deduped UTF-8 text blobs
//     (blob sha → content) for text files ≤ MAX_BLOB_BYTES across all
//     captured SHAs of that repository
//
// A path present in the tree but whose blob is NOT stored (binary or above
// the size cap) is a FIXTURE GAP: the evaluation run must be invalidated,
// never served to the reviewer as not_found. A path absent from the tree is
// a genuine 404.
// ─────────────────────────────────────────────────────────────────────────────

const REPOS_DIR = join(SNAPSHOTS_DIR, "repos");
const MAX_BLOB_BYTES = 65536;

const TEXT_EXT = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".mdx",
  ".yml", ".yaml", ".sql", ".sh", ".bash", ".html", ".css", ".scss",
  ".txt", ".svg", ".xml", ".example", ".gitignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".lock", ".properties", ".conf", ".cfg", ".toml",
  ".gradle", ".kt", ".java", ".py", ".rb", ".go", ".rs", ".c", ".h",
  ".cpp", ".hpp", ".env", ".prettierrc", ".eslintrc", ".dockerfile",
]);

function isTextLikePath(pathname, size) {
  if (size > MAX_BLOB_BYTES) return false;
  const base = pathname.split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot === -1) return base.startsWith("."); // dotfiles like .gitignore
  return TEXT_EXT.has(base.slice(dot).toLowerCase());
}

/** Derive { repoKey → Set<sha> } from the 8 fixture snapshots. */
function collectSurfaceShas() {
  const byRepo = new Map();
  for (const name of [
    "ri01-broken.json", "ri01-fixed.json", "ri02-broken.json", "ri02-fixed.json",
    "ri03-broken.json", "ri03-fixed.json", "ri04-broken.json", "ri04-fixed.json",
  ]) {
    const p = join(SNAPSHOTS_DIR, name);
    if (!existsSync(p)) continue;
    const snap = JSON.parse(readFileSync(p, "utf8"));
    const repoKey = snap.source?.repo?.includes("AlCode") ? "alcode" : "gitwire";
    if (!byRepo.has(repoKey)) byRepo.set(repoKey, new Set());
    byRepo.get(repoKey).add(snap.prMetadata.base);
    byRepo.get(repoKey).add(snap.prMetadata.head);
  }
  return byRepo;
}

/** GitWire: full recursive tree at a local commit → [{ path, sha, size }]. */
function gitwireTree(sha) {
  const out = run(`git -C "${GITWIRE_REPO_ROOT}" ls-tree -r -l ${sha}`);
  return out.split("\n").filter(Boolean).map((line) => {
    const m = line.match(/^\d+ \w+ ([0-9a-f]+)\s+(\d+|-)\t(.+)$/);
    if (!m) return null;
    return { path: m[3], sha: m[1], size: m[2] === "-" ? 0 : parseInt(m[2], 10) };
  }).filter(Boolean);
}

/** GitWire: blob content by blob sha. */
function gitwireBlob(blobSha) {
  return run(`git -C "${GITWIRE_REPO_ROOT}" cat-file blob ${blobSha}`, {
    maxBuffer: MAX_BLOB_BYTES * 2,
  });
}

/** AlCode: full recursive tree via gh api. */
function alcodeTree(sha) {
  const raw = run(`gh api "repos/${ALCODE_REPO}/git/trees/${sha}?recursive=1" --jq ".tree"`);
  return JSON.parse(raw)
    .filter((e) => e.type === "blob")
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
}

/** AlCode: blob content by blob sha via gh api (base64 → UTF-8). */
function alcodeBlob(blobSha) {
  const b64 = run(`gh api "repos/${ALCODE_REPO}/git/blobs/${blobSha}" --jq ".content"`);
  const clean = b64.replace(/\s+/g, "");
  return Buffer.from(clean, "base64").toString("utf8");
}

/** Capture surfaces for one repository. Idempotent per output file. */
function buildRepoSurface(repoKey, shas) {
  if (!existsSync(REPOS_DIR)) mkdirSync(REPOS_DIR, { recursive: true });

  const blobStore = new Map(); // blob sha → utf8 text
  const blobPathIndex = new Map(); // blob sha → first path seen (for logs)

  for (const sha of shas) {
    const treeFile = join(REPOS_DIR, `${repoKey}-${sha}.tree.json`);
    if (existsSync(treeFile)) {
      console.log(`  skip (exists): ${treeFile}`);
      continue;
    }
    console.log(`  capturing ${repoKey} tree @ ${sha}...`);
    const tree = repoKey === "gitwire" ? gitwireTree(sha) : alcodeTree(sha);

    for (const entry of tree) {
      if (!isTextLikePath(entry.path, entry.size)) continue;
      if (blobStore.has(entry.sha)) continue;
      try {
        const text = repoKey === "gitwire" ? gitwireBlob(entry.sha) : alcodeBlob(entry.sha);
        if (text.includes("\0")) continue; // binary despite extension
        blobStore.set(entry.sha, text);
        blobPathIndex.set(entry.sha, entry.path);
      } catch (_e) {
        console.log(`    WARN: could not read blob ${entry.sha.slice(0, 10)} (${entry.path})`);
      }
    }

    writeFileSync(treeFile, JSON.stringify({ repo: repoKey, sha, tree }, null, 1), "utf8");
    console.log(`    wrote ${treeFile} (${tree.length} entries)`);
  }

  const blobsFile = join(REPOS_DIR, `${repoKey}-blobs.json`);
  if (!existsSync(blobsFile)) {
    console.log(`  writing ${blobsFile} (${blobStore.size} blobs)...`);
    writeFileSync(blobsFile, JSON.stringify(Object.fromEntries(blobStore)), "utf8");
  } else {
    console.log(`  skip (exists): ${blobsFile}`);
  }
}

function buildRepoSurfaces() {
  const byRepo = collectSurfaceShas();
  for (const [repoKey, shas] of byRepo) {
    buildRepoSurface(repoKey, [...shas]);
  }
}

// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const targets = [
    ["ri01-broken.json", "ri01-fixed.json"],
    ["ri02-broken.json", "ri02-fixed.json"],
    ["ri03-broken.json", "ri03-fixed.json"],
    ["ri04-broken.json", "ri04-fixed.json"],
  ];
  const allPresent = targets
    .flat()
    .every((name) => existsSync(join(SNAPSHOTS_DIR, name)));
  if (allPresent) {
    console.log("All 8 snapshot files already present.");
    console.log("[surfaces] Capturing repository surfaces (idempotent per file)...");
    buildRepoSurfaces();
    console.log("Done.");
    return;
  }

  console.log("Building review-integrity snapshots...");
  console.log("");
  console.log("[1/4] RI-01 + RI-02 (AlCode PR #2) — broken");
  buildAlcodeBroken();
  console.log("");
  console.log("[2/4] RI-01 + RI-02 (AlCode PR #2) — fixed");
  buildAlcodeFixed();
  console.log("");
  console.log("[3/4] RI-03 (GitWire PR #123)");
  buildRi03();
  console.log("");
  console.log("[4/4] RI-04 (GitWire PR #124)");
  buildRi04();
  console.log("");
  console.log("[surfaces] Capturing repository surfaces (idempotent per file)...");
  buildRepoSurfaces();
  console.log("");
  console.log("Done.");
}

main();
