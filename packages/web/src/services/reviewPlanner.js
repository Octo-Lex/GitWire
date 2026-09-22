// src/services/reviewPlanner.js
// SC-01 P1: deterministic review-unit planner (pure, replay-only).
//
// Given the complete eligible scope (reviewScopeResolver) and the complete
// review bundle parts (reviewBundleService — complete evidence, never
// truncated), this planner decides HOW the owed evidence would be executed
// against a frozen model-context input ceiling:
//
//   complete request fits the ceiling
//     → fast_path: exactly ONE unit carrying the complete evidence, built
//       by the SAME production request builder the PC-01 complete path
//       uses (byte-identical bundle + request — no new representation).
//
//   complete request overflows
//     → multi_unit: deterministic decomposition in frozen order —
//       whole PR → whole files (greedy packing, existing file order)
//       → hunks → deterministic line regions. Overflow creates WORK,
//       never missing evidence: every eligible file/hunk/region is
//       accounted for by exactly one unit's coverage core.
//
// This module is pure and side-effect free. It makes NO provider calls,
// NO queue operations, NO database access and NO publication decisions.
// All external knowledge is injected:
//   ceiling       - the execution-unit token ceiling (production would pass
//                   MAX_PRIMARY_INPUT_TOKENS = 958,016 from
//                   reviewTokenAccounting; replays pass synthetic values)
//   buildRequest  - the production request builder (buildReviewRequest
//                   from aiReviewService) so unit requests are exactly
//                   what a future executor would send
//   oracle        - token measurement: ({model, system, userPrompt}) =>
//                   number | Promise<number>. Mirrors the countInputTokens
//                   call shape. P1 replays inject deterministic estimators;
//                   live provider counting is NOT part of P1.
//
// Planner output carries NO authority: no verdict, no publication intent,
// no check conclusion, no re-review semantics. Child-unit authority stays
// at logical-review finalization (SC-01 frozen invariants).
//
// Determinism: identical inputs plus identical oracle responses produce
// identical plans (stable unit boundaries, ordering and unit identities).
// The oracle is memoized per exact request text, so plan shape depends
// only on content, never on call order or call count.

import { createHash } from "node:crypto";

export const PLANNER_VERSION = "sc01-p1";

export const PLANNER_ERRORS = {
  E_PLANNER_SKELETON_OVERFLOW: "E_PLANNER_SKELETON_OVERFLOW",
  E_PLANNER_EVIDENCE_OVERFLOW: "E_PLANNER_EVIDENCE_OVERFLOW",
  E_PLANNER_BUNDLE_MISMATCH:   "E_PLANNER_BUNDLE_MISMATCH",
};

/**
 * Plan review units for one immutable review binding.
 *
 * @param {object} input
 * @param {{repo: string, prNumber: number, headSha: string}} input.binding
 *   Identity material the plan (and its unit ids) are bound to. One
 *   logical review = one immutable repo/PR/head.
 * @param {object} input.scope          - resolveReviewScope() output
 * @param {object} input.bundleParts    - buildReviewBundle() output built
 *   over scope.eligible (same files, same order)
 * @param {Array}  input.changedFiles   - bundleParts.changedFiles
 * @param {object} input.opts           - reviewOpts (opaque; forwarded to
 *   buildRequest only)
 * @param {Function} input.buildRequest - production request builder:
 *   (bundleText, changedFiles, opts) => {system, userPrompt}
 * @param {Function} input.oracle       - ({model, system, userPrompt}) =>
 *   number | Promise<number>
 * @param {number} input.ceiling        - execution-unit input-token ceiling
 * @returns {Promise<object>} the plan (see header) — no authority fields
 * @throws E_PLANNER_SKELETON_OVERFLOW - even the zero-evidence skeleton
 *   exceeds the ceiling; no unit can exist. Truthful failure, never a
 *   fabricated plan.
 * @throws E_PLANNER_EVIDENCE_OVERFLOW - a single diff line exceeds a whole
 *   unit's capacity; below line granularity no deterministic split exists.
 * @throws E_PLANNER_BUNDLE_MISMATCH   - bundleParts does not correspond to
 *   scope.eligible (caller wiring error).
 */
