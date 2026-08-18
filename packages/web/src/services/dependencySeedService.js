// src/services/dependencySeedService.js
// Deterministic first-order dependency seeding (RI-9 architecture correction).
//
// Problem being removed from model control: whether the reviewer inspects the
// obvious supporting implementation of a changed file has depended on model
// exploration behavior (RI-04: triageWorker.js -> commentMarkers.js was never
// retrieved). This planner resolves the obvious first-order local dependencies
// BEFORE the reviewer starts, deterministically, against the immutable HEAD.
//
// Rule (generic — no fixture, defect, or path special cases):
//   changed source file
//   -> parse its import block (top-of-file window read at HEAD)
//   -> resolve relative import/require/dynamic-import specifiers to repo paths
//   -> classify:
//        REQUIRED  — a binding imported from that module is referenced by the
//                    changed file's patch (locally referenced callee of the change)
//        OPTIONAL  — any other local import
//        TEST      — deterministically resolvable same-basename test file
//   -> seed content in tiers (required first, then optional, then tests),
//      each tier path-sorted for determinism, bounded by:
//        SEED_CHAR_BUDGET (chars charged to the shared broker budget),
//        MAX_SEED_FILES, SEED_MAX_LINES per file.
//
// Invariants:
//   - exact base/head SHAs only (via the RI-3 broker; no new retrieval surface)
//   - no shell, no external search, no repository-wide indexer, no semantic search
//   - seeded reads count against the existing broker budgets (chars/fileReads);
//     the SAME broker instance is returned for the primary to continue on
//   - every seed carries blob SHA + full-content sha256 digest + reason
//   - a REQUIRED dependency that cannot be retrieved due to a hard resource
//     boundary is returned as a requiredFailure — the caller must make
//     approval evidence incomplete
//   - optional/test tiers beyond the bounds are SKIPPED with traced reasons
//     (seed_budget / seed_cap) — skipped, not failed
//   - identical PR + SHA produces identical output (pure functions of input)
//
// The verifier stays independent: this module is used by the primary path only
// and never sees or conveys primary findings.

import { createContextBroker, DEFAULT_BUDGETS } from "./reviewContextBroker.js";

// ── Bounds (provisional, documented) ────────────────────────────────────────

export const SEED_BOUNDS = Object.freeze({
  importWindowLines: 120, // top-of-file window parsed for imports
  // ONE allocation for import-discovery windows AND dependency seeds —
  // measured from the first planner read, hard-capped per read. Leaves
  // ≥45K of the 90K broker budget for model exploration.
  plannerCharBudget: 45000,
  maxSeedFiles: 16,
  seedMaxLines: 250,      // per-seed content cap (lines)
});

const SOURCE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

function isSourcePath(pathname) {
  const dot = pathname.lastIndexOf(".");
  return dot !== -1 && SOURCE_EXT.has(pathname.slice(dot).toLowerCase());
}

// ── Import parsing (deterministic, top-of-file window) ─────────────────────

/**
 * Parse relative import specifiers and their bindings from source text.
 * Handles ESM `import { a, b } from "./x"`, default/namespace imports,
 * side-effect imports, re-exports, CJS require("./x"), and dynamic import().
 * Only RELATIVE specifiers (./ or ../) are returned — bare packages are not
 * repository-local dependencies.
 *
 * @returns {Array<{ specifier: string, bindings: string[] }>}
 */
