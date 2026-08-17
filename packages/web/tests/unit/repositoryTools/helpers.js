// Shared helpers for RepositoryTools v2 tests. Builds real git state with
// the same git binary the session uses, so tests exercise true object
// identity (content-addressed blob SHAs) rather than mocks.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GIT = process.env.GITWIRE_GIT_BIN || "git";

export function tempDir(prefix = "gitwire-rt-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function plainGit(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const res = spawnSync(GIT, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout;
}

/**
 * Build a snapshot acquisition source from a plain files map.
 * Recorded blob SHAs are the REAL content-addressed SHAs, so the
 * materialized tree is faithful by construction.
 *
 * @param {Object<string,string>} files path → content
 * @param {object} [options]
 * @param {Object<string,string>} [options.shaOverrides] path → fake recorded
 *        sha (simulates snapshot divergence, e.g. lossy binary capture)
 * @param {string} [options.ref]
 * @returns {Promise<{ref: string, tree: Array, blobs: Object<string,string>}>}
 */
export async function buildSnapshotSource(files, options = {}) {
  const { shaOverrides = {}, ref = "test-head" } = options;
  const tmp = tempDir("gitwire-rt-hash-");
  try {
    const paths = Object.keys(files);
    const blobs = {};
    const tree = [];
    if (paths.length > 0) {
      for (const p of paths) {
        const abs = path.join(tmp, p.replaceAll("/", path.sep));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, files[p], "utf8");
      }
      const listed = paths.map((p) => path.join(tmp, p.replaceAll("/", path.sep)));
      const out = spawnSync(GIT, ["hash-object", "-w", "--stdin-paths"], {
        input: listed.join("\n"),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (out.status !== 0) throw new Error(`hash-object failed: ${out.stderr}`);
      const shas = out.stdout.trim().split("\n");
      paths.forEach((p, i) => {
        // Mirror the real fixture store: content is keyed by the RECORDED
        // sha. With an override (simulated lossy capture) the store never
        // knows the content's true sha.
        const recorded = shaOverrides[p] ?? shas[i];
        blobs[recorded] = files[p];
        tree.push({
          path: p,
          sha: recorded,
          size: Buffer.byteLength(files[p], "utf8"),
        });
      });
    }
    return { ref, tree, blobs };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Create a real local git repository (used as a file:// origin for remote
 * acquisition tests). Returns commits oldest-first.
 *
 * @param {Array<Object<string,string>>} commits list of files maps, one per commit
 * @returns {{ dir: string, shas: string[], cleanup: () => void }}
 */
export function makeOriginRepo(commits) {
  const dir = tempDir("gitwire-rt-origin-");
  const home = path.join(dir, "..", path.basename(dir) + "-home");
  fs.mkdirSync(home, { recursive: true });
  const identity = {
    GIT_AUTHOR_NAME: "Test Origin",
    GIT_AUTHOR_EMAIL: "origin@test.invalid",
    GIT_AUTHOR_DATE: "1970-01-01T00:00:01+00:00",
    GIT_COMMITTER_NAME: "Test Origin",
    GIT_COMMITTER_EMAIL: "origin@test.invalid",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:01+00:00",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  plainGit(dir, ["init", "-q", "-b", "main"]);
  const shas = [];
  commits.forEach((files, i) => {
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(dir, p.replaceAll("/", path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    plainGit(dir, ["add", "-A"]);
    plainGit(dir, ["commit", "-q", "-m", `origin commit ${i}`], identity);
    shas.push(plainGit(dir, ["rev-parse", "HEAD"]).trim());
  });
  // Annotated tag on HEAD: requesting the TAG sha as headSha must fail the
  // commit-identity check (rev-parse peels it to a different commit sha).
  plainGit(dir, ["tag", "-a", "v1", "-m", "tag one"], identity);
  const tagSha = plainGit(dir, ["rev-parse", "v1"]).trim();
  return { dir, shas, tagSha, cleanup: () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  } };
}

/** Recursively list files under a directory (for leaked-credential scans). */
export function listFilesRecursive(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}
