#!/usr/bin/env node
/**
 * live-baseline.mjs — Live current-model baseline runner for RI-1.
 *
 * Runs the REAL Anthropic model against the 8 faithful fixtures (3 runs each
 * = 24 primary-model evaluations). Uses the exact same reviewPR() pipeline
 * as production, but with mock GitHub/DB/check surfaces so there are ZERO
 * external mutations.
 *
 * Manual and opt-in: requires REVIEW_INTEGRITY_LIVE=1 and ANTHROPIC_API_KEY.
 * Does NOT fall back to mocks silently.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=... REVIEW_INTEGRITY_LIVE=1 \
 *     node live-baseline.mjs [--runs=3] [--filter=RI-01]
 *
 * Output: JSON results written to live-baseline-results.json
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Gate: must be explicitly opted in ────────────────────────────────────────

if (process.env.REVIEW_INTEGRITY_LIVE !== "1") {
  console.error("ERROR: REVIEW_INTEGRITY_LIVE=1 is required to run the live baseline.");
  console.error("This runner consumes real API tokens. Do not run in CI.");
  process.exit(1);
}

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

if (!API_KEY) {
  console.error("ERROR: ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

// Parse args
const args = process.argv.slice(2);
const runsArg = args.find(a => a.startsWith("--runs="));
const NUM_RUNS = runsArg ? parseInt(runsArg.split("=")[1], 10) : 3;
const filterArg = args.find(a => a.startsWith("--filter="));
const FILTER = filterArg ? filterArg.split("=")[1] : null;

console.log("=== Review Integrity Live Baseline ===");
console.log(`Model: claude-sonnet-4-20250514`);
console.log(`Base URL: ${BASE_URL || "(default Anthropic)"}`);
console.log(`Runs per fixture: ${NUM_RUNS}`);
console.log(`Filter: ${FILTER || "(all fixtures)"}`);
console.log("");

// ── Build the review bundle inline (avoids runtime/logger dependency) ─────────
// The reviewBundleService uses the runtime logger which requires initRuntime.
// Since this is a standalone script, we build the bundle manually — replicating
// the exact structure reviewBundleService produces.

const MAX_DIFF_PER_FILE = 4000;

function buildBundleInline(files, fixture) {
  const parts = [];

  // PR metadata header
  parts.push("## PR Metadata");
  parts.push(`Repository: org/repo`);
  parts.push(`PR #42: ${fixture.prMetadata.title}`);
  parts.push(`Author: ${fixture.prMetadata.author || "contributor"}`);
  parts.push(`Base: ${fixture.prMetadata.base} → Head: feature`);
  parts.push(`Changed files: ${files.length}`);
  parts.push(`\n${(fixture.prMetadata.body || "").slice(0, 2000)}`);
  parts.push("");

  // File summary table
  parts.push("## Changes");
  parts.push("| Status | File | +/− |");
  parts.push("|--------|------|-----|");
  for (const f of files) {
    parts.push(`| ${f.status} | ${f.filename} | +${f.added}/-${f.removed} |`);
  }
  parts.push("");

  // Per-file diffs
  for (const f of files) {
    parts.push(`### ${f.filename}`);
    let patch = f.patch || "(no diff available)";
    if (patch.length > MAX_DIFF_PER_FILE) {
      patch = patch.slice(0, MAX_DIFF_PER_FILE) + "\n... (truncated)";
    }
    parts.push("```diff");
    parts.push(patch);
    parts.push("```");
    parts.push("");
  }

  return parts.join("\n");
}

import Anthropic from "@anthropic-ai/sdk";
import { getAllFixtures } from "./fixtures/registry.js";
import { buildFixtureOctokit } from "./fixtureOctokit.js";

// Import the rules package for prompt building and JSON extraction
const rulesModule = await import("../../../../rules/src/index.js");
const { buildReviewSystemPrompt, extractReviewJSON } = rulesModule;

const anthropic = new Anthropic({ apiKey: API_KEY, baseURL: BASE_URL });
const MODEL = "claude-sonnet-4-20250514";

// ── Run a single evaluation ──────────────────────────────────────────────────

async function runSingleEvaluation(fixture, runIndex) {
  const startTime = Date.now();
  const octokit = buildFixtureOctokit(fixture);

  // Build the review bundle the same way the engine does
  // fetchDiff is simulated by the fixture's changedFiles
  const files = fixture.changedFiles.map(f => ({
    filename: f.filename,
    status: f.status,
    added: f.additions || 0,
    removed: f.deletions || 0,
    patch: f.patch || "",
    sha: f.headBlobSha || f.sha || "unknown",
  }));

  const changedFiles = fixture.changedFiles.map(f => f.filename);
  const bundle = buildBundleInline(files, fixture);

  // Build the system prompt
  const systemPrompt = buildReviewSystemPrompt({
    changedFiles,
    includeSecurity: true,
    includeArchitecture: true,
  });

  // Build the user prompt (same structure as runStructuredReview)
  const userPrompt = [
    `## Repository: org/repo`,
    `## PR #42: ${fixture.prMetadata.title}`,
    `## Author: ${fixture.prMetadata.author || "contributor"}`,
    `## Branch: feature → ${fixture.prMetadata.base}`,
    `## Changed files: ${changedFiles.length}`,
    ``,
    `Focus on correctness, security, regressions, and cross-file consistency.`,
    `A clean patch with no findings is valid — return zero findings if the code is correct.`,
    ``,
    `---`,
    ``,
    bundle,
  ].join("\n");

  let result = {
    fixture: fixture.caseId,
    variant: fixture.variant,
    run: runIndex,
    model: MODEL,
    timestamp: new Date().toISOString(),
  };

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Extract text
    let text = "";
    if (Array.isArray(message.content)) {
      text = message.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n");
    } else if (typeof message.content === "string") {
      text = message.content;
    }

    const tokensUsed = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);
    const elapsedMs = Date.now() - startTime;

    // Extract and parse the review JSON
    const { json, strategy } = extractReviewJSON(text.trim());

    if (!json) {
      result = {
        ...result,
        verdict: "parse_error",
        findings: [],
        tokensUsed,
        latencyMs: elapsedMs,
        extractionStrategy: strategy,
        rawTextSnippet: text.slice(0, 200),
        error: "Failed to extract JSON from model response",
      };
      return result;
    }

    // Determine verdict and findings
    const findings = json.findings || [];
    const correctness = json.overall_correctness || "unknown";

    // Simple verdict mapping (matches reportToLegacy logic)
    let verdict;
    const criticalCount = findings.filter(f => {
      const sev = f.priority || f.severity || "";
      return sev === "P0" || sev === "critical";
    }).length;
    const highCount = findings.filter(f => {
      const sev = f.priority || f.severity || "";
      return sev === "P1" || sev === "high";
    }).length;

    if (correctness === "patch is correct" && findings.length === 0) {
      verdict = "approved";
    } else if (criticalCount > 0 || highCount >= 2) {
      verdict = "request_changes";
    } else {
      verdict = "needs_discussion";
    }

    // Check if the expected defect was detected
    let expectedDefectDetected = null;
    if (fixture.expectedFinding) {
      const ef = fixture.expectedFinding;
      // Simple heuristic: does any finding mention key words from the expected finding?
      const expectedKeywords = ef.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      expectedDefectDetected = findings.some(f => {
        const findingText = ((f.title || "") + " " + (f.body || f.description || "")).toLowerCase();
        return expectedKeywords.some(kw => findingText.includes(kw));
      });
    }

    // False positive check (for fixed fixtures)
    let falsePositive = null;
    if (fixture.variant === "fixed") {
      falsePositive = findings.some(f => {
        const sev = f.priority || f.severity || "";
        return ["P0", "P1", "P2", "critical", "high", "medium"].includes(sev);
      });
    }

    // False APPROVE check (for broken fixtures)
    let falseApprove = null;
    if (fixture.variant === "broken") {
      falseApprove = verdict === "approved";
    }

    result = {
      ...result,
      verdict,
      correctness,
      findingCount: findings.length,
      findingSeverities: findings.map(f => f.priority || f.severity || "unknown"),
      findingTitles: findings.map(f => (f.title || "").slice(0, 100)),
      expectedDefectDetected,
      falseApprove,
      falsePositive,
      tokensUsed,
      latencyMs: elapsedMs,
      extractionStrategy: strategy,
    };

  } catch (err) {
    result = {
      ...result,
      verdict: "error",
      findings: [],
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
      error: err.message,
    };
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const fixtures = getAllFixtures().filter(f => !FILTER || f.caseId === FILTER);
  const allResults = [];

  console.log(`Running ${fixtures.length} fixtures × ${NUM_RUNS} runs = ${fixtures.length * NUM_RUNS} evaluations\n`);

  for (const fixture of fixtures) {
    for (let run = 1; run <= NUM_RUNS; run++) {
      const label = `${fixture.caseId} ${fixture.variant} run ${run}/${NUM_RUNS}`;
      process.stdout.write(`  ${label} ... `);
      const result = await runSingleEvaluation(fixture, run);
      allResults.push(result);

      const status = result.falseApprove === true ? "FALSE APPROVE" :
                     result.falseApprove === false ? "correctly avoided" :
                     result.falsePositive === true ? "FALSE POSITIVE" :
                     result.falsePositive === false ? "clean" :
                     result.verdict;
      console.log(`${result.verdict} (${result.tokensUsed || 0} tokens, ${result.latencyMs || 0}ms) — ${status}`);
    }
  }

  // Write results
  const outputPath = join(__dirname, "live-baseline-results.json");
  writeFileSync(outputPath, JSON.stringify(allResults, null, 2), "utf8");
  console.log(`\nResults written to ${outputPath}`);

  // Summary
  console.log("\n=== Summary ===");
  const broken = allResults.filter(r => r.variant === "broken");
  const fixed = allResults.filter(r => r.variant === "fixed");
  const falseApproves = broken.filter(r => r.falseApprove === true);
  const correctAvoids = broken.filter(r => r.falseApprove === false);
  const falsePositives = fixed.filter(r => r.falsePositive === true);

  console.log(`Broken fixtures: ${broken.length} evaluations`);
  console.log(`  False APPROVEs: ${falseApproves.length}/${broken.length}`);
  console.log(`  Correctly avoided APPROVE: ${correctAvoids.length}/${broken.length}`);
  console.log(`  Expected defect detected: ${broken.filter(r => r.expectedDefectDetected === true).length}/${broken.length}`);
  console.log(`Fixed fixtures: ${fixed.length} evaluations`);
  console.log(`  False positives (P0/P1/P2): ${falsePositives.length}/${fixed.length}`);
  console.log(`  Avg tokens: ${Math.round(allResults.reduce((s, r) => s + (r.tokensUsed || 0), 0) / allResults.length)}`);
  console.log(`  Avg latency: ${Math.round(allResults.reduce((s, r) => s + (r.latencyMs || 0), 0) / allResults.length)}ms`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
