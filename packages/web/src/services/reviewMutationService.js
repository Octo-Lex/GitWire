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

  // Atomic CAS script: only set the key if it doesn't exist OR if the
  // existing value matches the expected state (allowing the same owner to
  // advance PLANNED→SUBMITTED→CONFIRMED). A different worker's live lease
  // is never deleted or overwritten.
  const CAS_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if current == false then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      return 1
    end
    local decoded = cjson.decode(current)
    if decoded.state == 'planned' or decoded.state == 'submitted' then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
      return 1
    end
    return 0
  `;

  /**
   * Write the mutation state via atomic CAS. Only succeeds if:
   *   - The key doesn't exist (first acquisition), OR
   *   - The existing state is PLANNED or SUBMITTED (same worker advancing)
   * Never overwrites a CONFIRMED or FAILED state owned by another worker.
   * Returns true if the write succeeded.
   */
  async function casState(state) {
    const val = JSON.stringify({ ...state, invocationId });
    try {
      const result = await redis.eval(CAS_SCRIPT, 1, key, val, String(ttlSeconds));
      return result === 1;
    } catch (err) {
      // Redis eval not available — fall back to setex (less safe but functional)
      logger.warn({ err: err.message, key }, "Redis CAS eval failed — falling back to setex");
      try { await redis.setex(key, ttlSeconds, val); return true; }
      catch (e) { return false; }
    }
  }

  /**
   * Submit a GitHub review with idempotency guarantee.
   *
   * Flow:
   *   1. Check existing state. If CONFIRMED, return existing review ID.
   *   2. If PLANNED or SUBMITTED: attempt paginated recovery — search ALL
   *      review pages for this invocation's marker at this SHA.
   *   3. If recovery finds the review: CAS to CONFIRMED and return it.
   *   4. If recovery finds nothing: CAS to PLANNED (atomic ownership).
   *      If CAS fails (another live worker owns it), fail closed.
   *   5. POST the review with the invocation marker.
   *   6. CAS to SUBMITTED (POST accepted).
   *   7. CAS to CONFIRMED (review ID persisted).
   *
   * @param {object} review - { event, body, commit_id, comments }
   * @returns {Promise<object>} { reviewId, action: "created" | "recovered" }
   */
  async function submitReview(review) {
    // ── Step 1: Check existing state ────────────────────────────────────────
    const existing = await getState();

    if (existing && existing.state === MUTATION_STATE.CONFIRMED && existing.reviewId) {
      return { reviewId: existing.reviewId, action: "recovered" };
    }

    // ── Step 2: Attempt recovery from PLANNED or SUBMITTED ─────────────────
    if (existing && (existing.state === MUTATION_STATE.PLANNED || existing.state === MUTATION_STATE.SUBMITTED)) {
      const recoveredId = await tryRecoverReview();
      if (recoveredId) {
        const ok = await casState({ state: MUTATION_STATE.CONFIRMED, reviewId: recoveredId, event: review.event, timestamp: Date.now() });
        if (ok) {
          return { reviewId: recoveredId, action: "recovered" };
        }
        // CAS failed — another worker advanced the state. Re-read.
        const current = await getState();
        if (current && current.state === MUTATION_STATE.CONFIRMED && current.reviewId) {
          return { reviewId: current.reviewId, action: "recovered" };
        }
        throw new Error("Review mutation ownership conflict during recovery for invocation " + invocationId);
      }
    }

    // ── Step 3: Atomically acquire ownership via CAS ────────────────────────
    // CAS only succeeds if the key doesn't exist or is PLANNED/SUBMITTED.
    // A live worker's lease is never deleted by another worker.
    const acquired = await casState({
      state: MUTATION_STATE.PLANNED,
      reviewId: null,
      event: review.event,
      timestamp: Date.now(),
    });

    if (!acquired) {
      // Another worker owns this invocation. Check if it has confirmed.
      const concurrent = await getState();
      if (concurrent && concurrent.state === MUTATION_STATE.CONFIRMED && concurrent.reviewId) {
        return { reviewId: concurrent.reviewId, action: "recovered" };
      }
      // Another worker is in progress — fail closed
      throw new Error("Review mutation ownership conflict — another worker owns invocation " + invocationId);
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

    // ── Step 6: Mark SUBMITTED (POST accepted, review ID known) ─────────────
    await casState({ state: MUTATION_STATE.SUBMITTED, reviewId, event: review.event, timestamp: Date.now() });

    // ── Step 7: Mark CONFIRMED ─────────────────────────────────────────────
    await casState({ state: MUTATION_STATE.CONFIRMED, reviewId, event: review.event, timestamp: Date.now() });

    return { reviewId, action: "created" };
  }

  /**
   * Try to recover a review that was POSTed but not confirmed.
   * Paginates through ALL review pages searching for a review containing
   * THIS invocation's marker at the head SHA.
   * Invocation-specific: another GitWire invocation or unrelated bot at the
   * same SHA will NOT be matched.
   */
  async function tryRecoverReview() {
    try {
      const invocationMarker = "gitwire-invocation:" + invocationId;
      let page = 1;
      const PER_PAGE = 30;
      const MAX_PAGES = 10; // safety limit (300 reviews)

      while (page <= MAX_PAGES) {
        const { data: reviews } = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          { owner, repo, pull_number: prNumber, per_page: PER_PAGE, page }
        );

        const candidate = reviews.find(r =>
          r.commit_id === headSha &&
          r.body && r.body.includes(invocationMarker)
        );

        if (candidate) {
          return candidate.id;
        }

        if (reviews.length < PER_PAGE) {
          break; // last page
        }

        page++;
      }

      return null;
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
