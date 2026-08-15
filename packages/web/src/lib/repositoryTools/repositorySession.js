// RepositorySession — immutable repository substrate for RepositoryTools v2
// (RI-9 amendment, Phase 1).
//
// One session belongs to exactly one review invocation. It materializes the
// repository at the exact immutable HEAD (keeping BASE available for diff
// operations) inside an ephemeral, session-owned directory, using a sterile
// Git environment. The session NEVER receives the GitHub mutation
// credential; the acquisition-time read credential, if any, exists only for
// the duration of the fetch and is never persisted on the session.
//
// Acquisition modes:
//   snapshot — materialize from {tree, blobs} fixture data; identity is the
//              recorded blob SHAs (exact for faithful text blobs; binary
//              blobs whose bytes are not recoverable from the snapshot store
//              are recorded in an explicit divergence ledger)
//   remote   — fetch exact SHAs from a Git remote; the fetched HEAD commit
//              MUST equal the requested headSha byte-for-byte

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareSterileSkeleton, runGit } from "./gitRunner.js";

export class RepositorySessionError extends Error {
  /**
   * @param {string} code machine-readable error code (E_*)
   * @param {string} message human-readable detail
   */
  constructor(code, message) {
    super(message);
    this.name = "RepositorySessionError";
    this.code = code;
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Validate a repository-relative path. Rejects absolute paths, drive
 * letters, backslashes, `..` traversal, and empty segments — the escape
 * classes named by the RI-9 amendment (Phase 5 pathological cases).
 *
 * @param {string} pathname
 * @param {object} [options]
 * @param {boolean} [options.allowDot] allow the exact path "." (ls root)
 * @returns {string} the validated path
 * @throws {RepositorySessionError} E_PATH_ESCAPE on any escape attempt
 */
export function validateRepoPath(pathname, options = {}) {
  const { allowDot = false } = options;
  if (typeof pathname !== "string" || pathname.length === 0 || pathname.length > 1024) {
    throw new RepositorySessionError("E_PATH_ESCAPE", `invalid path: ${JSON.stringify(pathname)}`);
  }
  if (allowDot && pathname === ".") return pathname;
  if (pathname.includes("\\")) {
    throw new RepositorySessionError("E_PATH_ESCAPE", `backslash in repository path: ${pathname}`);
  }
  if (pathname.startsWith("/") || /^[A-Za-z]:/.test(pathname)) {
    throw new RepositorySessionError("E_PATH_ESCAPE", `absolute path rejected: ${pathname}`);
  }
  const segments = pathname.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new RepositorySessionError("E_PATH_ESCAPE", `path segment escape rejected: ${pathname}`);
    }
  }
  return pathname;
}

/** Fixed deterministic commit identity for snapshot materialization. */
const MATERIALIZE_IDENTITY = {
  GIT_AUTHOR_NAME: "GitWire Repository Session",
  GIT_AUTHOR_EMAIL: "repository-session@gitwire.invalid",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:01+00:00",
  GIT_COMMITTER_NAME: "GitWire Repository Session",
  GIT_COMMITTER_EMAIL: "repository-session@gitwire.invalid",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:01+00:00",
};

/**
 * @typedef {Object} TreeEntry
 * @property {string} TreeEntry.path repository-relative tracked path
 * @property {string} TreeEntry.sha recorded blob SHA (the immutable identity)
 * @property {number} [TreeEntry.size] recorded size in bytes
 */

/**
 * Classify a divergent blob's kind from its recovered content: binary-kind
 * divergence (NUL or replacement characters) is skip-as-binary for text
 * search; text-kind divergence must force partiality, never silent lies.
 */
function classifyDivergence(content) {
  return /[\u0000\uFFFD]/.test(content) ? "binary" : "text";
}

async function commitTree(run, workDir, ref) {
  const add = await run(["add", "-A"]);
  if (add.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `git add failed: ${add.stderr}`);
  }
  const commit = await run(["commit", "-q", "-m", `materialize ${ref}`], {
    env: MATERIALIZE_IDENTITY,
  });
  if (commit.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `git commit failed: ${commit.stderr}`);
  }
  const head = await run(["rev-parse", "HEAD"]);
  if (head.code !== 0 || !FULL_SHA_RE.test(head.stdout.toString("utf8").trim())) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `rev-parse HEAD failed: ${head.stderr}`);
  }
  return head.stdout.toString("utf8").trim();
}

