// src/services/idempotencyService.js
// Redis-backed idempotency checks for worker deduplication.
//
// Prevents duplicate processing when GitHub retries webhooks or when
// two workers pick up the same event simultaneously.
//
// Key pattern: gitwire:idem:{source}:{key}
// TTL: 1 hour by default (configurable per check)

import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

const IDEM_PREFIX = "gitwire:idem:";
const DEFAULT_TTL_MS = 3600000; // 1 hour

/**
 * Check if an operation has already been processed.
 * Returns true if this is a duplicate (should skip).
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier (e.g., 'run-12345', 'issue-42-triage')
 * @param {number} ttlMs - dedup window in ms (default: 1 hour)
 * @returns {Promise<boolean>} true = duplicate, false = fresh
 */
export async function isDuplicate(source, key, ttlMs = DEFAULT_TTL_MS) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    const exists = await redis.exists(redisKey);
    return exists === 1;
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Idempotency check failed — allowing operation");
    return false;
  }
}

/**
 * Mark an operation as processed.
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier
 * @param {number} ttlMs - TTL in ms
 */
export async function markProcessed(source, key, ttlMs = DEFAULT_TTL_MS) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    await redis.set(redisKey, Date.now().toString(), "PX", ttlMs);
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Failed to mark idempotency key");
  }
}

/**
 * Combined check-and-mark. Returns true if this was a fresh operation.
 * If false, the operation was already processed — skip it.
 *
 * @param {string} source - worker/event source name
 * @param {string} key - unique identifier
 * @param {number} ttlMs - dedup window in ms
 * @returns {Promise<boolean>} true = fresh (proceed), false = duplicate (skip)
 */
export async function checkAndMark(source, key, ttlMs = DEFAULT_TTL_MS) {
  const isDup = await isDuplicate(source, key, ttlMs);
  if (isDup) {
    logger.info({ source, key }, "Idempotency: duplicate operation detected — skipping");
    return false;
  }
  await markProcessed(source, key, ttlMs);
  return true;
}

/**
 * Remove an idempotency key (e.g., to allow re-processing after manual /gitwire run).
 *
 * @param {string} source
 * @param {string} key
 */
export async function clearIdempotencyKey(source, key) {
  const redisKey = IDEM_PREFIX + source + ":" + key;
  try {
    await redis.del(redisKey);
  } catch (err) {
    logger.warn({ err: err.message, source, key }, "Failed to clear idempotency key");
  }
}

// ─── Success-bound operation lifecycle ───────────────────────────────────────
//
// The legacy checkAndMark() above marks an operation as processed *before* the
// work begins. If the work then fails, every retry sees the marker and exits as
// a duplicate — the failure becomes invisible and unretryable.
//
// The lifecycle below splits "processing started" (active lease) from
// "processing completed" (complete marker). A worker acquires a token-bound
// lease at the start, releases it on failure, and writes the complete marker
// only on full success. Redis lifecycle errors throw IdempotencyStoreUnavailable
// so BullMQ retries and the exhaustion stays visible as a retained failed job.
//
// Only triage callers are migrated to this lifecycle in the current change.
// Other workers retain checkAndMark() unchanged.

const ACTIVE_SUFFIX = ":active";
const COMPLETE_SUFFIX = ":complete";
const DEFAULT_LEASE_TTL_MS = 120000; // 2 minutes — crashed workers' leases auto-expire

/**
 * Error thrown when the Redis lifecycle store cannot be reached.
 * BullMQ treats this as a retryable failure; exhaustion remains visible.
 */
export class IdempotencyStoreUnavailable extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "IdempotencyStoreUnavailable";
    if (cause) this.cause = cause;
  }
}

/**
 * Build a repository-scoped operation key for triage.
 *
 * The legacy key ("issue-<number>-<action>") can collide across repositories
 * that share an issue number. The new key binds repository identity and the
 * GitHub-internal target id so collisions are impossible.
 *
 * @param {object} args
 * @param {string} args.targetType - "issue" | "pr"
 * @param {number|string} args.repoId - repositories.id (or full_name fallback)
 * @param {number|string} args.targetId - issues.id / pr id (or number fallback)
 * @param {string} args.action - webhook action: opened | reopened | edited | manual-run
 * @returns {string} the operation key (without prefix or active/complete suffix)
 */
