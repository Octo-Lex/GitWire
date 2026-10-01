#!/usr/bin/env node
// scripts/master-push-ci-watchdog.mjs
//
// 421-C: independently detect when master advances but GitHub fails to
// instantiate the genuine event=push CI run for that exact head SHA.
// Detect and report only — never repair, never dispatch, never deploy.
//
// Liveness criterion: EXISTENCE of a CI workflow run with
//   event === "push" && head_branch === "master" && head_sha === target.
// Any run status (queued, in_progress, or completed with ANY conclusion,
// including failure) proves event generation occurred. A red CI run is
// the CI workflow's own failure class, not a dropped push event, and must
// not be reported by this watchdog.
//
// Grace: a head younger than GRACE_SECONDS with no push CI yet reports
// "waiting" (exit 0) — normal event propagation. Beyond grace with no
// genuine push run, the watchdog FAILS (exit 1) with the evidence needed
// for a human diagnosis. workflow_dispatch CI runs and pull_request CI
// runs never satisfy the predicate, at any age.
//
// Authority: read-only. contents: read + actions: read on the ephemeral
// GITHUB_TOKEN. No repository writes, no CI dispatches or reruns, no
// issue creation, no deployment interaction.

const GRACE_SECONDS = 600; // ~10 minutes, per the frozen 421-C contract
const CI_WORKFLOW = "ci.yml";
const API = "https://api.github.com";

// The exact predicate from the frozen contract. Server-side query filters
// are a convenience; this function is the authority on what satisfies.
export function isGenuinePushCiRun(run, targetSha) {
  return (
    run !== null &&
    typeof run === "object" &&
    run.event === "push" &&
    run.head_branch === "master" &&
    typeof run.head_sha === "string" &&
    run.head_sha === targetSha
  );
}

// Pure decision function (unit-tested): pass | waiting | fail.
export function evaluate({
  targetSha,
  headCommitAtMs,
  nowMs,
  runs,
  latestPushRun = null,
  graceSeconds = GRACE_SECONDS,
}) {
  const ageSeconds = Math.max(0, Math.floor((nowMs - headCommitAtMs) / 1000));
  const genuine = runs.find((r) => isGenuinePushCiRun(r, targetSha)) ?? null;
  if (genuine !== null) {
    return { verdict: "pass", ageSeconds, genuine };
  }
  if (ageSeconds < graceSeconds) {
    return { verdict: "waiting", ageSeconds, graceSeconds };
  }
  return { verdict: "fail", ageSeconds, latestPushRun };
}

async function apiGet(path, token) {
  const res = await fetch(API + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

function describeRun(run) {
  if (run === null || run === undefined) return "none exists";
  const outcome =
    run.status === "completed" ? `completed/${run.conclusion ?? "unknown"}` : run.status;
  return `run #${run.id} on ${run.head_sha?.slice(0, 8) ?? "?"} (${outcome})`;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) {
    throw new Error("GITHUB_REPOSITORY and GH_TOKEN must be set");
  }

  // Test mode: an explicit target SHA is evaluated beyond grace immediately,
  // so historical heads (e.g. the 2026-10-01 missing-event SHA) can be
  // re-evaluated deterministically via workflow_dispatch.
  const override = (process.env.WATCHDOG_TARGET_SHA ?? "").trim();
  const testMode = override.length > 0;

  const targetSha = testMode
    ? override
    : (await apiGet(`/repos/${repo}/git/ref/heads/master`, token)).object.sha;
  const commit = await apiGet(`/repos/${repo}/commits/${targetSha}`, token);
  const headCommitAtMs = Date.parse(commit.commit.committer.date);
  if (!Number.isFinite(headCommitAtMs)) {
    throw new Error(`cannot resolve committer date for ${targetSha}`);
  }

  // All CI runs for this SHA, unfiltered by event: the predicate itself
  // decides what satisfies, so dispatch/PR runs on the same SHA are
  // demonstrably considered and rejected.
  const runs =
    (await apiGet(
      `/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${targetSha}&per_page=100`,
      token,
    )).workflow_runs ?? [];

  // For the failure report: the newest push CI run on master, whatever SHA
  // it landed on — shows how far behind event generation actually is.
  const latestPushRun =
    (await apiGet(
      `/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?event=push&per_page=1`,
      token,
    )).workflow_runs?.[0] ?? null;

  const result = evaluate({
    targetSha,
    headCommitAtMs,
    nowMs: Date.now(),
    runs,
    latestPushRun,
    graceSeconds: testMode ? 0 : GRACE_SECONDS,
  });

  if (result.verdict === "pass") {
    console.log(
      `WATCHDOG PASS: genuine event=push CI exists for master head ${targetSha.slice(0, 12)} — ${describeRun(result.genuine)} (head age ${result.ageSeconds}s).`,
    );
    return;
  }
  if (result.verdict === "waiting") {
    console.log(
      `WATCHDOG WAITING: master head ${targetSha.slice(0, 12)} is ${result.ageSeconds}s old (< ${result.graceSeconds}s grace); no event=push CI yet — normal propagation window.`,
    );
    return;
  }

  console.error("WATCHDOG FAILURE: master advanced but no event=push CI run exists for the exact head SHA.");
  console.error(`  master SHA:      ${targetSha}`);
  console.error(
    `  head commit at:  ${commit.commit.committer.date} (age ${result.ageSeconds}s, grace ${GRACE_SECONDS}s exceeded)`,
  );
  console.error(`  latest push CI:  ${describeRun(result.latestPushRun)}`);
  console.error(
    `  statement:       no CI run with event=push, head_branch=master, head_sha=${targetSha} exists — GitHub did not instantiate the genuine push CI for this head (workflow_dispatch and pull_request runs on this SHA do not satisfy this predicate).`,
  );
  process.exitCode = 1;
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("WATCHDOG ERROR (detector failure, not a verdict):", err.message);
    process.exitCode = 1;
  });
}
