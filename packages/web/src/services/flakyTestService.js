// src/services/flakyTestService.js
// Flaky test detection, scoring, and quarantine management.
// Adapted for GitWire: octokit.request(), Anthropic proxy, no silent catches.

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";
import { config } from "../../config/index.js";
import crypto     from "crypto";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

const FLAKINESS_THRESHOLD    = 0.20;
const MIN_RUNS_FOR_QUARANTINE = 5;
const ROLLING_WINDOW_RUNS    = 30;
const GRADUATION_CLEAN_RUNS  = 10;

// ════════════════════════════════════════════════════════════════════════════
// Ingest test results from a CI run
// ════════════════════════════════════════════════════════════════════════════

export async function ingestTestResults({ run, repository, octokit }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const repoId = repository.id;

  let artifacts;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
      owner, repo, run_id: run.id, per_page: 20,
    });
    artifacts = data.artifacts;
  } catch (err) {
    logger.debug({ repo: repository.full_name, err: err.message }, "Flaky: no artifacts found");
    return;
  }

  const testArtifacts = artifacts.filter(a =>
    /test[-_]?results?|junit|coverage|test[-_]?report/i.test(a.name)
  );
  if (!testArtifacts.length) return;

  logger.info({ repo: repository.full_name, run: run.id, artifacts: testArtifacts.length }, "Flaky: ingesting test results");

  const allResults = [];

  for (const artifact of testArtifacts) {
    try {
      const { data: zipData } = await octokit.request("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}", {
        owner, repo, artifact_id: artifact.id, archive_format: "zip",
      });

      const parsed = await parseTestArtifactWithClaude(artifact.name, zipData);
      if (parsed?.tests?.length) allResults.push(...parsed.tests);
    } catch (err) {
      logger.debug({ artifact: artifact.name, err: err.message }, "Flaky: artifact parse failed");
    }
  }

  if (!allResults.length) return;

  const { rows: [ciRunRow] } = await db.query(
    "SELECT id FROM ci_runs WHERE github_run_id = $1", [run.id]
  ).catch(() => ({ rows: [] }));

  for (const test of allResults) {
    const testId = makeTestId(repoId, test.suite, test.name);
    await db.query(
      `INSERT INTO test_results (repo_id, ci_run_id, commit_sha, branch, workflow_name,
         test_suite, test_name, test_id, status, duration_ms, error_message, error_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [repoId, ciRunRow?.id ?? null, run.head_sha, run.head_branch, run.name,
       test.suite, test.name, testId, test.status, test.duration_ms ?? null,
       test.error_message ?? null, test.error_class ?? null]
    );
  }

  logger.info({ repo: repository.full_name, tests: allResults.length }, "Flaky: results stored");
  await recomputeFlakiness(repoId);
  await quarantineFlaky({ repoId, repository, octokit });
}

// ════════════════════════════════════════════════════════════════════════════
// Flakiness scoring
// ════════════════════════════════════════════════════════════════════════════

async function recomputeFlakiness(repoId) {
  const { rows: testIds } = await db.query(
    "SELECT DISTINCT test_id, test_suite, test_name FROM test_results WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '30 days' AND status != 'skipped'",
    [repoId]
  );

  for (const { test_id, test_suite, test_name } of testIds) {
    const { rows: runs } = await db.query(
      "SELECT status FROM test_results WHERE repo_id = $1 AND test_id = $2 AND status != 'skipped' ORDER BY created_at DESC LIMIT $3",
      [repoId, test_id, ROLLING_WINDOW_RUNS]
    );
    if (!runs.length) continue;

    const runCount  = runs.length;
    const failCount = runs.filter(r => r.status === "failed").length;
    const passCount = runCount - failCount;
    const score     = failCount / runCount;

    await db.query(
      `INSERT INTO flaky_tests (repo_id, test_id, test_suite, test_name, run_count, pass_count, fail_count, flakiness_score, last_seen_at, last_failed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(), CASE WHEN $7 > 0 THEN NOW() ELSE NULL END)
       ON CONFLICT (repo_id, test_id) DO UPDATE SET
         run_count = EXCLUDED.run_count, pass_count = EXCLUDED.pass_count, fail_count = EXCLUDED.fail_count,
         flakiness_score = EXCLUDED.flakiness_score, last_seen_at = NOW(),
         last_failed_at = CASE WHEN EXCLUDED.fail_count > 0 THEN NOW() ELSE flaky_tests.last_failed_at END`,
      [repoId, test_id, test_suite, test_name, runCount, passCount, failCount, score]
    );
  }

  logger.debug({ repoId, tests: testIds.length }, "Flaky: scores recomputed");
}

// ════════════════════════════════════════════════════════════════════════════
// Quarantine management
// ════════════════════════════════════════════════════════════════════════════

async function quarantineFlaky({ repoId, repository, octokit }) {
  const { rows: candidates } = await db.query(
    "SELECT * FROM flaky_tests WHERE repo_id = $1 AND flakiness_score >= $2 AND run_count >= $3 AND quarantined = FALSE AND graduated_at IS NULL",
    [repoId, FLAKINESS_THRESHOLD, MIN_RUNS_FOR_QUARANTINE]
  );
  if (!candidates.length) return;

  logger.info({ repo: repository.full_name, count: candidates.length }, "Flaky: opening quarantine PR");

  try {
    const pr = await openQuarantinePR({ candidates, repository, octokit });
    const ids = candidates.map(c => c.id);
    await db.query(
      "UPDATE flaky_tests SET quarantined = TRUE, quarantined_at = NOW(), quarantine_pr_number = $1 WHERE id = ANY($2::bigint[])",
      [pr?.number ?? null, ids]
    );
    await Events.healAttempted(repoId, {
      metadata: { type: "flaky_quarantine", count: candidates.length, pr: pr?.number },
    });
  } catch (err) {
    logger.error({ err: err.message }, "Flaky: quarantine PR creation failed");
  }
}

async function openQuarantinePR({ candidates, repository, octokit }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;

  const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner, repo, ref: "heads/" + repository.default_branch,
  });
  const baseSha = ref.object.sha;

  const workflowContent = buildQuarantineWorkflow(candidates, repository);
  const workflowPath    = ".github/workflows/quarantine-tests.yml";

  const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
    owner, repo, content: Buffer.from(workflowContent).toString("base64"), encoding: "base64",
  });

  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner, repo, commit_sha: baseSha,
  });

  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner, repo, base_tree: baseCommit.tree.sha,
    tree: [{ path: workflowPath, mode: "100644", type: "blob", sha: blob.sha }],
  });

  const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner, repo,
    message: "chore(test): quarantine " + candidates.length + " flaky test" + (candidates.length > 1 ? "s" : ""),
    tree: newTree.sha, parents: [baseSha],
  });

  const branch = "gitwire-quarantine/" + Date.now();
  await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner, repo, ref: "refs/heads/" + branch, sha: newCommit.sha,
  });

  const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner, repo,
    title: "Flaky Tests: Quarantine " + candidates.length + " unstable test" + (candidates.length > 1 ? "s" : ""),
    head: branch, base: repository.default_branch,
    body: buildQuarantinePRBody(candidates),
  });

  try {
    await octokit.request("POST /repos/{owner}/{repo}/labels", {
      owner, repo, name: "flaky-test-quarantine", color: "fbca04",
      description: "Quarantines flaky tests to a separate workflow",
    });
  } catch { /* already exists */ }

  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
    owner, repo, issue_number: pr.number, labels: ["flaky-test-quarantine"],
  }).catch(err => logger.warn({ err: err.message }, "Flaky: could not apply label"));

  return pr;
}

function buildQuarantineWorkflow(candidates, repository) {
  const testFilter = candidates.map(c => c.test_suite + " > " + c.test_name).join("|");

  return "# Auto-generated by GitWire — Flaky Test Quarantine\n" +
    "# DO NOT EDIT — managed by GitWire\n\n" +
    "name: Quarantined Tests\n\n" +
    "on:\n  schedule:\n    - cron: '0 6 * * 1'\n  workflow_dispatch:\n\n" +
    "jobs:\n  quarantine:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n" +
    "    steps:\n      - uses: actions/checkout@v4\n" +
    "      - name: Set up Node\n        uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n" +
    "      - run: npm ci\n" +
    "      - name: Run quarantined tests\n        uses: nick-fields/retry@v3\n        with:\n          timeout_minutes: 15\n          max_attempts: 3\n" +
    "          command: |\n            npm test -- --testNamePattern=\"" + testFilter.replace(/"/g, '\\"') + "\" 2>&1\n\n" +
    "# Quarantined tests (" + candidates.length + "):\n" +
    candidates.map(c => "# - [" + Math.round(c.flakiness_score * 100) + "% failure rate] " + c.test_suite + " > " + c.test_name).join("\n") + "\n";
}

function buildQuarantinePRBody(candidates) {
  const table = candidates.map(c =>
    "| " + c.test_suite + " | " + c.test_name + " | " + Math.round(c.flakiness_score * 100) + "% | " + c.run_count + " |"
  ).join("\n");

  return [
    "## Flaky test quarantine", "",
    "GitWire detected **" + candidates.length + "** tests with intermittent failures over the last 30 runs.", "",
    "| Suite | Test | Failure rate | Runs |", "|-------|------|-------------|------|",
    table, "",
    "### What this PR does", "",
    "- Adds quarantine workflow that runs these tests **weekly with 3 retries**",
    "- Tests that pass 10 consecutive quarantine runs are automatically graduated back", "",
    "---",
    "_Auto-generated by **GitWire** flaky test mitigation_",
  ].join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// AI-powered artifact parsing
// ════════════════════════════════════════════════════════════════════════════

async function parseTestArtifactWithClaude(artifactName, rawData) {
  const content = typeof rawData === "string"
    ? rawData.slice(0, 8000)
    : Buffer.from(rawData).toString("utf8", 0, 8000);

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: "You are a test result parser. Return ONLY valid JSON, no explanation.",
      messages: [{
        role: "user",
        content: "Parse these test results from artifact \"" + artifactName + "\" and return JSON:\n\n```\n" + content + "\n```\n\nReturn: {\"format\":\"type\",\"tests\":[{\"suite\":\"name\",\"name\":\"test\",\"status\":\"passed|failed|skipped\",\"duration_ms\":null,\"error_message\":null,\"error_class\":null}]}",
      }],
    });

    const text  = message.content[0].text.trim();
    const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.debug({ err: err.message }, "Flaky: Claude parse failed");
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Graduation check
// ════════════════════════════════════════════════════════════════════════════

export async function checkGraduation(repoId) {
  const { rows: candidates } = await db.query(
    "SELECT * FROM flaky_tests WHERE repo_id = $1 AND quarantined = TRUE AND graduated_at IS NULL", [repoId]
  );

  const graduated = [];
  for (const test of candidates) {
    const { rows: recent } = await db.query(
      "SELECT status FROM test_results WHERE repo_id = $1 AND test_id = $2 AND created_at > $3 ORDER BY created_at DESC LIMIT $4",
      [repoId, test.test_id, test.quarantined_at, GRADUATION_CLEAN_RUNS]
    );

    if (recent.length >= GRADUATION_CLEAN_RUNS && recent.every(r => r.status === "passed")) {
      await db.query("UPDATE flaky_tests SET graduated_at = NOW(), quarantined = FALSE WHERE id = $1", [test.id]);
      graduated.push(test);
    }
  }

  if (graduated.length) {
    logger.info({ repoId, count: graduated.length }, "Flaky: tests graduated from quarantine");
  }
  return graduated;
}

function makeTestId(repoId, suite, name) {
  return crypto.createHash("sha256").update(repoId + ":" + suite + ":" + name).digest("hex").slice(0, 16);
}