export function parseLocalImports(sourceText) {
  if (!sourceText || typeof sourceText !== "string") return [];
  const found = new Map(); // specifier -> Set(bindings)

  const record = (spec, bindings) => {
    if (!spec || (!spec.startsWith("./") && !spec.startsWith("../"))) return;
    if (!found.has(spec)) found.set(spec, new Set());
    for (const b of bindings) if (b) found.get(spec).add(b);
  };

  // ESM: import [bindings] from "spec";  |  import "spec";  |  export ... from "spec";
  const esm = sourceText.matchAll(/import\s+([^;]*?)\s*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|export\s+[^;]*?\s*from\s*["']([^"']+)["']/g);
  for (const m of esm) {
    const spec = m[2] || m[3] || m[4];
    if (!spec) continue;
    const bindings = [];
    const clause = m[1];
    if (clause) {
      // named: { a, b as c } ; default: Name ; namespace: * as ns
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const seg = part.trim();
          if (!seg) continue;
          const as = seg.split(/\s+as\s+/);
          bindings.push((as[1] || as[0]).trim());
        }
      }
      const rest = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, " ").trim();
      const defaultOrNs = rest.match(/(\*)\s+as\s+(\w+)|(\w+)/);
      if (defaultOrNs) bindings.push(defaultOrNs[2] || defaultOrNs[3]);
    }
    record(spec, bindings);
  }

  // CJS: const x = require("spec"); require("spec");
  const cjs = sourceText.matchAll(/(?:const|let|var)\s+([^=]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)|(?<![.\w])require\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of cjs) {
    const spec = m[2] || m[3];
    if (!spec) continue;
    const bindings = [];
    if (m[1]) {
      const clause = m[1].trim();
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          const seg = part.trim();
          if (!seg) continue;
          const as = seg.split(/\s+as\s+/);
          bindings.push((as[1] || as[0]).trim());
        }
      }
      const rest = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, " ").trim();
      const d = rest.match(/(\w+)/);
      if (d) bindings.push(d[1]);
    }
    record(spec, bindings);
  }

  // Dynamic import("./x")
  const dyn = sourceText.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of dyn) record(m[1], []);

  return [...found.entries()].map(([specifier, bindings]) => ({
    specifier,
    bindings: [...bindings],
  }));
}

/**
 * Resolve a relative specifier against the importing file's directory to a
 * repository path, trying the exact specifier then common extensions and
 * index files. Deterministic candidate order.
 *
 * @returns {string[]} candidate repo paths (first existing wins at read time;
 *                    candidates are tried in order via broker lookups)
 */
export function resolveSpecifier(importingPath, specifier) {
  const dir = importingPath.includes("/") ? importingPath.slice(0, importingPath.lastIndexOf("/")) : "";
  const joined = dir ? dir + "/" + specifier : specifier;

  // Normalize ./ and ../ segments without touching the filesystem
  const segments = joined.split("/");
  const stack = [];
  for (const seg of segments) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  const base = stack.join("/");
  if (!base) return [];

  const exts = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx"];
  const candidates = [];
  for (const ext of exts) candidates.push(base + ext);
  for (const ext of [".js", ".mjs", ".cjs", ".ts", ".tsx"]) candidates.push(base + "/index" + ext);
  return candidates;
}

/**
 * Deterministically associated test files for a changed source file:
 * same directory <base>.test.<ext> / <base>.spec.<ext>, and the
 * __tests__/<base>.test.<ext> sibling convention.
 */
export function associatedTestCandidates(changedPath) {
  const parts = changedPath.split("/");
  const name = parts.pop();
  const dir = parts.join("/");
  const dot = name.lastIndexOf(".");
  if (dot === -1) return [];
  const stem = name.slice(0, dot);
  const ext = name.slice(dot);
  const p = (x) => (dir ? dir + "/" + x : x);
  return [
    p(stem + ".test" + ext),
    p(stem + ".spec" + ext),
    p(dir ? "__tests__/" + stem + ".test" + ext : "__tests__/" + stem + ".test" + ext),
  ];
}

// ── Planner ─────────────────────────────────────────────────────────────────

/**
 * Plan deterministic first-order dependencies for a review.
 *
 * @param {object} params
 * @param {object} params.evidence - ReviewEvidence (changedFiles carry patches)
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {object} [params.budgets] - broker budget overrides
 * @returns {Promise<object>} {
 *   broker,            - the shared broker (primary continues on it)
 *   seededItems,       - context items with content, blobSha, digest, reason
 *   requiredFailures,  - REQUIRED dependencies denied by hard boundaries
 *   planned,           - full deterministic plan (for audit/tests)
 * }
 */