export function buildTriageOperationKey({ targetType, repoId, targetId, action }) {
  if (!targetType) throw new Error("buildTriageOperationKey: targetType required");
  if (repoId === undefined || repoId === null) throw new Error("buildTriageOperationKey: repoId required");
  if (targetId === undefined || targetId === null) throw new Error("buildTriageOperationKey: targetId required");
  if (!action) throw new Error("buildTriageOperationKey: action required");
  return `repo:${repoId}:${targetType}:${targetId}:${action}`;
}

// ─── Atomic Redis scripts ────────────────────────────────────────────────────
//
// ioredis eval(script, numkeys, ...keys, ...args). Each script returns an
// integer the JS layer can branch on:
//
//   1 = acquired / completed / released
//   0 = rejected (already active, already complete, or token mismatch)

// Acquire: returns 1 if we got the lease, 0 if active or complete already exists.
// Atomically checks "no active AND no complete" then writes the active lease.
const ACQUIRE_SCRIPT = `
  local active = redis.call('EXISTS', KEYS[1])
  if active == 1 then return 0 end
  local complete = redis.call('EXISTS', KEYS[2])
  if complete == 1 then return 0 end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
`;

// Complete: the worker is the final race arbiter. Atomically verifies the
// active lease token, deletes it, and writes the complete marker. Returns 1 on
// success. If a concurrent worker holds a different token, returns 0 (caller
// treats as "lost the race — another worker owns this operation").
const COMPLETE_SCRIPT = `
  local held = redis.call('GET', KEYS[1])
  if held == false then
    -- active lease gone (crashed & expired, or already completed)
    if redis.call('EXISTS', KEYS[2]) == 1 then return 1 end
    return 0
  end
  if held ~= ARGV[1] then return 0 end
  redis.call('DEL', KEYS[1])
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
  return 1
`;

// Abandon: release our own active lease on failure. Token-gated so one worker
// cannot release another's lease. Returns 1 if released, 0 if token mismatch
// or lease already gone.
const ABANDON_SCRIPT = `
  local held = redis.call('GET', KEYS[1])
  if held == false then return 1 end
  if held ~= ARGV[1] then return 0 end
  redis.call('DEL', KEYS[1])
  return 1
`;

// Check-complete helper: returns 1 if a complete marker exists for the key,
// 0 otherwise. Used by the worker to honor "already succeeded elsewhere."
const CHECK_COMPLETE_SCRIPT = `
  return redis.call('EXISTS', KEYS[1])
`;

function activeKeyOf(source, operationKey) {
  return IDEM_PREFIX + source + ":" + operationKey + ACTIVE_SUFFIX;
}
function completeKeyOf(source, operationKey) {
  return IDEM_PREFIX + source + ":" + operationKey + COMPLETE_SUFFIX;
}

/**
 * Result returned by beginOperation.
 *
 * @typedef {Object} OperationLease
 * @property {boolean} acquired - true if this caller should process the operation
 * @property {boolean} alreadyComplete - true if a prior run already succeeded
 * @property {string} token - unique lease token; required to complete/abandon
 */

/**
 * Atomically acquire a processing lease, or observe that the operation is
 * already complete.
 *
 * Behavior:
 *   - active lease held by another worker → { acquired: false, alreadyComplete: false }
 *   - complete marker present              → { acquired: false, alreadyComplete: true }  (safe no-op)
 *   - fresh operation                      → { acquired: true,  alreadyComplete: false, token }
 *
 * @param {string} source
 * @param {string} operationKey - from buildTriageOperationKey()
 * @param {object} [opts]
 * @param {number} [opts.leaseTtlMs]
 * @returns {Promise<OperationLease>}
 * @throws {IdempotencyStoreUnavailable} if Redis is unreachable
 */
