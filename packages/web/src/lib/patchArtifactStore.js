// src/lib/patchArtifactStore.js
// Durable content-addressed artifact store for patch proposals.
//
// Backed by the patch_artifacts database table. Artifacts are canonical
// JSON serializations of structured edit operations. The artifact_hash
// (SHA-256 of the content bytes) is the primary key. Artifacts are
// write-once (INSERT ON CONFLICT DO NOTHING) and never deleted.
//
// This ensures proposals can retain their artifact_ref across process
// restarts, worker relocation, and multi-process deployments.

import crypto from "crypto";
import { db } from "./db.js";
import { logger } from "./logger.js";

/**
 * Compute the canonical hash of artifact content.
 * @param {string|Buffer} content - the raw artifact bytes
 * @returns {string} sha256 hash with prefix
 */
export function computeArtifactHash(content) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a content-addressed artifact reference from a hash.
 */
export function buildArtifactRef(hash) {
  return `artifact:${hash}`;
}

/**
 * Store patch artifact content in the durable content-addressed store.
 * Returns { ref, hash } for the stored content.
 *
 * Write-once: if the hash already exists, the existing row is kept
 * (ON CONFLICT DO NOTHING). Content is idempotent — same bytes always
 * produce the same hash.
 *
 * @param {string} content - canonical JSON serialization of the patch
 * @returns {Promise<{ ref: string, hash: string }>}
 */
export async function storeArtifact(content) {
  const hash = computeArtifactHash(content);
  const ref = buildArtifactRef(hash);

  await db.query(
    `INSERT INTO patch_artifacts (artifact_hash, artifact_ref, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (artifact_hash) DO NOTHING`,
    [hash, ref, content]
  );

  logger.debug({ ref, size: content.length }, "Patch artifact stored durably");
  return { ref, hash };
}

/**
 * Resolve an artifact reference and return its content from durable storage.
 * Throws if the artifact is not found.
 *
 * @param {string} ref - content-addressed artifact reference
 * @returns {Promise<string>} the stored artifact content
 */
export async function resolveArtifact(ref) {
  const { rows } = await db.query(
    `SELECT content FROM patch_artifacts WHERE artifact_ref = $1`,
    [ref]
  );
  if (rows.length === 0) {
    throw new Error(`Patch artifact not found: ${ref}`);
  }
  return rows[0].content;
}

/**
 * Verify that an artifact reference resolves to content matching the expected hash.
 * Retrieves from durable storage and recomputes the hash.
 * Throws if the artifact is not found or the hash does not match.
 *
 * @param {string} ref - content-addressed artifact reference
 * @param {string} expectedHash - expected sha256:... hash
 * @returns {Promise<string>} the verified artifact content
 */
export async function verifyArtifact(ref, expectedHash) {
  const content = await resolveArtifact(ref);
  const actualHash = computeArtifactHash(content);

  if (actualHash !== expectedHash) {
    throw new Error(
      `Patch artifact hash mismatch: expected ${expectedHash}, computed ${actualHash}`
    );
  }

  return content;
}

/**
 * Parse a verified artifact and derive structured patch information.
 *
 * The artifact is canonical JSON with this shape:
 * {
 *   "base_sha": "...",
 *   "files": [
 *     {
 *       "path": "src/example.js",
 *       "change_type": "fix",
 *       "edits": [
 *         { "line_start": 1, "line_end": 3, "new_content": "..." }
 *       ]
 *     }
 *   ]
 * }
 *
 * Returns derived values computed from the parsed artifact:
 * - changed_files: array of { path, change_type, lines_changed }
 * - total_files: count of files
 * - total_lines_changed: sum of lines_changed across all files
 *
 * @param {string} content - verified artifact content
 * @returns {{ changed_files: object[], total_files: number, total_lines_changed: number }}
 */
export function parseArtifact(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_e) {
    throw new Error("Patch artifact is not valid JSON");
  }

  if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("Patch artifact must contain a non-empty files array");
  }

  const changedFiles = [];
  let totalLinesChanged = 0;

  for (const file of parsed.files) {
    if (!file.path || typeof file.path !== "string") {
      throw new Error(`Patch artifact file missing path`);
    }

    // Require at least one edit per file — no-op files are invalid
    if (!Array.isArray(file.edits) || file.edits.length === 0) {
      throw new Error(`Patch artifact file must contain at least one edit: ${file.path}`);
    }

    // Derive lines_changed from edits
    let fileLinesChanged = 0;
    for (const edit of file.edits) {
      if (
        !Number.isInteger(edit.line_start) ||
        !Number.isInteger(edit.line_end) ||
        edit.line_start < 1 ||
        edit.line_end < edit.line_start
      ) {
        throw new Error(`Invalid edit range for ${file.path}`);
      }
      // Lines changed = span of the edit + new content lines
      // For whole-file replacements (line_end=999999 sentinel), use the new
      // content's line count since the sentinel doesn't reflect real line count.
      const oldLines = edit.line_end >= 999999
        ? (edit.new_content ? edit.new_content.split("\n").length : 0)
        : Math.max(0, edit.line_end - edit.line_start + 1);
      const newLines = edit.new_content ? edit.new_content.split("\n").length : 0;
      fileLinesChanged += Math.max(oldLines, newLines);
    }

    changedFiles.push({
      path: file.path,
      change_type: file.change_type || "modify",
      lines_changed: fileLinesChanged,
    });
    totalLinesChanged += fileLinesChanged;
  }

  if (totalLinesChanged < 1) {
    throw new Error("Patch artifact must contain at least one changed line");
  }

  return {
    changed_files: changedFiles,
    total_files: changedFiles.length,
    total_lines_changed: totalLinesChanged,
  };
}
