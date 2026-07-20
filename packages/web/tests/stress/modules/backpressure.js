// packages/web/tests/stress/modules/backpressure.js
//
// Deterministic in-memory admission-control model for P2 backpressure tests.
// Pure, no side effects, no production imports. Injected `now` controls
// rate-limit window rollover (correction #9).
//
// Lifecycle:
//   admit(request)   → consumes queue slot + rate token if admitted
//   complete(ticket) → releases exactly one queue slot
//   close()          → rejects all further admissions
//   open()           → re-enables admission
//   snapshot()       → deterministic state for assertions

/**
 * Create a backpressure model with queue-depth and rate-limit controls.
 *
 * Decision precedence (correction #9): closed → queue-full → rate-limited → admitted.
 *
 * @param {object} opts
 * @param {number} opts.maxQueueDepth max concurrent in-flight admissions
 * @param {number} opts.rateLimitPerWindow max admissions per window
 * @param {number} opts.windowMs window duration in ms
 * @param {function} [opts.now] injected clock; defaults to a monotonic counter
 * @returns {{ admit, complete, close, open, snapshot }}
 */
export function createBackpressureModel(opts) {
  if (!opts || typeof opts !== "object") {
    throw Object.assign(new Error("createBackpressureModel: opts must be an object"), { code: "INVALID_MODEL_CONFIG" });
  }
  const { maxQueueDepth, rateLimitPerWindow, windowMs } = opts;
  let nowFn = opts.now;
  if (typeof nowFn !== "function") {
    let tick = 0;
    nowFn = () => ++tick;
  }

  if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 1) {
    throw Object.assign(new Error(`maxQueueDepth must be a positive integer, got ${maxQueueDepth}`), { code: "INVALID_MODEL_CONFIG" });
  }
  if (!Number.isInteger(rateLimitPerWindow) || rateLimitPerWindow < 1) {
    throw Object.assign(new Error(`rateLimitPerWindow must be a positive integer, got ${rateLimitPerWindow}`), { code: "INVALID_MODEL_CONFIG" });
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw Object.assign(new Error(`windowMs must be a positive finite number, got ${windowMs}`), { code: "INVALID_MODEL_CONFIG" });
  }

  let closed = false;
  let queueDepth = 0;
  let windowStart = nowFn();
  let tokensUsed = 0;
  let nextTicketId = 0;
  const activeTickets = new Map(); // ticketId → true

  function currentWindow() {
    const t = nowFn();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      tokensUsed = 0;
    }
    return { windowStart, tokensUsed };
  }

  function rateRemaining() {
    const { tokensUsed: used } = currentWindow();
    return Math.max(0, rateLimitPerWindow - used);
  }

  /**
   * Attempt to admit a request. Consumes a queue slot and rate token if
   * admitted; consumes nothing if rejected. An admitted request receives
   * an opaque completion ticket that MUST be passed to complete().
   *
   * @param {object} [request]
   * @returns {{ admitted: boolean, reason?: string, status?: number, retryAfterMs?: number, ticket?: number }}
   */
  function admit(request = {}) {
    // Precedence: closed → queue-full → rate-limited → admitted.
    if (closed) {
      return { admitted: false, reason: "closed", status: 503 };
    }
    if (queueDepth >= maxQueueDepth) {
      return { admitted: false, reason: "queue_full", status: 503 };
    }
    const remaining = rateRemaining();
    if (remaining <= 0) {
      // Rate-limited. Compute retry-after based on window remainder.
      const elapsed = nowFn() - windowStart;
      const retryAfterMs = Math.max(0, windowMs - elapsed);
      return { admitted: false, reason: "rate_limited", status: 429, retryAfterMs };
    }

    // Admitted: consume slot + token, issue ticket.
    queueDepth += 1;
    tokensUsed += 1;
    const ticket = nextTicketId++;
    activeTickets.set(ticket, true);
    return { admitted: true, ticket };
  }

  /**
   * Complete a previously admitted request. Releases exactly one queue slot.
   * Rejects unknown or already-completed tickets.
   *
   * @param {number} ticket
   * @returns {{ released: boolean, reason?: string }}
   */
  function complete(ticket) {
    if (!activeTickets.has(ticket)) {
      return { released: false, reason: "unknown_or_completed_ticket" };
    }
    activeTickets.delete(ticket);
    queueDepth = Math.max(0, queueDepth - 1);
    return { released: true };
  }

  function close() { closed = true; }
  function open() { closed = false; }

  /**
   * Deterministic state snapshot for assertions.
   * @returns {{ closed, queueDepth, rateRemaining, windowStart, tokensUsed }}
   */
  function snapshot() {
    return {
      closed,
      queueDepth,
      rateRemaining: rateRemaining(),
      windowStart,
      tokensUsed,
    };
  }

  return Object.freeze({ admit, complete, close, open, snapshot });
}
