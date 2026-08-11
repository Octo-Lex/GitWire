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
   *   1. Atomically acquire ownership (SETNX PLANNED). Fail closed if another
   *      worker already owns this invocation.
   *   2. If already CONFIRMED: return the existing review ID (retry recovery).
   *   3. If PLANNED or SUBMITTED: attempt recovery — check if a review with
   *      this invocation's marker was already posted at this SHA.
   *   4. If recovery finds the review: CONFIRM and return it.
   *   5. If recovery finds nothing: POST a new review with the invocation
   *      marker embedded, then CONFIRM.
   *
   * The invocation marker is embedded in the review body so recovery is
   * invocation-specific, not just "any gitwire review at this SHA."
   *
   * @param {object} review - { event, body, commit_id, comments }
   * @returns {Promise<object>} { reviewId, action: "created" | "recovered" }
   */
  async function submitReview(review) {
    // ── Step 1: Check existing state ────────────────────────────────────────
    const existing = await getState();

    if (existing && existing.state === MUTATION_STATE.CONFIRMED && existing.reviewId) {
      logger.info({ invocationId, reviewId: existing.reviewId }, "Review mutation already confirmed — returning existing");
      return { reviewId: existing.reviewId, action: "recovered" };
    }

    // ── Step 2: Attempt recovery from PLANNED or SUBMITTED ─────────────────
    // The crash window: GitHub accepted POST, process crashed before
    // CONFIRMED was persisted. Redis shows PLANNED or SUBMITTED but the
    // review may already exist on GitHub. Always check before POSTing.
    if (existing && (existing.state === MUTATION_STATE.PLANNED || existing.state === MUTATION_STATE.SUBMITTED)) {
      const recoveredId = await tryRecoverReview();
      if (recoveredId) {
        await setState({ state: MUTATION_STATE.CONFIRMED, reviewId: recoveredId, event: review.event, timestamp: Date.now() });
        logger.info({ invocationId, reviewId: recoveredId }, "Review mutation recovered from " + existing.state + " state");
        return { reviewId: recoveredId, action: "recovered" };
      }
      // Could not recover — the POST either didn't happen (crash before)
      // or GitHub lost it. Proceed with a new POST.
      logger.warn({ invocationId, existingState: existing.state }, "Could not recover review — proceeding with new POST");
    }

    // ── Step 3: Atomically acquire ownership ────────────────────────────────
    // Clear any stale PLANNED/SUBMITTED state from this process before
    // acquiring fresh ownership. This is safe because we just confirmed
    // via recovery that no review exists for this invocation.
    if (existing && existing.state !== MUTATION_STATE.CONFIRMED) {
      try { await redis.del(key); } catch (_e) { /* best effort */ }
    }

    // Use SETNX to prevent concurrent workers from both POSTing.
    let ownershipAcquired = false;
    try {
      const result = await redis.setnx(key, JSON.stringify({
        state: MUTATION_STATE.PLANNED,
        reviewId: null,
        event: review.event,
        timestamp: Date.now(),
        invocationId,
      }));
      if (result === 1) {
        ownershipAcquired = true;
        // Set TTL on the newly acquired key
        await redis.expire(key, ttlSeconds);
      }
    } catch (err) {
      // Redis error — fail closed
      throw new Error("Cannot establish review mutation ownership: Redis error — " + err.message);
    }

    if (!ownershipAcquired) {
      // Another worker owns this invocation. Check if it has confirmed.
      const concurrent = await getState();
      if (concurrent && concurrent.state === MUTATION_STATE.CONFIRMED && concurrent.reviewId) {
        return { reviewId: concurrent.reviewId, action: "recovered" };
      }
      // Another worker is in progress — fail closed
      throw new Error("Review mutation ownership conflict — another worker is processing invocation " + invocationId);
    }

    // ── Step 4: Embed invocation marker in review body ──────────────────────
    const invocationMarker = "<!-- gitwire-invocation:" + invocationId + " -->";
    const reviewBody = (review.body || "") + "\n\n" + invocationMarker;

    // ── Step 5: POST the review ────────────────────────────────────────────
    let reviewId;
    try {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: prNumber,
          commit_id: review.commit_id || headSha,
          body: reviewBody,
          event: review.event,
          comments: review.comments || [],
        }
      );
      reviewId = data.id;
    } catch (err) {
      await setState({ state: MUTATION_STATE.FAILED, reviewId: null, event: review.event, timestamp: Date.now(), error: err.message });
      throw err;
    }

    // ── Step 6: Mark CONFIRMED ─────────────────────────────────────────────
    await setState({ state: MUTATION_STATE.CONFIRMED, reviewId, event: review.event, timestamp: Date.now() });

    logger.info({ invocationId, reviewId, event: review.event }, "Review mutation submitted and confirmed");
    return { reviewId, action: "created" };
  }

  /**
   * Try to recover a review that was POSTed but not confirmed.
   * Queries recent reviews on the PR at the head SHA and looks for one
   * containing THIS invocation's marker in the body.
   * This is invocation-specific: another GitWire invocation or an unrelated
   * bot review at the same SHA will NOT be matched.
   */
  async function tryRecoverReview() {
    try {
      const { data: reviews } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: prNumber, per_page: 30 }
      );

      // Look for a review at this SHA containing our invocation marker
      const invocationMarker = "gitwire-invocation:" + invocationId;
      const candidate = reviews.find(r =>
        r.commit_id === headSha &&
        r.body && r.body.includes(invocationMarker)
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