export async function planAndSeedDependencies({ evidence, octokit, owner, repo, budgets }) {
  const reviewRoot = evidence?.review;
  const headSha = reviewRoot?.headSha;
  const broker = createContextBroker({
    octokit, owner, repo,
    baseSha: reviewRoot?.baseSha, headSha,
    budgets,
  });

  // Resolve specifiers against the immutable HEAD tree in ONE fetch —
  // per-candidate probe reads would drain the shared fileReads budget
  // before any seeding happens. One API call, deterministic path set.
  const treePaths = new Set();
  try {
    const { data: treeData } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: headSha, recursive: "1" }
    );
    for (const entry of (treeData?.tree || [])) {
      if (entry.type === "blob" && entry.path) treePaths.add(entry.path);
    }
  } catch (_e) {
    // No tree resolvable — seed nothing; the model's own exploration remains
    return { broker, seededItems: [], requiredFailures: [], skipped: [], planned: [] };
  }

  const changedPaths = new Set((evidence?.changedFiles || []).map(f => f.path));
  const required = new Map(); // path -> reason detail (patch-referenced callees)
  const optional = new Map(); // path -> reason detail (plain local imports)
  const tests = new Map(); // path -> reason detail (associated test files)

  // ONE planner allocation covering import-discovery windows AND dependency
  // seeds alike, measured from before the FIRST planner read. The primary
  // must still find ≥45K of the 90K broker budget available after planning.
  const plannerStartChars = broker.getBudgetState().retrievedChars;
  const plannerConsumed = () => broker.getBudgetState().retrievedChars - plannerStartChars;
  const plannerRemaining = () => SEED_BOUNDS.plannerCharBudget - plannerConsumed();

  // 1. Window-read each changed source file at HEAD and parse its imports.
  for (const cf of (evidence?.changedFiles || [])) {
    if (cf.status === "removed" || !isSourcePath(cf.path)) continue;

    // Import discovery also consumes the planner allocation (hard-capped
    // per read so a large window cannot overshoot it).
    const windowAllowance = plannerRemaining();
    if (windowAllowance <= 0) break; // allocation exhausted before this file
    const windowRead = await broker.readRepoFile(cf.path, headSha, {
      range: { startLine: 1, endLine: SEED_BOUNDS.importWindowLines },
      reason: "seed_import_window",
      maxChars: windowAllowance,
    });
    if (!windowRead || windowRead.error || !windowRead.content) continue;

    const patchText = cf.patch || "";
    const imports = parseLocalImports(windowRead.content);

    for (const { specifier, bindings } of imports) {
      const candidates = resolveSpecifier(cf.path, specifier);
      // First candidate present in the immutable HEAD tree wins.
      let resolvedPath = null;
      for (const cand of candidates) {
        if (changedPaths.has(cand)) { resolvedPath = null; break; } // changed file: already represented by its diff
        if (treePaths.has(cand)) { resolvedPath = cand; break; }
      }
      if (!resolvedPath) continue;

      const patchReferenced = bindings.some(b => b && patchText.includes(b));
      // Each dependency appears in the plan AT MOST ONCE, and REQUIRED wins:
      // a patch-referenced import promotes the path out of optional.
      if (patchReferenced) {
        if (!required.has(resolvedPath)) {
          optional.delete(resolvedPath);
          required.set(resolvedPath, {
            importedBy: cf.path,
            specifier,
            bindings,
            patchReferenced: true,
          });
        }
      } else if (!required.has(resolvedPath) && !optional.has(resolvedPath)) {
        optional.set(resolvedPath, {
          importedBy: cf.path,
          specifier,
          bindings,
          patchReferenced: false,
        });
      }
    }

    // 2. Deterministically associated test files for the changed source file.
    for (const cand of associatedTestCandidates(cf.path)) {
      if (changedPaths.has(cand) || required.has(cand) || optional.has(cand) || tests.has(cand)) continue;
      if (treePaths.has(cand)) tests.set(cand, { associatedWith: cf.path });
    }
  }

  // 3. Seed in tier order (required -> optional -> tests), path-sorted within
  //    each tier for determinism.
  const plan = [
    ...[...required.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, info]) => ({ path, tier: "required", reason: "local_call_dependency", info })),
    ...[...optional.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, info]) => ({ path, tier: "optional", reason: "local_import", info })),
    ...[...tests.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, info]) => ({ path, tier: "test", reason: "associated_test", info })),
  ];

  const seededItems = [];
  const requiredFailures = [];
  const skipped = [];
  let filesSeeded = 0;

  for (const entry of plan) {
    if (filesSeeded >= SEED_BOUNDS.maxSeedFiles) {
      skipped.push({ path: entry.path, reason: "seed_cap" });
      continue;
    }

    // The allocation covers windows + seeds alike and is a HARD ceiling:
    // each read is capped to the remaining allowance so no seed can
    // overshoot it.
    const remaining = plannerRemaining();
    if (remaining <= 0) {
      if (entry.tier === "required") {
        requiredFailures.push({
          path: entry.path,
          reason: "planner_allocation_exhausted",
          importedBy: entry.info.importedBy,
        });
      } else {
        skipped.push({ path: entry.path, reason: "seed_budget" });
      }
      continue;
    }

    const item = await broker.readRepoFile(entry.path, headSha, {
      range: { startLine: 1, endLine: SEED_BOUNDS.seedMaxLines },
      reason: entry.reason,
      maxChars: remaining,
    });

    if (!item || item.error) {
      if (entry.tier === "required") {
        requiredFailures.push({
          path: entry.path,
          reason: item?.reason || item?.error || "unavailable",
          importedBy: entry.info.importedBy,
        });
      } else {
        skipped.push({ path: entry.path, reason: "seed_read_failed:" + (item?.reason || item?.error) });
      }
      continue;
    }

    filesSeeded++;
    seededItems.push({
      ...item,
      retrievalReason: entry.reason,
      tier: entry.tier,
      importedBy: entry.info.importedBy || entry.info.associatedWith || null,
    });
  }

  return {
    broker,
    seededItems,
    requiredFailures,
    skipped,
    plannerCharsUsed: plannerConsumed(),
    planned: plan.map(e => ({ path: e.path, tier: e.tier, reason: e.reason, importedBy: e.info.importedBy || e.info.associatedWith || null })),
  };
}