export async function planReviewUnits({
  binding, scope, bundleParts, changedFiles, opts, buildRequest, oracle, ceiling,
}) {
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    throw new TypeError("planReviewUnits: ceiling must be a positive finite number");
  }
  const files = scope.eligible;
  for (let i = 0; i < files.length; i++) {
    if (bundleParts.fileSections?.[i]?.path !== files[i].filename) {
      const err = new Error(
        "Planner bundle/scope mismatch at index " + i + ": bundle section " +
        bundleParts.fileSections?.[i]?.path + " != eligible file " + files[i].filename
      );
      err.code = PLANNER_ERRORS.E_PLANNER_BUNDLE_MISMATCH;
      throw err;
    }
  }

  // Memoized oracle: same request text → same token count, regardless of
  // call order. Determinism of the plan follows from determinism of the
  // oracle as a function of request content.
  const memo = new Map();
  const measure = async (args) => {
    const key = (args.model ?? "") + "\u0000" + (args.system ?? "") + "\u0000" + (args.userPrompt ?? "");
    if (memo.has(key)) return memo.get(key);
    const tokens = await oracle(args);
    memo.set(key, tokens);
    return tokens;
  };

  // Every emitted unit pays the skeleton once (metadata + repo context are
  // always preserved — same semantics as the PC-01 allocator).
  const units = [];
  const emit = (kind, fragments, paths, sectionTokens) => {
    units.push({ kind, fragments, files: paths, sectionTokens, tokens: null });
  };

  // ── Fast path: does the complete request fit? ───────────────────────────
  const completeRequest = buildRequest(bundleParts.bundle, changedFiles, opts);
  const completeRequestTokens = await measure({ model: opts.model, ...completeRequest });
  if (completeRequestTokens <= ceiling) {
    return finishPlan({
      binding, scope, ceiling,
      strategy: "fast_path",
      completeRequestTokens,
      skeletonTokens: 0,
      units: [{
        unitId: unitIdFor(binding, [{ kind: "complete" }]),
        ordinal: 0,
        kind: "complete",
        files: files.map((f) => f.filename),
        fragments: files.map((f) => ({ path: f.filename, hunks: "all" })),
        estimatedRequestTokens: completeRequestTokens,
        request: completeRequest,
        bundleChars: bundleParts.bundle.length,
      }],
      accountedHunks: countHunks(files),
      oracleCalls: memo.size,
    });
  }

  // ── Overflow: skeleton cost + per-section costs (admission-conservative)
  // Same accounting shape as admitPrimaryReviewEvidence: the skeleton is
  // counted once as a full request; each section is counted standalone
  // (slight overstatement of in-bundle marginal cost — conservative).
  const skeleton = bundleParts.reassemble(0);
  const skeletonRequest = buildRequest(skeleton.bundle, changedFiles, opts);
  const skeletonTokens = await measure({ model: opts.model, ...skeletonRequest });
  const unitCapacity = ceiling - skeletonTokens;
  if (unitCapacity <= 0) {
    const err = new Error(
      "Review skeleton alone exceeds the unit ceiling (" + skeletonTokens +
      " > " + ceiling + ") — no executable unit exists at this ceiling"
    );
    err.code = PLANNER_ERRORS.E_PLANNER_SKELETON_OVERFLOW;
    throw err;
  }

  const sectionTokens = [];
  for (const section of bundleParts.fileSections) {
    sectionTokens.push(await measure({ model: opts.model, userPrompt: section.text }));
  }

  // ── Whole-file greedy packing in existing (GitHub) file order ───────────
  let accountedHunks = 0;
  let curFragments = [];
  let curPaths = [];
  let curTokens = 0;
  const seal = () => {
    if (curPaths.length > 0) emit("files", curFragments, curPaths, curTokens);
    curFragments = [];
    curPaths = [];
    curTokens = 0;
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const hunks = splitPatchIntoHunks(file.patch);
    accountedHunks += hunks.length;

    if (sectionTokens[i] > unitCapacity) {
      // Oversized file: the whole-file section cannot fit any unit alone —
      // decompose this file (hunks, then regions). Never terminally omit.
      seal();
      await planOversizedFile({ file, hunks, unitCapacity, measure, model: opts.model, emit });
      continue;
    }

    if (curTokens + sectionTokens[i] > unitCapacity) seal();
    curFragments.push({ path: file.filename, hunks: "all" });
    curPaths.push(file.filename);
    curTokens += sectionTokens[i];
  }
  seal();

  return finishPlan({
    binding, scope, ceiling,
    strategy: "multi_unit",
    completeRequestTokens,
    skeletonTokens,
    units: units.map((u, ordinal) => ({
      unitId: unitIdFor(binding, u.fragments),
      ordinal,
      kind: u.kind,
      files: u.files,
      fragments: u.fragments,
      estimatedRequestTokens: skeletonTokens + u.sectionTokens,
    })),
    accountedHunks,
    oracleCalls: memo.size,
  });
}

