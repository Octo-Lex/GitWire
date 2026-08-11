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

  // Generate a unique lease token for this manager instance.
  // Each worker gets its own token; CAS compares the token to prevent
  // one worker from overwriting another's live lease.
  const leaseToken = createHash("sha256")
    .update(invocationId + ":" + process.pid + ":" + Date.now() + ":" + Math.random())
    .digest("hex").slice(0, 24);

  /**
   * Read the current mutation state from Redis.
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
   * Best-effort write (for FAILED state on error paths).
   */
  async function setState(state) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify({ ...state, invocationId }));
    } catch (_e) { /* non-fatal on error paths */ }
  }

  // Lua CAS: compare-and-set with owner token.
  // SET only if: key missing (first acquisition), OR the existing record's
  // leaseToken matches ARGV[2] (same worker advancing its own state).
  // A different worker's live lease is never overwritten.
  const CAS_SCRIPT = `
    local current = redis.call('GET', KEYS[1])
    if current == false then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
      return 1
    end
    local decoded = cjson.decode(current)
    if decoded.leaseToken == ARGV[2] then
      redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
      return 1
    end
    return 0
  `;

  /**
   * Write state via atomic CAS with owner token. Only succeeds if:
   *   - Key doesn't exist (first acquisition), OR
   *   - The existing record has the same leaseToken (same worker)
   * Never overwrites another worker's live lease.
   * No unsafe fallback — if EVAL fails, returns false (fail closed).
   */
  async function casState(state) {
    const val = JSON.stringify({ ...state, invocationId, leaseToken });
    try {
      const result = await redis.eval(CAS_SCRIPT, 1, key, val, leaseToken, String(ttlSeconds));
      return result === 1;
    } catch (_e) {
      // EVAL failed — fail closed. No unsafe SETEX fallback.
      return false;
    }
  }

  /**
   * Submit a GitHub review with idempotency guarantee.
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
        // Recovery found the review. We cannot CAS to CONFIRMED because
        // we don't own the lease (another worker created the PLANNED).
        // Use unconditional setex — this is safe because the review
        // provably exists on GitHub (recovery found it).
        await setState({ state: MUTATION_STATE.CONFIRMED, reviewId: recoveredId, event: review.event, timestamp: Date.now() });
        return { reviewId: recoveredId, action: "recovered" };
      }
    }

    // ── Step 3: Acquire ownership via CAS ──────────────────────────────────
    // CAS succeeds only if key is missing (fresh acquisition). If another
    // worker has a live lease with a different leaseToken, CAS returns 0 —
    // fail closed. An abandoned lease (from a crashed worker) will expire
    // via TTL, allowing a future retry to acquire fresh ownership.
    const acquired = await casState({
      state: MUTATION_STATE.PLANNED,
      reviewId: null,
      event: review.event,
      timestamp: Date.now(),
    });

    if (!acquired) {
      // Another worker owns this invocation with a different lease.
      // Check if it has confirmed while we were waiting.
      const concurrent = await getState();
      if (concurrent && concurrent.state === MUTATION_STATE.CONFIRMED && concurrent.reviewId) {
        return { reviewId: concurrent.reviewId, action: "recovered" };
      }
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
    const submitted = await casState({ state: MUTATION_STATE.SUBMITTED, reviewId, event: review.event, timestamp: Date.now() });
    if (!submitted) {
      // The POST succeeded (review exists on GitHub) but we could not persist
      // the SUBMITTED transition. This means another worker took over our lease
      // while we were awaiting the POST response, OR Redis is unavailable.
      // Either way, the review is on GitHub. Throw so the worker retries —
      // the retry's recovery will find the review via the invocation marker
      // with zero additional POSTs.
      throw new Error(
        "Review mutation SUBMITTED persistence failed for invocation " + invocationId +
        " — review " + reviewId + " exists on GitHub; retry will recover it"
      );
    }

    // ── Step 7: Mark CONFIRMED ─────────────────────────────────────────────
    const confirmed = await casState({ state: MUTATION_STATE.CONFIRMED, reviewId, event: review.event, timestamp: Date.now() });
    if (!confirmed) {
      // Same situation: review exists on GitHub, but CONFIRMED persistence
      // failed. Throw so the retry recovers it.
      throw new Error(
        "Review mutation CONFIRMED persistence failed for invocation " + invocationId +
        " — review " + reviewId + " exists on GitHub; retry will recover it"
      );
    }

    return { reviewId, action: "created" };
  }

  /**
   * Try to recover a review that was POSTed but not confirmed.
   * Paginates through ALL review pages (until end-of-list) searching for
   * a review containing THIS invocation's marker at the head SHA.
   * Invocation-specific: another GitWire invocation or unrelated bot at the
   * same SHA will NOT be matched.
   */
  async function tryRecoverReview() {
    try {
      const invocationMarker = "gitwire-invocation:" + invocationId;
      let page = 1;
      const PER_PAGE = 30;

      while (true) {
        const { data: reviews } = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          { owner, repo, pull_number: prNumber, per_page: PER_PAGE, page }
        );

        if (!reviews || reviews.length === 0) {
          break; // exhausted all pages
        }

        const candidate = reviews.find(r =>
          r.commit_id === headSha &&
          r.body && r.body.includes(invocationMarker)
        );

        if (candidate) {
          return candidate.id;
        }

        if (reviews.length < PER_PAGE) {
          break; // last page — end of list
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
