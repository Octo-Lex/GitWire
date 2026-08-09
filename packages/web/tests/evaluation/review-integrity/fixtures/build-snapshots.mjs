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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/** Synthetic stable hash for a changed-file entry (deterministic, content-derived). */
function syntheticSha(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 40);
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

/** Build changedFiles[] from a local git diff range. */
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
    const patch = run(
      `git -C "${GITWIRE_REPO_ROOT}" diff ${base}..${head} -- "${filename}"`,
      { maxBuffer: 1024 * 1024 * 64 }
    );
    const counts = stats.get(filename) || { additions: 0, deletions: 0 };
    return {
      filename,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      patch,
      sha: syntheticSha(`${base}..${head}:${filename}:${patch}`),
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
 * item. We only keep the fields we need and synthesise a stable sha.
 */
function normalizeGhFile(f) {
  return {
    filename: f.filename,
    status: f.status,
    additions: typeof f.additions === "number" ? f.additions : 0,
    deletions: typeof f.deletions === "number" ? f.deletions : 0,
    patch: typeof f.patch === "string" ? f.patch : "",
    sha: syntheticSha(`${f.filename}:${f.sha || ""}:${f.patch || ""}`),
  };
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

function buildAlcodeBroken() {
  const base = "dd07fb2";
  const head = "0181b19f00dc";
  const name = "alcode-broken.json";
  if (have(name)) return;

  console.log("  fetching PR #2 metadata, compare, and context files...");
  const pr = ghPrMeta(ALCODE_REPO, 2);
  const files = ghCompareFiles(base, head).map(normalizeGhFile);

  const ri01 = {
    caseId: "RI-01",
    variant: "broken",
    source: { repo: ALCODE_REPO, pr: 2, base, head },
    prMetadata: {
      title: pr.title,
      body: pr.body,
      head,
      base,
      author: pr.author,
    },
    changedFiles: files,
    contextFiles: [
      {
        path: "README.md",
        sha: base,
        content: ghContents(ALCODE_REPO, "README.md", base),
      },
      {
        path: "docs/constitution.md",
        sha: base,
        content: ghContents(ALCODE_REPO, "docs/constitution.md", base),
      },
    ],
  };
  writeSnapshot("ri01-broken.json", ri01);

  // RI-02 broken = single-file slice: the NEW docs/roadmap.md from this compare.
  const roadmap = files.find((f) => f.filename === "docs/roadmap.md");
  const ri02 = {
    caseId: "RI-02",
    variant: "broken",
    source: { repo: ALCODE_REPO, pr: 2, base, head },
    prMetadata: {
      title: pr.title,
      body: pr.body,
      head,
      base,
      author: pr.author,
    },
    changedFiles: roadmap ? [roadmap] : [],
    contextFiles: [
      {
        path: "docs/phase-0-spec.md",
        sha: base,
        content: ghContents(ALCODE_REPO, "docs/phase-0-spec.md", base),
      },
    ],
  };
  writeSnapshot("ri02-broken.json", ri02);
}

function buildAlcodeFixed() {
  const base = "0181b19f00dc";
  const head = "20219bd384";
  if (have("ri01-fixed.json") && have("ri02-fixed.json")) return;

  console.log("  fetching PR #2 fixed compare (0181b19...20219bd384)...");
  const pr = ghPrMeta(ALCODE_REPO, 2);
  const files = ghCompareFiles(base, head).map(normalizeGhFile);

  if (!have("ri01-fixed.json")) {
    writeSnapshot("ri01-fixed.json", {
      caseId: "RI-01",
      variant: "fixed",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: {
        title: pr.title,
        body: pr.body,
        head,
        base,
        author: pr.author,
      },
      changedFiles: files,
      contextFiles: [],
    });
  }

  if (!have("ri02-fixed.json")) {
    const spec = files.find((f) => f.filename === "docs/phase-0-spec.md");
    writeSnapshot("ri02-fixed.json", {
      caseId: "RI-02",
      variant: "fixed",
      source: { repo: ALCODE_REPO, pr: 2, base, head },
      prMetadata: {
        title: pr.title,
        body: pr.body,
        head,
        base,
        author: pr.author,
      },
      changedFiles: spec ? [spec] : [],
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
    const ctx = gitShow(base, ctxPath);
    writeSnapshot("ri03-broken.json", {
      caseId: "RI-03",
      variant: "broken",
      source: { repo: "local/GitWire", pr: 123, base, head },
      prMetadata: gitwirePrMeta(base, head, 123),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: base, content: ctx }],
    });
  }

  // Fixed
  if (!have("ri03-fixed.json")) {
    const head = "67908f7";
    console.log(`  RI-03 fixed:  git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    const ctx = gitShow(base, ctxPath);
    writeSnapshot("ri03-fixed.json", {
      caseId: "RI-03",
      variant: "fixed",
      source: { repo: "local/GitWire", pr: 123, base, head },
      prMetadata: gitwirePrMeta(base, head, 123),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: base, content: ctx }],
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
    const ctx = gitShow(head, ctxPath); // unpaginated version at broken head
    writeSnapshot("ri04-broken.json", {
      caseId: "RI-04",
      variant: "broken",
      source: { repo: "local/GitWire", pr: 124, base, head },
      prMetadata: gitwirePrMeta(base, head, 124),
      changedFiles: files,
      contextFiles: [{ path: ctxPath, sha: head, content: ctx }],
    });
  }

  // Fixed
  if (!have("ri04-fixed.json")) {
    const head = "a32a07e";
    console.log(`  RI-04 fixed:  git diff ${base}..${head}`);
    const files = gitChangedFiles(base, head);
    writeSnapshot("ri04-fixed.json", {
      caseId: "RI-04",
      variant: "fixed",
      source: { repo: "local/GitWire", pr: 124, base, head },
      prMetadata: gitwirePrMeta(base, head, 124),
      changedFiles: files,
      contextFiles: [],
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
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
    console.log("All 8 snapshot files already present — nothing to do.");
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
  console.log("Done.");
}

main();