// ── Oversized-file decomposition: hunks, then deterministic regions ────────

/**
 * Decompose one file whose whole-file section exceeds a full unit's
 * capacity. Emits file_hunks units (greedy packing of whole hunks) and,
 * for a hunk that alone exceeds a unit, hunk_regions units partitioning
 * that hunk's body into contiguous line regions (original hunk header and
 * line coordinates preserved — findings stay anchored to the canonical
 * patch, not unit-relative lines).
 */
async function planOversizedFile({ file, hunks, unitCapacity, measure, model, emit }) {
  const fileHeader = "#### " + file.filename + " (+" + file.added + " -" + file.removed + ")";
  const sectionFor = (diffText) => ["", fileHeader, "```diff", diffText, "```"].join("\n");

  // Pass 1 — measure every hunk; precompute region partitions for giant hunks.
  const hunkTokens = [];
  const giantHunkRegions = new Map();
  for (let h = 0; h < hunks.length; h++) {
    const hunkText = hunks[h].header + "\n" + hunks[h].lines.join("\n");
    const tokens = await measure({ model, userPrompt: sectionFor(hunkText) });
    hunkTokens.push(tokens);
    if (tokens > unitCapacity) {
      giantHunkRegions.set(h, await splitHunkIntoRegions({
        hunk: hunks[h], sectionFor, unitCapacity, measure, model,
      }));
    }
  }

  // Pass 2 — pack whole hunks greedily; each giant hunk's regions become
  // their own (near-capacity) units, in order.
  let curFragments = [];
  let curTokens = 0;
  const sealHunks = () => {
    if (curFragments.length > 0) emit("file_hunks", curFragments, [file.filename], curTokens);
    curFragments = [];
    curTokens = 0;
  };

  for (let h = 0; h < hunks.length; h++) {
    if (giantHunkRegions.has(h)) {
      sealHunks();
      for (const region of giantHunkRegions.get(h)) {
        emit("hunk_regions",
          [{ path: file.filename, regions: [{ hunkIndex: h, newRange: region.newRange, oldRange: region.oldRange }] }],
          [file.filename],
          region.tokens);
      }
      continue;
    }
    if (curTokens + hunkTokens[h] > unitCapacity) sealHunks();
    curFragments.push({ path: file.filename, hunks: [h] });
    curTokens += hunkTokens[h];
  }
  sealHunks();
}

/**
 * Split one oversized hunk's body into contiguous regions that each fit a
 * whole unit. Starting from the whole body and halving, the coarsest
 * granularity at which every region fits is chosen — coarser units are
 * preferred, and the only bound consulted is the ceiling via the oracle;
 * no fixed line/char constant is introduced. If a single line alone still
 * exceeds a unit, the hierarchy has no further deterministic split.
 */
async function splitHunkIntoRegions({ hunk, sectionFor, unitCapacity, measure, model }) {
  const body = hunk.lines;
  for (let size = body.length; size >= 1; size = Math.floor(size / 2)) {
    const regions = [];
    let allFit = true;
    for (let s = 0; s < body.length; s += size) {
      const chunk = body.slice(s, s + size);
      const text = hunk.header + "\n" + chunk.join("\n");
      const tokens = await measure({ model, userPrompt: sectionFor(text) });
      if (tokens > unitCapacity) { allFit = false; break; }
      regions.push({ ...hunkLineRange(hunk, body, s, chunk), tokens });
    }
    if (allFit) return regions;
    if (size === 1) {
      // Even a single line exceeds a whole unit — fail truthfully rather
      // than fabricate or omit.
      const err = new Error(
        "A single diff line exceeds the unit ceiling — no deterministic split exists below line granularity"
      );
      err.code = PLANNER_ERRORS.E_PLANNER_EVIDENCE_OVERFLOW;
      throw err;
    }
  }
  const unreachable = new Error("splitHunkIntoRegions: unreachable exit");
  unreachable.code = PLANNER_ERRORS.E_PLANNER_EVIDENCE_OVERFLOW;
  throw unreachable;
}

