// Fixture → Git materializer for the repository-instrument qualification
// suite (RI-9 amendment, Phase 5).
//
// Converts the frozen historical surface snapshots (full recursive trees +
// deduped blob stores) into exact Git repositories via RepositorySession's
// snapshot acquisition, and caches one session per distinct (repo, base,
// head) triple so the eight RI fixtures share six materializations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { prepareRepository } from "../../../../src/lib/repositoryTools/repositorySession.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.join(__dirname, "snapshots");
const REPOS_DIR = path.join(SNAPSHOTS_DIR, "repos");

const _sessionCache = new Map();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function repoKeyForFixture(fixture) {
  return fixture.source.repo.includes("AlCode") ? "alcode" : "gitwire";
}

function loadSurface(repoKey, ref) {
  const treeFile = path.join(REPOS_DIR, `${repoKey}-${ref}.tree.json`);
  if (!fs.existsSync(treeFile)) {
    throw new Error(`surface snapshot missing: ${repoKey}-${ref}.tree.json`);
  }
  return readJson(treeFile);
}

/**
 * Materialize (or reuse) a repository session for a fixture case at its
 * exact recorded BASE/HEAD.
 *
 * @param {object} fixture a loaded riXX-<variant>.json fixture
 * @returns {Promise<object>} prepared repository session (caller does NOT
 *          close — sessions are shared and closed by closeAllFixtureSessions)
 */
export async function sessionForFixture(fixture) {
  const repoKey = repoKeyForFixture(fixture);
  const { base, head } = fixture.source;
  const cacheKey = `${repoKey}:${base}:${head}`;
  const cached = _sessionCache.get(cacheKey);
  if (cached) return cached;

  const blobs = readJson(path.join(REPOS_DIR, `${repoKey}-blobs.json`));
  const baseTree = loadSurface(repoKey, base);
  const headTree = loadSurface(repoKey, head);

  const session = await prepareRepository({
    invocationId: `ri-qual-${cacheKey.replaceAll(":", "-")}`,
    repository: fixture.source.repo,
    headSha: head,
    baseSha: base,
    acquire: {
      mode: "snapshot",
      baseTree: { ref: base, tree: baseTree.tree },
      headTree: { ref: head, tree: headTree.tree },
      blobs,
    },
  });
  _sessionCache.set(cacheKey, session);
  return session;
}

/** Close every cached fixture session (call from afterAll). */
export function closeAllFixtureSessions() {
  for (const session of _sessionCache.values()) {
    session.close();
  }
  _sessionCache.clear();
}

/** Load a fixture case JSON by id, e.g. ("ri04", "broken"). */
export function loadFixture(caseId, variant) {
  const file = path.join(SNAPSHOTS_DIR, `${caseId}-${variant}.json`);
  return readJson(file);
}