/** Write a snapshot tree's blobs into the (cleared) working directory. */
function writeTreeEntries(workDir, tree, blobs, ref) {
  for (const entry of tree) {
    validateRepoPath(entry.path);
    if (typeof entry.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(entry.sha)) {
      throw new RepositorySessionError("E_SNAPSHOT_PATH", `bad entry sha for ${entry.path} in ${ref}`);
    }
    const content = blobs[entry.sha];
    if (typeof content !== "string") {
      throw new RepositorySessionError(
        "E_SNAPSHOT_GAP",
        `snapshot gap: blob ${entry.sha} for ${entry.path} (${ref}) is not in the blob store`
      );
    }
    const target = path.join(workDir, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

/** Remove every worktree file (keeping .git) between materialized trees. */
function clearWorktree(workDir) {
  for (const entry of fs.readdirSync(workDir)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(workDir, entry), { recursive: true, force: true });
  }
}

/** Parse `git ls-tree -r <ref>` into a Map(path → {sha, mode, type}). */
async function readTreeMap(run, ref) {
  const res = await run(["ls-tree", "-r", ref]);
  if (res.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `ls-tree ${ref} failed: ${res.stderr}`);
  }
  const map = new Map();
  for (const line of res.stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const match = line.match(/^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/);
    if (!match) {
      throw new RepositorySessionError("E_PREPARE_FAILED", `unparseable ls-tree line: ${line}`);
    }
    map.set(match[4], { sha: match[3], mode: match[1], type: match[2] });
  }
  return map;
}

/**
 * Build the identity report comparing the materialized/fetched tree against
 * the recorded snapshot tree (snapshot mode) — every entry must exist and
 * every faithful entry's blob SHA must match the recorded immutable identity.
 * Divergence kind is classified from the content that was actually written
 * (the store's copy under the recorded sha).
 */
function buildSnapshotIdentityReport(headTree, materialized, blobs) {
  const faithful = [];
  const divergent = [];
  for (const entry of headTree) {
    const got = materialized.get(entry.path);
    if (!got) {
      divergent.push({
        path: entry.path,
        expected: entry.sha,
        materialized: null,
        kind: "missing",
      });
      continue;
    }
    if (got.sha === entry.sha) {
      faithful.push(entry.path);
    } else {
      divergent.push({
        path: entry.path,
        expected: entry.sha,
        materialized: got.sha,
        kind: classifyDivergence(blobs[entry.sha] ?? ""),
      });
    }
  }
  const unexpected = [...materialized.keys()].filter((p) => !headTree.some((e) => e.path === p));
  return { checked: headTree.length, faithful, divergent, unexpected };
}

/**
 * Prepare an immutable repository session.
 *
 * @param {object} input
 * @param {string} input.invocationId unique per review invocation
 * @param {string} [input.repository] repository label (informational)
 * @param {string} input.headSha expected HEAD identity (remote: full 40-hex
 *        that the fetched commit MUST equal; snapshot: the snapshot ref)
 * @param {string} [input.baseSha] expected BASE identity
 * @param {object} input.acquire
 * @param {"snapshot"|"remote"} input.acquire.mode
 * @param {object} [input.acquire.baseTree] snapshot mode: {ref, tree: TreeEntry[]}
 * @param {object} [input.acquire.headTree] snapshot mode: {ref, tree: TreeEntry[]}
 * @param {Object<string,string>} [input.acquire.blobs] snapshot mode: blob sha → content
 * @param {string} [input.acquire.url] remote mode: Git remote URL
 * @param {{header: string}} [input.acquire.readCredential] remote mode:
 *        short-lived read credential (http extraheader), used ONLY during
 *        fetch and never persisted
 * @returns {Promise<object>} the repository session
 * @throws {RepositorySessionError} on any acquisition/identity failure
 */
export async function prepareRepository(input) {
  const {
    invocationId,
    repository = "(unnamed)",
    headSha,
    baseSha = null,
    acquire,
  } = input ?? {};

  if (!invocationId || !SESSION_ID_RE.test(invocationId)) {
    throw new RepositorySessionError("E_INVALID_INPUT", `invalid invocationId: ${JSON.stringify(invocationId)}`);
  }
  if (!headSha || typeof headSha !== "string") {
    throw new RepositorySessionError("E_INVALID_INPUT", "headSha is required");
  }
  if (!acquire || (acquire.mode !== "snapshot" && acquire.mode !== "remote")) {
    throw new RepositorySessionError("E_INVALID_INPUT", "acquire.mode must be 'snapshot' or 'remote'");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitwire-repo-session-"));
  const { home, globalConfig, hooksDir } = prepareSterileSkeleton(root);
  const workDir = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });

  /** Session-scoped git runner. */
  const run = (args, opts = {}) =>
    runGit({ args, cwd: workDir, home, globalConfig, hooksDir, ...opts });

  const init = await run(["init", "-q", "-b", "main"]);
  if (init.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `git init failed: ${init.stderr}`);
  }

  if (acquire.mode === "snapshot") {
    return await acquireSnapshot({ run, workDir, root, home, globalConfig, hooksDir, headSha, baseSha, acquire, invocationId, repository });
  }
  return await acquireRemote({ run, workDir, root, home, globalConfig, hooksDir, headSha, baseSha, acquire, invocationId, repository });
}