/**
 * New/old absolute line interval covered by one region of a hunk body,
 * walking the body from the hunk's header coordinates.
 */
function hunkLineRange(hunk, body, offset, chunk) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let i = 0; i < offset; i++) {
    const line = body[i];
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) oldLine++;
    else if (line.startsWith("+")) newLine++;
    else { oldLine++; newLine++; }
  }
  let oldRange = null;
  let newRange = null;
  const track = (side, value) => {
    if (value == null) return;
    const range = side === "old" ? (oldRange ??= [value, value]) : (newRange ??= [value, value]);
    range[1] = value;
  };
  for (const line of chunk) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) { track("old", oldLine); oldLine++; }
    else if (line.startsWith("+")) { track("new", newLine); newLine++; }
    else { track("old", oldLine); track("new", newLine); oldLine++; newLine++; }
  }
  return { newRange, oldRange };
}

// ── Unified-diff parsing (deterministic) ───────────────────────────────────

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split a unified-diff patch into hunks, preserving the original header
 * (line coordinates) of each. A patch with no @@ headers is treated as a
 * single hunk with unknown coordinates (defensive; GitHub patches always
 * carry headers).
 */
export function splitPatchIntoHunks(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let current = null;
  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) {
      if (current) hunks.push(current);
      current = {
        header: line,
        lines: [],
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newCount: m[4] === undefined ? 1 : parseInt(m[4], 10),
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0 && lines.length > 0) {
    hunks.push({ header: "(whole patch)", lines, oldStart: null, oldCount: null, newStart: null, newCount: null });
  }
  return hunks;
}

// ── Plan assembly ──────────────────────────────────────────────────────────

function countHunks(files) {
  let n = 0;
  for (const f of files) n += splitPatchIntoHunks(f.patch).length;
  return n;
}

function unitIdFor(binding, fragments) {
  const canonical = JSON.stringify({
    plannerVersion: PLANNER_VERSION,
    repo: binding.repo,
    prNumber: binding.prNumber,
    headSha: binding.headSha,
    fragments,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function finishPlan({ binding, scope, ceiling, strategy, completeRequestTokens, units, accountedHunks, oracleCalls }) {
  const coveredFiles = [];
  for (const unit of units) {
    for (const path of unit.files) if (!coveredFiles.includes(path)) coveredFiles.push(path);
  }
  const eligiblePaths = scope.eligible.map((f) => f.filename);
  const unaccountedEvidence = eligiblePaths.filter((p) => !coveredFiles.includes(p));

  // Mechanically derived completeness — the model never decides coverage.
  // Genuine source unavailability (no_patch) is truthful INCOMPLETE, never
  // fabricated coverage; policy exemptions are explicit non-obligations.
  const plannedCoverage = {
    complete:
      scope.paginationCapped !== true &&
      scope.unavailable.length === 0 &&
      unaccountedEvidence.length === 0,
    coveredFiles,
    accountedHunks,
    unaccountedEvidence,
    policyExemptFiles: scope.policyExempt.length,
    sourceUnavailableFiles: scope.unavailable.length,
    paginationCapped: scope.paginationCapped === true,
  };

  return {
    plannerVersion: PLANNER_VERSION,
    strategy,
    ceiling,
    binding: { ...binding },
    scope: {
      totalChangedFiles: scope.totalChangedFiles,
      eligibleFiles: scope.eligible.length,
      policyExempt: scope.policyExempt.map((e) => ({ path: e.path, reason: e.reason })),
      unavailable: scope.unavailable.map((e) => ({ path: e.path, reason: e.reason })),
      paginationCapped: scope.paginationCapped === true,
    },
    completeRequestTokens,
    units,
    plannedCoverage,
    oracleCalls,
  };
}
