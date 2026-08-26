// bundle-replica.mjs — byte-exact replica of the PRODUCTION bundle assembly
// from packages/web/src/services/reviewBundleService.js (master 53d67c5),
// parameterized ONLY by the per-file cap, with db-backed context sections
// supplied as inputs instead of queried. The jest equivalence proof
// (packages/web/tests/unit/gatec-readiness-equivalence.test.js) asserts this
// replica produces byte-identical bundles and identical coverageAdjustments
// against the real builder on all 25 frozen-cohort reviews, in both context
// scenarios. Production defaults remain 4k; 12k is the Gate C intervention.

export const MAX_BUNDLE_CHARS = 180000;

export function buildBundleReplica({ files, pr, repository, config = {}, context = { issues: [], ci: [], priorReviews: [] }, cap }) {
  const repoFullName = repository.full_name;
  const parts = [];
  const changedFiles = files.map(function (f) { return f.filename; });
  const coverageAdjustments = [];

  // ── 1. PR Metadata ── (exact production formatting)
  parts.push("## PR Metadata");
  parts.push("Repository: " + repoFullName);
  parts.push("PR #" + pr.number + ": " + pr.title);
  parts.push("Author: @" + pr.user.login);
  parts.push("Base: " + pr.base.ref + " ← Head: " + pr.head.ref);
  parts.push("Commits: " + (pr.commits || "?") + "  Changed files: " + files.length);
  if (pr.body && pr.body.trim()) {
    parts.push("");
    parts.push("### Description");
    parts.push(pr.body.trim().slice(0, 2000));
  }

  // ── 2. Diff Sections ──
  parts.push("");
  parts.push("## Changes");
  parts.push("");
  parts.push("### File Summary");
  for (const f of files) {
    parts.push("  " + f.status.padEnd(10) + " " + f.filename + " (+" + f.added + " -" + f.removed + ")");
  }
  parts.push("");
  parts.push("### Diffs");
  for (const f of files) {
    parts.push("");
    parts.push("#### " + f.filename + " (+" + f.added + " -" + f.removed + ")");
    if (f.patch) {
      if (f.patch.length > cap) {
        coverageAdjustments.push({ path: f.filename, coverage: "partial", reason: "patch_truncated" });
      }
      const patch = f.patch.length > cap ? f.patch.slice(0, cap) + "\n... (truncated)" : f.patch;
      parts.push("```diff");
      parts.push(patch);
      parts.push("```");
    } else {
      parts.push("(no diff available — binary or large file)");
    }
  }

  // ── 3. Repo Context ── (production queries these; replica receives them)
  parts.push("");
  parts.push("## Repository Context");
  if (context.issues.length > 0) {
    parts.push("");
    parts.push("### Recent Open Issues");
    for (const issue of context.issues) {
      const labels = Array.isArray(issue.labels) && issue.labels.length > 0 ? " [" + issue.labels.join(", ") + "]" : "";
      parts.push("  #" + issue.number + ": " + issue.title + labels);
    }
  }
  if (context.ci.length > 0) {
    parts.push("");
    parts.push("### Recent CI Runs");
    for (const run of context.ci) {
      const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⚪";
      parts.push("  " + icon + " " + run.head_branch + " — " + run.conclusion);
    }
  }
  if (context.priorReviews.length > 0) {
    parts.push("");
    parts.push("### Prior AI Reviews");
    for (const rev of context.priorReviews) {
      parts.push("  PR #" + rev.pr_number + ": " + rev.verdict + " (" + rev.confidence + " confidence, " + rev.finding_count + " findings)");
    }
  }

  // ── 4. Config Snapshot ──
  parts.push("");
  parts.push("## Active Configuration");
  const aiReviewCfg = config.pillars?.ai_review || {};
  parts.push("AI Review enabled: " + (aiReviewCfg.enabled !== false ? "yes" : "no"));
  const gates = config.quality_gates || {};
  const gateNames = Object.keys(gates);
  if (gateNames.length > 0) {
    parts.push("Quality gates: " + gateNames.join(", "));
    for (const [name, gate] of Object.entries(gates)) {
      if (gate.conditions) {
        const condSummary = gate.conditions.map(function (c) {
          return c.metric + " " + c.operator + " " + c.threshold;
        }).join(", ");
        parts.push("  " + name + ": " + condSummary);
      }
    }
  }
  if (aiReviewCfg.architecture_context) {
    parts.push("");
    parts.push("## Architecture Context");
    parts.push(aiReviewCfg.architecture_context.slice(0, 3000));
  }

  // ── Assemble and truncate ── (exact production rebuild semantics)
  let bundle = parts.join("\n");
  if (bundle.length > MAX_BUNDLE_CHARS) {
    const metaEnd = bundle.indexOf("## Changes");
    const contextStart = bundle.indexOf("## Repository Context");
    if (metaEnd !== -1 && contextStart !== -1) {
      const meta = bundle.slice(0, metaEnd);
      const context = bundle.slice(contextStart);
      const diffBudget = MAX_BUNDLE_CHARS - meta.length - context.length - 100;
      if (diffBudget > 2000) {
        const diffParts = [];
        let diffChars = 0;
        for (const f of files) {
          const sliceCap = Math.min(cap, diffBudget - diffChars - 100);
          const fileDiff = "#### " + f.filename + " (+" + f.added + " -" + f.removed + ")\n```diff\n" +
            (f.patch ? f.patch.slice(0, sliceCap) : "(no diff)") + "\n```";
          if (diffChars + fileDiff.length > diffBudget) {
            for (const rest of files.slice(files.indexOf(f))) {
              coverageAdjustments.push({ path: rest.filename, coverage: "partial", reason: "bundle_truncated" });
            }
            break;
          }
          if (f.patch && f.patch.length > sliceCap) {
            coverageAdjustments.push({ path: f.filename, coverage: "partial", reason: "bundle_truncated" });
          }
          diffParts.push(fileDiff);
          diffChars += fileDiff.length;
        }
        bundle = meta + "## Changes\n\n### Diffs\n\n" + diffParts.join("\n\n") + "\n\n" + context;
      } else {
        for (const f of files) {
          coverageAdjustments.push({ path: f.filename, coverage: "partial", reason: "bundle_truncated" });
        }
        bundle = bundle.slice(0, MAX_BUNDLE_CHARS) + "\n\n... (bundle truncated)";
      }
    } else {
      for (const f of files) {
        coverageAdjustments.push({ path: f.filename, coverage: "partial", reason: "bundle_truncated" });
      }
      bundle = bundle.slice(0, MAX_BUNDLE_CHARS) + "\n\n... (bundle truncated)";
    }
  }

  return { bundle, changedFiles, totalChars: bundle.length, coverageAdjustments };
}

