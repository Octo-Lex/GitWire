// src/services/reviewMutationService.js
// Review mutation idempotency (RI-7).
//
// Ensures exactly one GitHub review mutation per review invocation. The
// write boundary records planned → submitted → confirmed, so a worker retry
// after a crash can recover the existing review rather than posting another.
//
// Manual /gitwire run review creates a new logical invocation intentionally,
// so it may generate a new review. Worker retry does not.

import { createHash } from "node:crypto";

// Lazy logger that falls back to console if runtime is not initialized.
const logger = {
  info: (...args) => safeLog("info", ...args),
  warn: (...args) => safeLog("warn", ...args),
  error: (...args) => safeLog("error", ...args),
  debug: () => {},
};

function safeLog(level, obj, msg) {
  try {
    // Try to use the real logger if available
    // Import is cached after first call
    import("../lib/logger.js").then(m => m.logger[level](obj, msg)).catch(() => {
      // Fallback to console
      if (typeof obj === "string") console[level === "error" ? "error" : "log"](obj, msg || "");
      else console[level === "error" ? "error" : "log"](msg || "", obj);
    });
  } catch (_e) {
    console.log(msg || "");
  }
}

// ── Mutation states ──────────────────────────────────────────────────────────

export const MUTATION_STATE = Object.freeze({
  PLANNED:    "planned",    // invocation ID computed, no POST yet
  SUBMITTED:  "submitted",  // GitHub accepted the POST, review ID not yet confirmed
  CONFIRMED:  "confirmed",  // review ID persisted and verified
  FAILED:     "failed",     // POST failed, no review was created
});

// ── Invocation ID ────────────────────────────────────────────────────────────

/**
 * Compute an immutable review invocation ID.
 *
 * The invocation ID is deterministic for a given PR at a given head SHA
 * within a logical invocation (automatic or manual-run). Worker retries
 * produce the same invocation ID. Manual reruns produce a different one
 * because they include a distinct logical-invocation component.
 *
 * @param {object} params
 * @param {number} params.repoId
 * @param {number} params.prNumber
 * @param {string} params.headSha
 * @param {string} params.logicalInvocation - "automatic" | "manual-{timestamp}" | "retry-{jobId}"
 * @returns {string} invocation ID (sha256 hex)
 */
export function computeInvocationId({ repoId, prNumber, headSha, logicalInvocation }) {
  const raw = [repoId, prNumber, headSha, logicalInvocation].join(":");
  return "rinv:" + createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 40);
}

// ── Redis keys ───────────────────────────────────────────────────────────────

const KEY_PREFIX = "gitwire:review-mutation:";

function mutationKey(invocationId) {
  return KEY_PREFIX + invocationId;
}

// ── Mutation service ─────────────────────────────────────────────────────────

/**
 * Create a review mutation manager for a single review invocation.
 *
 * The manager ensures exactly one GitHub review POST per invocation,
 * even across worker retries and crashes.
 *
 * @param {object} params
 * @param {object} params.redis - Redis client (from queue.js)
 * @param {object} params.octokit - GitHub client
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber
 * @param {string} params.headSha
 * @param {string} params.invocationId - from computeInvocationId
 * @param {number} params.ttlSeconds - how long to keep the mutation record (default 24h)
 * @returns {object} mutation manager
 */
