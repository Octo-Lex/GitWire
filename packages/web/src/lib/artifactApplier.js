// src/lib/artifactApplier.js
// Strict patch artifact application to a source file set.
//
// Applies structured edit operations from a verified patch artifact to
// a set of source files. Fails closed when any path, line range, or
// edit operation cannot be applied exactly. Never reinterprets patch
// operations or continues after a partial application.
//
// The applier operates on an in-memory file set ({ path, content }) and
// returns a new file set with the edits applied. It does not touch disk
// — the caller (executor) is responsible for writing files to the workspace.

import crypto from "crypto";

/**
 * Compute a content-addressed hash for a file set.
 * Files are sorted by path and hashed as canonical JSON.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {string} sha256 hash with prefix
 */
export function computeSnapshotHash(files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const content = JSON.stringify(
    sorted.map((f) => ({ path: f.path, hash: crypto.createHash("sha256").update(f.content, "utf-8").digest("hex") }))
  );
  return "sha256:" + crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Apply a verified patch artifact to a source file set.
 *
 * The artifact is canonical JSON:
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
 * For each file in the artifact:
 * - The source file must exist in the snapshot
 * - Each edit replaces lines [line_start, line_end] (1-indexed, inclusive)
 *   with the new_content
 * - If any edit cannot be applied exactly (line range out of bounds,
 *   file missing), the entire apply fails closed
 *
 * @param {Array<{path: string, content: string}>} sourceFiles - original files
 * @param {object} artifact - parsed patch artifact
 * @returns {{ files: Array<{path, content}>, applied: boolean, failure?: string }}
 */
export function applyArtifact(sourceFiles, artifact) {
  if (!artifact || !Array.isArray(artifact.files) || artifact.files.length === 0) {
    return { files: null, applied: false, failure: "Artifact has no files array" };
  }

  // Build a map of source files by path
  const fileMap = new Map(sourceFiles.map((f) => [f.path, f.content]));

  const resultFiles = new Map(fileMap);

  for (const fileEdit of artifact.files) {
    const { path, edits } = fileEdit;

    if (!fileMap.has(path)) {
      return {
        files: null,
        applied: false,
        failure: `Cannot apply artifact: source file not found: ${path}`,
      };
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      return {
        files: null,
        applied: false,
        failure: `Cannot apply artifact: no edits for file ${path}`,
      };
    }

    const originalContent = fileMap.get(path);
    const lines = originalContent.split("\n");

    // Apply edits in reverse order so earlier line numbers remain valid
    const sortedEdits = [...edits].sort((a, b) => b.line_start - a.line_start);

    for (const edit of sortedEdits) {
      const { line_start, line_end, new_content } = edit;

      // Validate line range (1-indexed, inclusive)
      if (!Number.isInteger(line_start) || !Number.isInteger(line_end)) {
        return {
          files: null,
          applied: false,
          failure: `Invalid edit for ${path}: line_start and line_end must be integers`,
        };
      }
      if (line_start < 1 || line_end < line_start) {
        return {
          files: null,
          applied: false,
          failure: `Invalid edit range for ${path}: ${line_start}-${line_end}`,
        };
      }
      if (line_end > lines.length) {
        return {
          files: null,
          applied: false,
          failure: `Cannot apply edit to ${path}: line_end ${line_end} exceeds file length ${lines.length}`,
        };
      }

      // Replace lines [line_start-1, line_end-1] (0-indexed splice) with new content
      const newLines = new_content ? new_content.split("\n") : [];
      lines.splice(line_start - 1, line_end - line_start + 1, ...newLines);
    }

    resultFiles.set(path, lines.join("\n"));
  }

  const result = [...resultFiles.entries()].map(([path, content]) => ({ path, content }));

  return { files: result, applied: true };
}