export async function beginOperation(source, operationKey, opts = {}) {
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const active = activeKeyOf(source, operationKey);
  const complete = completeKeyOf(source, operationKey);
  const token = cryptoRandomToken();

  let result;
  try {
    result = await redis.eval(ACQUIRE_SCRIPT, 2, active, complete, token, String(leaseTtlMs));
  } catch (err) {
    throw new IdempotencyStoreUnavailable(
      `beginOperation: Redis unavailable for ${source}:${operationKey}`,
      { cause: err },
    );
  }

  if (result === 1) {
    return { acquired: true, alreadyComplete: false, token };
  }
  // Acquire rejected — distinguish "already complete" from "active elsewhere."
  let completeExists;
  try {
    completeExists = await redis.eval(CHECK_COMPLETE_SCRIPT, 1, complete);
  } catch (err) {
    // We failed to acquire and now can't classify. Treat as a store failure so
    // BullMQ retries rather than silently skipping the operation.
    throw new IdempotencyStoreUnavailable(
      `beginOperation: Redis unavailable during classify for ${source}:${operationKey}`,
      { cause: err },
    );
  }
  return { acquired: false, alreadyComplete: completeExists === 1, token: null };
}

/**
 * Mark the operation as successfully complete. Releases the active lease and
 * writes the complete marker. Idempotent: if the lease already expired but the
 * complete marker exists, returns true.
 *
 * @param {string} source
 * @param {string} operationKey
 * @param {string} token - the lease token from beginOperation()
 * @param {object} [opts]
 * @param {number} [opts.completeTtlMs] - dedup window after success (default: 1 hour)
 * @returns {Promise<boolean>} true if the operation is now marked complete
 * @throws {IdempotencyStoreUnavailable} if Redis is unreachable
 */
export async function completeOperation(source, operationKey, token, opts = {}) {
  const completeTtlMs = opts.completeTtlMs ?? DEFAULT_TTL_MS;
  const active = activeKeyOf(source, operationKey);
  const complete = completeKeyOf(source, operationKey);

  let result;
  try {
    result = await redis.eval(COMPLETE_SCRIPT, 2, active, complete, token, String(completeTtlMs));
  } catch (err) {
    throw new IdempotencyStoreUnavailable(
      `completeOperation: Redis unavailable for ${source}:${operationKey}`,
      { cause: err },
    );
  }
  return result === 1;
}

/**
 * Abandon the active lease on failure. Token-gated: cannot release another
 * worker's lease. Safe to call even if the lease already expired.
 *
 * @param {string} source
 * @param {string} operationKey
 * @param {string} token - the lease token from beginOperation()
 * @returns {Promise<boolean>} true if the lease was released or already gone
 * @throws {IdempotencyStoreUnavailable} if Redis is unreachable
 */
export async function abandonOperation(source, operationKey, token) {
  const active = activeKeyOf(source, operationKey);
  let result;
  try {
    result = await redis.eval(ABANDON_SCRIPT, 1, active, token);
  } catch (err) {
    throw new IdempotencyStoreUnavailable(
      `abandonOperation: Redis unavailable for ${source}:${operationKey}`,
      { cause: err },
    );
  }
  return result === 1;
}

/**
 * Clear both the active lease and complete marker for an operation, used by the
 * manual-run path to force re-processing. Bounded to triage.
 *
 * @param {string} source
 * @param {string} operationKey
 * @throws {IdempotencyStoreUnavailable} if Redis is unreachable
 */
export async function clearTriageOperation(source, operationKey) {
  const active = activeKeyOf(source, operationKey);
  const complete = completeKeyOf(source, operationKey);
  try {
    await redis.del(active, complete);
  } catch (err) {
    throw new IdempotencyStoreUnavailable(
      `clearTriageOperation: Redis unavailable for ${source}:${operationKey}`,
      { cause: err },
    );
  }
}

/**
 * Check whether an operation is already marked complete. Used by the worker to
 * honor prior success without re-processing.
 *
 * @param {string} source
 * @param {string} operationKey
 * @returns {Promise<boolean>}
 * @throws {IdempotencyStoreUnavailable} if Redis is unreachable
 */
export async function isOperationComplete(source, operationKey) {
  const complete = completeKeyOf(source, operationKey);
  let result;
  try {
    result = await redis.eval(CHECK_COMPLETE_SCRIPT, 1, complete);
  } catch (err) {
    throw new IdempotencyStoreUnavailable(
      `isOperationComplete: Redis unavailable for ${source}:${operationKey}`,
      { cause: err },
    );
  }
  return result === 1;
}

function cryptoRandomToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