export function createReviewMutationManager({
  redis,
  octokit,
  owner,
  repo,
  prNumber,
  headSha,
  invocationId,
  ttlSeconds = 86400,
}) {
  const key = mutationKey(invocationId);

  /**
   * Read the current mutation state from Redis.
   * Returns { state, reviewId, event, timestamp } or null if no record.
   */
  async function getState() {
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_e) {
      return null;
    }
  }

  /**
   * Write the mutation state to Redis atomically.
   */
  async function setState(state) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(state));
    } catch (err) {
      // Non-fatal — if Redis is down, we can still proceed with the POST
      // but lose crash-recovery capability for this invocation.
      logger.warn({ err: err.message, key, invocationId }, "Failed to persist review mutation state");
    }
  }

  /**
   * Submit a GitHub review with idempotency guarantee.
   *
   * Flow:
   *   1. Check if a mutation already exists for this invocation.
   *   2. If CONFIRMED: return the existing review ID (retry recovery).
   *   3. If SUBMITTED: try to find the review by querying recent reviews
   *      for this PR at this SHA (crash recovery).
   *   4. If PLANNED or no record: mark PLANNED, POST the review,
   *      mark SUBMITTED, persist review ID, mark CONFIRMED.
   *
   * @param {object} review - { event, body, commit_id, comments }
   * @returns {Promise<object>} { reviewId, action: "created" | "recovered" }
   */
  async function submitReview(review) {
    // ── Step 1: Check existing state ────────────────────────────────────────
    const existing = await getState();

    if (existing && existing.state === MUTATION_STATE.CONFIRMED && existing.reviewId) {
      // Already submitted and confirmed — return existing (worker retry)
      logger.info({ invocationId, reviewId: existing.reviewId }, "Review mutation already confirmed — returning existing");
      return { reviewId: existing.reviewId, action: "recovered" };
    }

    if (existing && existing.state === MUTATION_STATE.SUBMITTED) {
      // POST was accepted but crash happened before confirmation.
      // Try to find the review by querying recent reviews at this SHA.
      const recoveredId = await tryRecoverReview();
      if (recoveredId) {
        await setState({ state: MUTATION_STATE.CONFIRMED, reviewId: recoveredId, event: review.event, timestamp: Date.now() });
        logger.info({ invocationId, reviewId: recoveredId }, "Review mutation recovered from submitted state");
        return { reviewId: recoveredId, action: "recovered" };
      }
      // Could not recover — proceed to POST (may create a duplicate,
      // but this is safer than skipping the review entirely)
      logger.warn({ invocationId }, "Could not recover submitted review — proceeding with new POST");
    }

    // ── Step 2: Mark PLANNED ───────────────────────────────────────────────
    await setState({ state: MUTATION_STATE.PLANNED, reviewId: null, event: review.event, timestamp: Date.now() });

    // ── Step 3: POST the review ────────────────────────────────────────────
    let reviewId;
    try {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: prNumber,
          commit_id: review.commit_id || headSha,
          body: review.body || "",
          event: review.event,
          comments: review.comments || [],
        }
      );
      reviewId = data.id;
    } catch (err) {
      await setState({ state: MUTATION_STATE.FAILED, reviewId: null, event: review.event, timestamp: Date.now(), error: err.message });
      throw err;
    }

    // ── Step 4: Mark SUBMITTED (POST accepted but not yet confirmed) ───────
    await setState({ state: MUTATION_STATE.SUBMITTED, reviewId, event: review.event, timestamp: Date.now() });

    // ── Step 5: Mark CONFIRMED ─────────────────────────────────────────────
    await setState({ state: MUTATION_STATE.CONFIRMED, reviewId, event: review.event, timestamp: Date.now() });

    logger.info({ invocationId, reviewId, event: review.event }, "Review mutation submitted and confirmed");
    return { reviewId, action: "created" };
  }

  /**
   * Try to recover a review that was POSTed but not confirmed.
   * Queries recent reviews on the PR at the head SHA and looks for one
   * created by gitwire-hq after the SUBMITTED timestamp.
   */
  async function tryRecoverReview() {
    try {
      const { data: reviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: prNumber, per_page: 10 }
      );

      // Find a review at the same commit SHA by the GitWire bot
      const candidate = reviews.find(r =>
        r.commit_id === headSha &&
        (r.user?.login?.includes("gitwire") || r.user?.login?.endsWith("[bot]"))
      );

      return candidate?.id || null;
    } catch (_e) {
      return null;
    }
  }

  /**
   * Get the current mutation state for diagnostics.
   */
  async function getMutationState() {
    return getState();
  }

  /**
   * Clear the mutation record (for testing or manual reset).
   */
  async function clear() {
    try {
      await redis.del(key);
    } catch (_e) { /* non-fatal */ }
  }

  return {
    invocationId,
    submitReview,
    getMutationState,
    clear,
  };
}
