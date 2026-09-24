// src/services/reviewResultPresentation.js
//
// `ai_reviews` is unique per (repo, PR, head), so its mutable terminal fields
// cannot identify which of two concurrent same-head invocations produced a
// legacy `reviewPR()` null. Presentation therefore binds to the dedicated
// `GitWire AI Review` check run created by THIS invocation. GitHub check-run
// ids are immutable per invocation and the tracker observes only requests made
// through the wrapped Octokit instance handed to that invocation.

const REVIEW_CHECK_NAME = "GitWire AI Review";
const BENIGN_NULL_TITLES = new Set([
  "✅ No reviewable files changed",
  "⚠️ AI review not run — no files admitted",
]);

function unavailable(reason, error) {
  return {
    unavailable: true,
    verdict: "error",
    blocked: false,
    findings: [],
    reason,
    error,
  };
}

/**
 * Wrap an Octokit client for one reviewPR invocation and capture the exact
 * dedicated AI-review check it creates/finalizes. The wrapper deliberately
 * does not share state across invocations.
 *
 * The caller keeps using the original client for unrelated worker effects;
 * only reviewPR receives `tracker.octokit`.
 */
export function createReviewPresentationTracker(octokit) {
  let creationAttempted = false;
  let creationError = null;
  let reviewCheckRunId = null;
  let terminalPatch = null;

  const trackedOctokit = Object.create(octokit);
  trackedOctokit.request = async function trackedRequest(route, params = {}) {
    const isCreate = route === "POST /repos/{owner}/{repo}/check-runs" &&
      params?.name === REVIEW_CHECK_NAME;

    if (isCreate) {
      creationAttempted = true;
      try {
        const response = await octokit.request(route, params);
        reviewCheckRunId = response?.data?.id ?? null;
        if (reviewCheckRunId === null) {
          creationError = "GitHub returned no check-run id for the AI review invocation.";
        }
        return response;
      } catch (err) {
        creationError = err?.message || "AI review check creation failed.";
        throw err;
      }
    }

    const isTrackedPatch = route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}" &&
      reviewCheckRunId !== null &&
      String(params?.check_run_id ?? "") === String(reviewCheckRunId);

    if (isTrackedPatch) {
      const response = await octokit.request(route, params);
      if (params?.conclusion || params?.status === "completed") {
        terminalPatch = {
          conclusion: params?.conclusion ?? null,
          title: params?.output?.title ?? "",
          summary: params?.output?.summary ?? "",
        };
      }
      return response;
    }

    return octokit.request(route, params);
  };

  return {
    octokit: trackedOctokit,
    snapshot() {
      return {
        creationAttempted,
        creationError,
        reviewCheckRunId,
        terminalPatch: terminalPatch ? { ...terminalPatch } : null,
      };
    },
  };
}

/**
 * Normalize a review service result for the top-level GitWire check.
 *
 * Explicit reviewPR results are invocation-local and pass through untouched.
 * For the remaining legacy null contract:
 *   - no dedicated-check attempt means reviewPR skipped before starting
 *     (currently bot-authored PR) and remains a benign null;
 *   - a successfully terminalized dedicated check with one of the two
 *     explicitly benign no-files titles remains a benign null;
 *   - every other attempted-but-null outcome is unavailable, because the
 *     caller cannot prove that the null meant a benign skip.
 *
 * This fails safe if check creation/finalization cannot be verified and never
 * infers invocation ownership from the shared ai_reviews row.
 */
export function normalizeReviewResultForPresentation({ reviewResult, invocation }) {
  if (reviewResult !== null && reviewResult !== undefined) return reviewResult;

  const state = invocation || {};
  if (!state.creationAttempted) return null;

  if (state.reviewCheckRunId === null || state.reviewCheckRunId === undefined) {
    return unavailable(
      "review_check_unavailable",
      state.creationError || "AI review outcome could not be bound to an invocation-specific check run."
    );
  }

  if (!state.terminalPatch) {
    return unavailable(
      "review_outcome_unverified",
      "AI review returned no result and its invocation-specific check did not reach a verified terminal state."
    );
  }

  if (BENIGN_NULL_TITLES.has(state.terminalPatch.title)) return null;

  return unavailable(
    "review_unavailable",
    state.terminalPatch.summary || state.terminalPatch.title ||
      "AI review could not be completed."
  );
}