async function acquireSnapshot(ctx) {
  const { run, workDir, root, home, globalConfig, hooksDir, headSha, baseSha, acquire, invocationId, repository } = ctx;
  const { baseTree, headTree, blobs } = acquire;
  if (!headTree || !Array.isArray(headTree.tree) || headTree.tree.length === 0) {
    throw new RepositorySessionError("E_INVALID_INPUT", "acquire.headTree with a non-empty tree is required in snapshot mode");
  }
  if (!blobs || typeof blobs !== "object") {
    throw new RepositorySessionError("E_INVALID_INPUT", "acquire.blobs is required in snapshot mode");
  }

  let baseFullSha = null;
  if (baseTree && Array.isArray(baseTree.tree) && baseTree.tree.length > 0) {
    writeTreeEntries(workDir, baseTree.tree, blobs, baseTree.ref ?? "base");
    baseFullSha = await commitTree(run, workDir, baseTree.ref ?? "base");
    clearWorktree(workDir);
  }
  writeTreeEntries(workDir, headTree.tree, blobs, headTree.ref ?? "head");
  const headFullSha = await commitTree(run, workDir, headTree.ref ?? "head");

  const status = await run(["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.toString("utf8").trim() !== "") {
    throw new RepositorySessionError(
      "E_DIRTY_WORKTREE",
      `worktree is not clean after materialization: ${status.stdout.toString("utf8")}`
    );
  }

  const materializedMap = await readTreeMap(run, "HEAD");
  const identityReport = buildSnapshotIdentityReport(headTree.tree, materializedMap, blobs);
  const unexpectedPaths = identityReport.unexpected.map((p) => ({ path: p }));
  if (identityReport.divergent.some((d) => d.kind === "missing") || unexpectedPaths.length > 0) {
    throw new RepositorySessionError(
      "E_PREPARE_FAILED",
      `materialized tree does not match snapshot tree: ${JSON.stringify({ divergent: identityReport.divergent, unexpected: unexpectedPaths })}`
    );
  }

  return makeSession({
    id: `${invocationId}-${headFullSha.slice(0, 12)}`,
    mode: "snapshot",
    repository,
    invocationId,
    baseSha: baseFullSha,
    headSha: headFullSha,
    expected: { base: baseSha ?? baseTree?.ref ?? null, head: headSha ?? headTree.ref ?? null },
    snapshotRefs: { base: baseTree?.ref ?? null, head: headTree.ref ?? null },
    identityReport,
    root,
    workDir,
    home,
    globalConfig,
    hooksDir,
  });
}

async function acquireRemote(ctx) {
  const { run, workDir, root, home, globalConfig, hooksDir, headSha, baseSha, acquire, invocationId, repository } = ctx;
  const { url, readCredential } = acquire;
  if (!url || typeof url !== "string") {
    throw new RepositorySessionError("E_INVALID_INPUT", "acquire.url is required in remote mode");
  }
  if (!FULL_SHA_RE.test(headSha)) {
    throw new RepositorySessionError("E_INVALID_INPUT", `remote mode requires a full 40-hex headSha, got: ${headSha}`);
  }

  const remote = await run(["remote", "add", "origin", url]);
  if (remote.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `git remote add failed: ${remote.stderr}`);
  }

  // Credential plumbing exists ONLY for this fetch call: an http extraheader
  // passed as -c config to the single fetch invocation. It is never written
  // to any file and never stored on the session.
  const fetchArgs = ["fetch", "--no-tags", "--", "origin"];
  if (baseSha && baseSha !== headSha) fetchArgs.push(baseSha);
  fetchArgs.push(headSha);
  const fetchEnv = {};
  let credentialConfig = [];
  if (readCredential && typeof readCredential.header === "string" && readCredential.header.length > 0) {
    credentialConfig = ["-c", `http.extraheader=${readCredential.header}`];
  }
  const fetch = await run([...credentialConfig, ...fetchArgs], { env: fetchEnv, timeoutMs: acquire.fetchTimeoutMs ?? 120000 });
  if (fetch.code !== 0) {
    throw new RepositorySessionError(
      "E_FETCH_FAILED",
      `git fetch failed for ${headSha}: ${fetch.stderr}`
    );
  }

  const verify = await run(["rev-parse", "--verify", `${headSha}^{commit}`]);
  const fetched = verify.stdout.toString("utf8").trim();
  if (verify.code !== 0 || fetched !== headSha) {
    throw new RepositorySessionError(
      "E_IDENTITY_MISMATCH",
      `fetched HEAD ${fetched || "(none)"} does not equal expected ${headSha}`
    );
  }

  const reset = await run(["reset", "--hard", headSha]);
  if (reset.code !== 0) {
    throw new RepositorySessionError("E_PREPARE_FAILED", `git reset --hard failed: ${reset.stderr}`);
  }
  const status = await run(["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.toString("utf8").trim() !== "") {
    throw new RepositorySessionError(
      "E_DIRTY_WORKTREE",
      `worktree is not clean after checkout: ${status.stdout.toString("utf8")}`
    );
  }

  const treeMap = await readTreeMap(run, "HEAD");
  const identityReport = {
    checked: treeMap.size,
    faithful: [...treeMap.keys()],
    divergent: [],
    unexpected: [],
  };

  return makeSession({
    id: `${invocationId}-${headSha.slice(0, 12)}`,
    mode: "remote",
    repository,
    invocationId,
    baseSha,
    headSha,
    expected: { base: baseSha, head: headSha },
    snapshotRefs: null,
    identityReport,
    root,
    workDir,
    home,
    globalConfig,
    hooksDir,
  });
}

function makeSession(fields) {
  const { id, mode, repository, invocationId, baseSha, headSha, expected, snapshotRefs, identityReport, root, workDir, home, globalConfig, hooksDir } = fields;

  const session = {
    id,
    mode,
    repository,
    invocationId,
    baseSha,
    headSha,
    expected,
    snapshotRefs,
    identityReport,
    root,
    workDir,

    _closed: false,
    _audit: [],

    assertOpen() {
      if (session._closed) {
        throw new RepositorySessionError("E_SESSION_CLOSED", `repository session ${id} is closed`);
      }
    },

    async run(args, opts = {}) {
      session.assertOpen();
      return runGit({ args, cwd: workDir, home, globalConfig, hooksDir, ...opts });
    },

    recordOperation(entry) {
      session.assertOpen();
      session._audit.push({
        ts: new Date().toISOString(),
        ...entry,
      });
    },

    /** JSON-serializable audit trace of every operation on this session. */
    auditTrace() {
      return JSON.parse(JSON.stringify(session._audit));
    },

    /** Paths whose snapshot content is not faithfully recoverable. */
    unfaithfulPaths(kind) {
      return identityReport.divergent
        .filter((d) => (kind ? d.kind === kind : true))
        .map((d) => d.path);
    },

    async assertCleanWorktree() {
      session.assertOpen();
      const status = await runGit({ args: ["status", "--porcelain"], cwd: workDir, home, globalConfig, hooksDir });
      if (status.code !== 0 || status.stdout.toString("utf8").trim() !== "") {
        throw new RepositorySessionError(
          "E_DIRTY_WORKTREE",
          `worktree is dirty: ${status.stdout.toString("utf8")}`
        );
      }
    },

    close() {
      if (session._closed) return;
      session._closed = true;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  return session;
}