// Context scenarios. LO = every db context query returned nothing (structural
// minimum). HI = every section populated to its structural maximum (5 issues
// with labels, 5 CI runs, 5 prior reviews, a 2000-char PR body, a 3000-char
// architecture context, one quality gate) — the largest meta+context the
// production formatter can emit, hence the tightest aggregate budget.
export const CONTEXT_LO = { issues: [], ci: [], priorReviews: [] };

export function contextHI() {
  const label = "lane:repository";
  return {
    issues: Array.from({ length: 5 }, (_, i) => ({ number: 100 + i, title: "issue title " + i + " " + "x".repeat(40), state: "open", labels: [label, "bug"] })),
    ci: Array.from({ length: 5 }, (_, i) => ({ head_branch: "branch-" + i + "-" + "y".repeat(20), conclusion: i % 2 ? "failure" : "success" })),
    priorReviews: Array.from({ length: 5 }, (_, i) => ({ pr_number: 200 + i, verdict: i % 2 ? "needs_discussion" : "approved", confidence: "high", finding_count: 3 })),
  };
}

export function prWithBody(prStub, body) {
  return { ...prStub, body };
}

export function configLO() {
  return {};
}

export function configHI() {
  return {
    pillars: { ai_review: { enabled: true, architecture_context: "z".repeat(3000) } },
    quality_gates: { gateA: { conditions: [{ metric: "coverage", operator: ">=", threshold: "80" }] } },
  };
}
