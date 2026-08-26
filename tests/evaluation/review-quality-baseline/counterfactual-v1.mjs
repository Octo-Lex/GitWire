// counterfactual-v1.mjs — deterministic offline counterfactual for the Gate C
// redistribution hypothesis. Replays GitWire's admission + bundle logic on the
// frozen cohort's REAL patch lengths at per-file caps of 4,000 (production) and
// 12,000 (proposed), with the same 180,000-char aggregate budget and the same
// 2,000-line admission limit. Zero model calls, zero production mutation.
//
// Run: node counterfactual-v1.mjs   (from this directory)

import { readFileSync } from "node:fs";

const patches = JSON.parse(readFileSync(new URL("./pr-patch-lengths-v1.json", import.meta.url), "utf-8"));
const cov = JSON.parse(readFileSync(new URL("./coverage-classification-v1.json", import.meta.url), "utf-8"));

const MAX_FILES = 30;            // ai_review_config.max_files_to_review (cohort-wide)
const MAX_LINES = 2000;          // ai_review_config.max_lines_to_review (cohort-wide)
const AGGREGATE = 180000;        // MAX_BUNDLE_CHARS
const HEADER = 60;               // approx bytes of the per-file bundle header ("#### name (+a -d)\n```diff\n")
const META_CONTEXT = 4000;       // approx bytes of metadata + repo-context sections reserved

function simulate(files, cap) {
  // Admission (reviewCoverageService.buildFileCoverage order): API order,
  // ignore patterns empty in this cohort, file cap non-binding (<=20 files).
  const admitted = [];
  let lineTotal = 0;
  let lineTrippedAt = -1;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (admitted.length >= MAX_FILES) break;
    const lines = (f.additions ?? 0) + (f.deletions ?? 0);
    if (lineTotal + lines > MAX_LINES) { lineTrippedAt = i; lineTotal += lines; break; }
    lineTotal += lines;
    admitted.push(f);
  }
  const status = new Map(); // filename -> "full" | "max_lines_exceeded" | "patch_truncated" | "bundle_truncated"
  for (let i = 0; i < files.length; i++) {
    if (lineTrippedAt !== -1 && i >= lineTrippedAt) status.set(files[i].filename, "max_lines_exceeded");
  }
  // Bundle assembly (reviewBundleService): per-file cap, then aggregate rebuild.
  for (const f of admitted) {
    const len = f.patch_len ?? 0;
    if (len > 0 && len > cap) status.set(f.filename, "patch_truncated");
  }
  const diffBudget = AGGREGATE - META_CONTEXT;
  let used = 0;
  for (const f of admitted) {
    const piece = HEADER + Math.min(f.patch_len ?? 0, cap);
    if (used + piece > diffBudget) { status.set(f.filename, "bundle_truncated"); continue; }
    used += piece;
  }
  // Coverage outcome: a review is evidence-complete only when every changed
  // file is full (or policy-exempt) AND the line budget never tripped.
  let full = 0, partial = 0;
  const mechs = { patch_truncated: 0, bundle_truncated: 0, max_lines_exceeded: 0 };
  for (const f of files) {
    const s = status.get(f.filename) ?? "full";
    if (s === "full") full++; else { partial++; mechs[s] = (mechs[s] || 0) + 1; }
  }
  const complete = partial === 0 && lineTrippedAt === -1;
  return { full, total: files.length, partial, mechs, complete, lineTripped: lineTrippedAt !== -1 };
}

const caps = [4000, 12000];
const results = {};
for (const cap of caps) {
  const per = [];
  for (const [rid, d] of Object.entries(patches)) {
    if (d.error || !d.files) continue;
    per.push({ receipt_id: Number(rid), ...simulate(d.files, cap) });
  }
  const totalFiles = per.reduce((a, p) => a + p.total, 0);
  const fullFiles = per.reduce((a, p) => a + p.full, 0);
  const mech = { patch_truncated: 0, bundle_truncated: 0, max_lines_exceeded: 0 };
  for (const p of per) for (const [k, v] of Object.entries(p.mechs)) mech[k] += v;
  results[`cap_${cap}`] = {
    fully_reviewed_files: fullFiles,
    total_changed_files: totalFiles,
    reviewed_file_share_pct: Math.round((fullFiles / totalFiles) * 1000) / 10,
    reviews_evidence_complete: per.filter((p) => p.complete).length,
    reviews_incomplete: per.filter((p) => !p.complete).length,
    reviews_with_patch_truncation: per.filter((p) => (p.mechs.patch_truncated || 0) > 0).length,
    reviews_with_bundle_truncation: per.filter((p) => (p.mechs.bundle_truncated || 0) > 0).length,
    reviews_line_limit_tripped: per.filter((p) => p.lineTripped).length,
    file_loss_mechanisms: mech,
  };
}
// Fidelity check: modeled cap_4000 vs observed production baseline.
const observed = {
  fully_reviewed_files: cov.reduce((a, c) => a + c.full, 0),
  total_changed_files: cov.reduce((a, c) => a + c.total_files, 0),
  patch_truncated: 201, max_lines_exceeded: 118, reviews_line_limit_tripped: 21,
};
console.log(JSON.stringify({ modeled: results, observed_baseline: observed }, null, 1));
