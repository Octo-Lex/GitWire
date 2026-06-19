// src/lib/sourceSnapshotStore.js
// Durable source-snapshot bindings for execution receipt verification.
//
// A source snapshot records the exact file set materialized at a specific
// base SHA. Its hash is content-addressed from file contents. The receipt
// verifier resolves this row under lock to verify that the receipt was
// produced from the expected pinned commit snapshot.
//
// The composite key (snapshot_hash, repo_full_name, base_sha) prevents
// cross-repo collisions: identical file sets in different repos produce
// the same content hash but are stored as distinct rows.
//
// Write-once: INSERT ON CONFLICT DO NOTHING. Never deleted.

import crypto from "crypto";
import { db } from "./db.js";
import { logger } from "./logger.js";

/**
 * Build a file manifest from a source file set.
 * Each entry is { path, hash } where hash is sha256 of file content.
 * Paths are sorted for canonical ordering.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {Array<{path: string, hash: string}>}
 */
export function buildFileManifest(files) {
  return [...files]
    .map((f) => ({
      path: f.path,
      hash: crypto.createHash("sha256").update(f.content, "utf-8").digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Store a source snapshot binding durably.
 * Uses composite key (snapshot_hash, repo_full_name, base_sha) so identical
 * file sets in different repos or at different base SHAs are distinct rows.
 *
 * @param {object} params
 * @param {string} params.snapshot_hash - content-addressed hash
 * @param {string} params.repo_full_name
 * @param {string} params.base_sha
 * @param {Array<{path, hash}>} params.file_manifest
 * @returns {Promise<void>}
 */
export async function storeSourceSnapshot(params) {
  const { snapshot_hash, repo_full_name, base_sha, file_manifest } = params;

  if (!snapshot_hash) throw new Error("storeSourceSnapshot: snapshot_hash is required");
  if (!repo_full_name) throw new Error("storeSourceSnapshot: repo_full_name is required");
  if (!base_sha) throw new Error("storeSourceSnapshot: base_sha is required");
  if (!Array.isArray(file_manifest)) throw new Error("storeSourceSnapshot: file_manifest is required");

  await db.query(
    `INSERT INTO source_snapshots (snapshot_hash, repo_full_name, base_sha, file_manifest, blob_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (snapshot_hash, repo_full_name, base_sha) DO NOTHING`,
    [
      snapshot_hash,
      repo_full_name,
      base_sha,
      JSON.stringify(file_manifest),
      file_manifest.length,
    ]
  );

  logger.debug({ snapshot_hash, repo_full_name, base_sha, blobs: file_manifest.length }, "Source snapshot stored");
}

/**
 * Resolve a source snapshot by its composite key.
 * Returns { snapshot_hash, repo_full_name, base_sha, file_manifest, blob_count }.
 *
 * @param {string} snapshotHash
 * @param {string} repoFullName
 * @param {string} baseSha
 * @returns {Promise<object|null>}
 */
export async function resolveSourceSnapshot(snapshotHash, repoFullName, baseSha) {
  const { rows } = await db.query(
    `SELECT snapshot_hash, repo_full_name, base_sha, file_manifest, blob_count
     FROM source_snapshots
     WHERE snapshot_hash = $1 AND repo_full_name = $2 AND base_sha = $3`,
    [snapshotHash, repoFullName, baseSha]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    ...row,
    file_manifest: typeof row.file_manifest === "string" ? JSON.parse(row.file_manifest) : row.file_manifest,
  };
}

/**
 * Verify a source snapshot against locked proposal state.
 * Resolves by composite key, so the query itself enforces all three bindings.
 *
 * @param {string} snapshotHash
 * @param {string} expectedRepoFullName
 * @param {string} expectedBaseSha
 * @returns {Promise<object>} the resolved snapshot
 * @throws {Error} if snapshot is missing (composite key not found)
 */
export async function verifySourceSnapshot(snapshotHash, expectedRepoFullName, expectedBaseSha) {
  const snapshot = await resolveSourceSnapshot(snapshotHash, expectedRepoFullName, expectedBaseSha);
  if (!snapshot) {
    throw new Error(
      `Source snapshot not found for hash=${snapshotHash}, repo=${expectedRepoFullName}, base_sha=${expectedBaseSha}`
    );
  }

  return snapshot;
}