/**
 * Merge seed results into the ReviewEvidence (context items, trace) and
 * enforce the REQUIRED-failure rule: a hard-boundary denial of a
 * deterministically required dependency makes approval evidence incomplete.
 *
 * @returns {object} the same evidence object, mutated (for caller chaining)
 */
export function applySeedResultsToEvidence(evidence, seedResult) {
  if (!evidence || !seedResult) return evidence;

  for (const item of seedResult.seededItems) {
    evidence.contextItems = evidence.contextItems || [];
    evidence.contextItems.push({
      id: item.id,
      type: item.type,
      path: item.path,
      ref: item.ref,
      resolvedSha: item.resolvedSha,
      blobSha: item.blobSha,
      contentDigest: item.contentDigest,
      range: item.range,
      truncated: item.truncated,
      content: item.content,
      retrievalReason: item.retrievalReason,
    });
  }

  if (seedResult.requiredFailures && seedResult.requiredFailures.length > 0) {
    evidence.coverage = evidence.coverage || {};
    evidence.coverage.contextRequests = evidence.coverage.contextRequests || [];
    evidence.coverage.unresolvedContextRequests = evidence.coverage.unresolvedContextRequests || [];
    for (const failure of seedResult.requiredFailures) {
      evidence.coverage.contextRequests.push({ source: "seed_required", ...failure });
      evidence.coverage.unresolvedContextRequests.push({ source: "seed_required", ...failure });
    }
    evidence.coverage.approvalEvidenceComplete = false;
  }

  return evidence;
}
