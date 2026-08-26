// harness-v1.mjs — Gate C readiness scenarios on the frozen 25-review cohort.
// Uses the REAL admission logic (buildFileCoverage from production src) and the
// equivalence-proven bundle replica at caps 4k (production) and 12k
// (intervention), under context bounds LO (structural minimum) and HI
// (structural maximum). Produces per-review accounting and aggregate metrics.
//
// Run from the repo root: node tests/evaluation/review-quality-baseline/gatec-readiness/harness-v1.mjs
// Zero network at run time (inputs are committed); zero model calls.

import { readFileSync } from "node:fs";
import { buildFileCoverage } from "../../../../packages/web/src/services/reviewCoverageService.js";
import { buildBundleReplica, CONTEXT_LO, contextHI, prWithBody, configLO, configHI } from "./bundle-replica.mjs";

const HERE = new URL(".", import.meta.url);
const inputs = JSON.parse(readFileSync(new URL("./pr-files-v1.json", HERE), "utf-8"));
const cov = JSON.parse(readFileSync(new URL("../coverage-classification-v1.json", HERE), "utf-8"));
const covById = new Map(cov.map((c) => [c.receipt_id, c]));

const CFG = { ignore_patterns: [], max_files_to_review: 30, max_lines_to_review: 2000 };
const CAPS = [4000, 12000];
const SCENARIOS = [
  { name: "lo", ctx: () => CONTEXT_LO, cfg: () => configLO(), body: "" },
  { name: "hi", ctx: () => contextHI(), cfg: () => configHI(), body: "d".repeat(2000) },
];

const results = { scenarios: {}, per_review: {} };

for (const sc of SCENARIOS) {
  for (const cap of CAPS) {
    const key = `cap_${cap}_${sc.name}`;
    const per = [];
    for (const [rid, rev] of Object.entries(inputs)) {
      // Real production admission (cap-independent): GitHub file objects in
      // API order — identical to what fetchChangedPages delivered historically.
      const prFiles = rev.files.map((f) => ({
        filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
        patch: f.patch || null, sha: f.sha,
      }));
      const admitted = buildFileCoverage({ prFiles, cfg: CFG, headSha: "h", paginationCapped: false });
      const bundle = buildBundleReplica({
        files: admitted.files, pr: prWithBody(rev.pr_stub, sc.body),
        repository: { full_name: rev.repo, id: 1 }, config: sc.cfg(), context: sc.ctx(), cap,
      });
      // Combine: admission partials (max_files/max_lines) then bundle
      // adjustments (patch/bundle truncation) — same precedence as
      // finalizeCoverage (later adjustments overwrite earlier per path).
      const status = new Map(admitted.coverage.files.map((f) => [f.path, f.coverage]));
      for (const adj of bundle.coverageAdjustments) status.set(adj.path, "partial");
      const reasons = new Map(admitted.coverage.files.filter((f) => f.reason).map((f) => [f.path, f.reason]));
      for (const adj of bundle.coverageAdjustments) reasons.set(adj.path, adj.reason);
      const mechs = {};
      for (const r of reasons.values()) mechs[r] = (mechs[r] || 0) + 1;
      const full = [...status.values()].filter((s) => s === "full").length;
      const exempt = [...status.values()].filter((s) => s === "policy_exempt").length;
      per.push({
        receipt_id: Number(rid), pr: rev.pr, repo: rev.repo,
        total_files: rev.files.length, admitted: admitted.files.length,
        full, partial: rev.files.length - full - exempt, exempt,
        evidence_complete: (full + exempt) === rev.files.length,
        limits: admitted.coverage.limitsExceeded, mechanisms: mechs,
        bundle_chars: bundle.totalChars,
      });
    }
    const totalFiles = per.reduce((a, p) => a + p.total_files, 0);
    const fullFiles = per.reduce((a, p) => a + p.full, 0);
    const mechs = {};
    for (const p of per) for (const [k, v] of Object.entries(p.mechanisms)) mechs[k] = (mechs[k] || 0) + v;
    results.scenarios[key] = {
      fully_reviewed_files: fullFiles, total_changed_files: totalFiles,
      reviewed_file_share_pct: Math.round((fullFiles / totalFiles) * 1000) / 10,
      reviews_evidence_complete: per.filter((p) => p.evidence_complete).length,
      reviews_incomplete: per.filter((p) => !p.evidence_complete).length,
      reviews_with_patch_truncation: per.filter((p) => (p.mechanisms.patch_truncated || 0) > 0).length,
      reviews_with_bundle_truncation: per.filter((p) => (p.mechanisms.bundle_truncated || 0) > 0).length,
      reviews_line_limit_tripped: per.filter((p) => p.limits.includes("max_lines_to_review")).length,
      file_loss_mechanisms: mechs,
      max_bundle_chars: Math.max(...per.map((p) => p.bundle_chars)),
    };
    if (sc.name === "lo" && cap === 4000) results.per_review.baseline = per;
    if (sc.name === "lo" && cap === 12000) results.per_review.intervention_lo = per;
    if (sc.name === "hi" && cap === 12000) results.per_review.intervention_hi = per;
  }
}

// Reconciliation: modeled 4k-LO vs durable production coverage records.
const durable = { full: 0, partial: 0, patch_truncated: 0, max_lines_exceeded: 0, line_trips: 0, mismatches: [] };
for (const p of results.per_review.baseline) {
  const obs = covById.get(p.receipt_id);
  durable.full += p.full; durable.partial += p.partial;
  durable.patch_truncated += p.mechanisms.patch_truncated || 0;
  durable.max_lines_exceeded += p.mechanisms.max_lines_exceeded || 0;
  if (p.limits.includes("max_lines_to_review")) durable.line_trips++;
  if (obs && (obs.full !== p.full || obs.partial !== p.partial)) {
    durable.mismatches.push({ receipt_id: p.receipt_id, modeled_full: p.full, observed_full: obs.full,
      modeled_partial: p.partial, observed_partial: obs.partial,
      modeled_mechs: p.mechanisms, observed_mechs: obs.loss_mechanisms });
  }
}
results.reconciliation_4k_vs_durable = durable;

console.log(JSON.stringify(results, null, 1));
