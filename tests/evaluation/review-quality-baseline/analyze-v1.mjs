// analyze-v1.mjs — deterministic Track B baseline metrics.
// Inputs: raw-extract-v1.jsonl, coverage-classification-v1.json, adjudication-dataset-v1.json
// Run: node analyze-v1.mjs   (from this directory)
// Output: JSON metrics on stdout. No network, no randomness, no dates.

import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./raw-extract-v1.jsonl", import.meta.url), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const cov = JSON.parse(readFileSync(new URL("./coverage-classification-v1.json", import.meta.url), "utf-8"));
const adj = JSON.parse(readFileSync(new URL("./adjudication-dataset-v1.json", import.meta.url), "utf-8"));
const manifest = JSON.parse(readFileSync(new URL("./cohort-manifest-v1.json", import.meta.url), "utf-8"));

const byId = new Map(raw.map((r) => [r.receipt_id, r]));
const versionById = new Map(manifest.cohort.map((c) => [c.receipt_id, c.version_cohort]));
const findings = adj.findings;

const count = (arr, key) => {
  const m = {};
  for (const x of arr) m[x[key]] = (m[x[key]] || 0) + 1;
  return m;
};
const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

const out = { metric_families: {} };

// ── Integrity ──────────────────────────────────────────────────────────────
out.metric_families.integrity = {
  reviews: raw.length,
  complete: raw.filter((r) => r.integrity_state === "COMPLETE").length,
  incomplete: raw.filter((r) => r.integrity_state === "INCOMPLETE").length,
  incomplete_rate_pct: pct(raw.filter((r) => r.integrity_state === "INCOMPLETE").length, raw.length),
};

// ── Coverage ───────────────────────────────────────────────────────────────
const mech = {};
for (const c of cov) for (const [k, v] of Object.entries(c.loss_mechanisms)) mech[k] = (mech[k] || 0) + v;
const reviewsWith = (name) => cov.filter((c) => (c.loss_mechanisms[name] || 0) > 0).length;
const totalFiles = cov.reduce((a, c) => a + c.total_files, 0);
const fullFiles = cov.reduce((a, c) => a + c.full, 0);
out.metric_families.coverage = {
  total_changed_files: totalFiles,
  fully_reviewed_files: fullFiles,
  reviewed_file_share_pct: pct(fullFiles, totalFiles),
  file_loss_mechanisms: mech,
  reviews_with_patch_truncated: reviewsWith("patch_truncated"),
  reviews_with_max_lines_exceeded: reviewsWith("max_lines_exceeded"),
  reviews_exceeding_line_budget: cov.filter((c) => c.limits.includes("max_lines_to_review")).length,
  reviews_incomplete_without_line_budget:
    cov.filter((c) => c.approval_evidence_complete === false && !c.limits.includes("max_lines_to_review")).length,
};

// ── Finding precision / usefulness / calibration / evidence ────────────────
const seg = (arr) => ({
  n: arr.length,
  validity: count(arr, "validity"),
  usefulness: count(arr, "usefulness"),
  severity_calibration: count(arr, "severity_calibration"),
  evidence_quality: count(arr, "evidence_quality"),
  valid_rate_pct: pct((count(arr, "validity").VALID || 0), arr.length),
  invalid_rate_pct: pct((count(arr, "validity").INVALID || 0), arr.length),
});
out.metric_families.finding_precision = { overall: seg(findings), by_native_severity: {} };
for (const s of ["high", "medium", "low"]) {
  out.metric_families.finding_precision.by_native_severity[s] = seg(findings.filter((f) => f.severity_native === s));
}
out.metric_families.usefulness = count(findings, "usefulness");
out.metric_families.verification = {
  evidence_valid_true: seg(findings.filter((f) => f.evidence_valid)),
  evidence_valid_false: seg(findings.filter((f) => !f.evidence_valid)),
};
out.metric_families.calibration = count(findings, "severity_calibration");
out.metric_families.evidence = count(findings, "evidence_quality");

// ── Publication / operations ───────────────────────────────────────────────
out.metric_families.publication = {
  receipts: raw.length,
  github_identity_reconciled: manifest.identity_reconciliation.result,
  duplicate_publications: manifest.eligibility_filter.duplicate_publications_per_pr,
  events: count(raw.map((r) => ({ event: "COMMENT" })), "event"),
};
const durations = raw.map((r) => r.duration_ms).filter((x) => x != null).sort((a, b) => a - b);
const tokens = raw.map((r) => r.tokens_used).filter((x) => x != null).sort((a, b) => a - b);
const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
out.metric_families.operations = {
  duration_ms_median: med(durations), duration_ms_min: durations[0], duration_ms_max: durations[durations.length - 1],
  tokens_median: med(tokens), tokens_min: tokens[0], tokens_max: tokens[tokens.length - 1],
  tokens_total: tokens.reduce((a, b) => a + b, 0),
};

// ── Cohort segmentation: code version and diff size ────────────────────────
const covById = new Map(cov.map((c) => [c.receipt_id, c]));
out.metric_families.cohorts = { by_version: {}, by_diff_size: {} };
for (const v of ["v1.2", "v1.2.1"]) {
  const ids = manifest.cohort.filter((c) => c.version_cohort === v).map((c) => c.receipt_id);
  const fs = findings.filter((f) => ids.includes(f.receipt_id));
  out.metric_families.cohorts.by_version[v] = {
    reviews: ids.length,
    incomplete_reviews: ids.filter((id) => byId.get(id).integrity_state === "INCOMPLETE").length,
    findings: seg(fs),
    median_changed_files: med(ids.map((id) => covById.get(id).total_files).sort((a, b) => a - b)),
  };
}
const smallIds = cov.filter((c) => c.total_files <= 15).map((c) => c.receipt_id);
const largeIds = cov.filter((c) => c.total_files > 15).map((c) => c.receipt_id);
for (const [name, ids] of [["small_3_to_15_files", smallIds], ["large_17_to_20_files", largeIds]]) {
  const fs = findings.filter((f) => ids.includes(f.receipt_id));
  out.metric_families.cohorts.by_diff_size[name] = {
    reviews: ids.length,
    findings: seg(fs),
    median_changed_files: med(ids.map((id) => covById.get(id).total_files).sort((a, b) => a - b)),
    median_partial_files: med(ids.map((id) => covById.get(id).partial).sort((a, b) => a - b)),
  };
}

console.log(JSON.stringify(out, null, 1));
