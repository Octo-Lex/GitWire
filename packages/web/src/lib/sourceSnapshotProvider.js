// src/lib/sourceSnapshotProvider.js
// Trusted source snapshot provider for sandbox execution.
//
// Acquires the repository source at exactly base_sha using a read-only
// GitHub API client. The snapshot is materialized as an immutable file set
// with a content-addressed snapshot hash (git tree SHA).
//
// The sandbox executor receives only the file set — no GitHub credentials,
// no network access, no tokens. Source acquisition happens OUTSIDE the
// sandbox, in this trusted provider.
//
// The provider fetches files via the GitHub git/trees API:
// 1. GET the tree at base_sha (recursive) — one call
// 2. For each blob, GET the blob content — one call per file
//
// The source_snapshot_hash is the git tree SHA at base_sha, which is
// already content-addressed by git.

import crypto from "crypto";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "./logger.js";
import { computeSnapshotHash } from "./artifactApplier.js";
import { buildFileManifest, storeSourceSnapshot } from "./sourceSnapshotStore.js";

/**
 * Acquire a source snapshot at a specific commit SHA.
 *
 * Uses the GitHub API (read-only) to fetch all files at base_sha.
 * Returns an immutable file set and a content-addressed snapshot hash.
 *
 * The snapshot hash is computed from the file contents (not the git tree SHA)
 * so it can be verified without trusting the git server.
 *
 * @param {object} octokit - authenticated GitHub API client
 * @param {string} repoFullname - e.g., "owner/repo"
 * @param {string} baseSha - the exact commit SHA
 * @returns {Promise<{ files: Array<{path, content}>, snapshot_hash: string }>}
 */
export async function acquireSourceSnapshot(octokit, repoFullname, baseSha) {
  if (!octokit) throw new Error("acquireSourceSnapshot: octokit client is required");
  if (!repoFullname) throw new Error("acquireSourceSnapshot: repoFullname is required");
  if (!baseSha) throw new Error("acquireSourceSnapshot: baseSha is required");

  const [owner, repo] = repoFullname.split("/");
  if (!owner || !repo) {
    throw new Error(`acquireSourceSnapshot: invalid repo name '${repoFullname}'`);
  }

  logger.info({ repo: repoFullname, base_sha: baseSha }, "Acquiring source snapshot");

  // 1. Fetch the commit to verify it exists and get the tree SHA
  const { data: commitData } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{sha}",
    { owner, repo, sha: baseSha }
  );

  const treeSha = commitData.tree.sha;

  // 2. Fetch the tree recursively to get all file paths + blob SHAs
  const { data: treeData } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1",
    { owner, repo, tree_sha: treeSha }
  );

  if (treeData.truncated) {
    throw new Error(
      `Source snapshot tree is truncated (too many files) — cannot materialize at ${baseSha}`
    );
  }

  // 3. Filter to blob entries (skip directories and submodules)
  const blobs = treeData.tree.filter(
    (entry) => entry.type === "blob" && entry.path
  );

  logger.info(
    { repo: repoFullname, base_sha: baseSha, blobCount: blobs.length },
    "Fetching source blob contents"
  );

  // 4. Fetch each blob's content (base64-decoded)
  // Fail closed on ANY blob fetch failure — a partial file set is not
  // a reconstruction of the pinned commit. Every blob in the tree must
  // be materialized.
  const files = [];
  for (const blob of blobs) {
    const { data: blobData } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/blobs/{sha}",
      { owner, repo, sha: blob.sha }
    );

    // Decode base64 content
    const content = Buffer.from(blobData.content, "base64").toString("utf-8");
    files.push({ path: blob.path, content });
  }

  // 5. Compute content-addressed snapshot hash from file contents
  const snapshotHash = computeSnapshotHash(files);

  // 6. Store durable source snapshot binding
  const fileManifest = buildFileManifest(files);
  await storeSourceSnapshot({
    snapshot_hash: snapshotHash,
    repo_full_name: repoFullname,
    base_sha: baseSha,
    file_manifest: fileManifest,
  });

  logger.info(
    { repo: repoFullname, base_sha: baseSha, fileCount: files.length, snapshot_hash: snapshotHash },
    "Source snapshot acquired"
  );

  return { files, snapshot_hash: snapshotHash };
}
