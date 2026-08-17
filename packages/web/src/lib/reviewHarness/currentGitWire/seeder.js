// Deterministic first-order dependency seeding (RI-9 Phase 9, Arm A).
//
// Preserves the current orchestration's context-selection characteristic:
// before exploration, the changed files' DIRECT imports that resolve inside
// the repository are seeded into the user prompt (the campaign's
// first-order dependency seeding). Purely deterministic — no model calls.

import { createRepositoryToolExecutors } from "../shared/repositoryToolPresenters.js";

const IMPORT_RE = /(?:import[\s\S]{0,200}?from\s*|import\s*|require\s*\(\s*)["']([^"']+)["']/g;
const SEED_LINE_CAP = 250;

function resolveImportCandidates(spec, changedFile, changedPaths) {
  if (!spec.startsWith(".")) return null;
  // Relative: resolve against the changed file's directory.
  const baseParts = changedFile.split("/").slice(0, -1);
  const specParts = spec.split("/");
  const resolved = [...baseParts];
  for (const part of specParts) {
    if (part === "." || part === "") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  const noExt = resolved.join("/");
  // Candidates in priority order; the caller probes each with a real read.
  const candidates = [noExt, `${noExt}.js`, `${noExt}/index.js`];
  return candidates.map((path) => ({
    path,
    isChanged: changedPaths.has(path),
  }));
}

/**
 * Build deterministic first-order seeds: for each changed file, its in-repo
 * imports' content (first SEED_LINE_CAP lines), deduplicated, changed files
 * excluded (their diffs are already in the objective).
 *
 * @returns {Promise<Array<{path: string, content: string, sourceChangedFile: string}>>}
 */
export async function buildFirstOrderSeeds({ repositorySession, changedFiles }) {
  const { repositoryTools } = createRepositoryToolExecutors(repositorySession);
  const changedPaths = new Set(changedFiles.map((f) => f.filename || f.path));
  const targets = new Map(); // path → sourceChangedFile

  for (const changed of changedFiles) {
    const path = changed.filename || changed.path;
    const read = await repositoryTools.read({ path, limit: 2000 });
    if (read.status === "error" || !read.data?.content) continue;
    let match;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(read.data.content)) !== null) {
      const candidates = resolveImportCandidates(match[1], path, changedPaths);
      if (!candidates) continue;
      for (const candidate of candidates) {
        if (candidate.isChanged) break; // changed diffs are already in the objective
        if (targets.has(candidate.path)) break;
        const probe = await repositoryTools.read({ path: candidate.path, limit: 1 });
        if (probe.status !== "error") {
          targets.set(candidate.path, path);
          break;
        }
      }
    }
  }

  const seeds = [];
  for (const [seedPath, sourceChangedFile] of targets) {
    const read = await repositoryTools.read({ path: seedPath, limit: SEED_LINE_CAP });
    if (read.status === "error" || !read.data?.content) continue;
    seeds.push({
      path: seedPath,
      content: read.data.content,
      sourceChangedFile,
      truncated: read.status === "partial",
    });
  }
  return seeds;
}

/** Render seeds into the user-prompt block in the current loop's format. */
export function renderSeeds(seeds) {
  if (!seeds || seeds.length === 0) return "";
  const parts = ["", "## Seeded dependency context (first-order imports of the changed files)", ""];
  for (const seed of seeds) {
    parts.push(`### ${seed.path} (imported by ${seed.sourceChangedFile}${seed.truncated ? `, first ${SEED_LINE_CAP} lines` : ""})`);
    parts.push("```");
    parts.push(seed.content);
    parts.push("```");
  }
  return parts.join("\n");
}
