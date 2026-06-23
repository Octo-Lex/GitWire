// src/lib/executionReceiptStore.js
// Durable content-addressed receipt store for sandbox execution receipts.
//
// Backed by the execution_receipts database table. Receipts are canonical
// JSON serializations of execution evidence. The receipt_hash (SHA-256 of
// the canonical receipt content) is the primary key. Receipts are write-once
// (INSERT ON CONFLICT DO NOTHING) and never deleted.
//
// A receipt is evidence only when it is durable, content-addressed,
// resolved under lock, and fully bound to the exact proposal inputs.

import crypto from "crypto";
import { db } from "./db.js";
import { logger } from "./logger.js";

/**
 * Compute the canonical hash of receipt content.
 * @param {string|Buffer} content - canonical receipt JSON
 * @returns {string} sha256 hash with prefix
 */
export function computeReceiptHash(content) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a content-addressed receipt reference from a hash.
 */
export function buildReceiptRef(hash) {
  return `receipt:${hash}`;
}

/**
 * Store execution receipt content in the durable content-addressed store.
 * Returns { ref, hash } for the stored content.
 *
 * Write-once: if the hash already exists, the existing row is kept
 * (ON CONFLICT DO NOTHING). Content is idempotent — same bytes always
 * produce the same hash.
 *
 * @param {string} content - canonical JSON serialization of the receipt
 * @returns {Promise<{ ref: string, hash: string }>}
 */
export async function storeReceipt(content) {
  const hash = computeReceiptHash(content);
  const ref = buildReceiptRef(hash);

  await db.query(
    `INSERT INTO execution_receipts (receipt_hash, receipt_ref, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (receipt_hash) DO NOTHING`,
    [hash, ref, content]
  );

  logger.debug({ ref, size: content.length }, "Execution receipt stored durably");
  return { ref, hash };
}

/**
 * Resolve a receipt reference and return its content from durable storage.
 * Throws if the receipt is not found.
 *
 * @param {string} ref - content-addressed receipt reference
 * @returns {Promise<string>} the stored receipt content
 */
export async function resolveReceipt(ref) {
  const { rows } = await db.query(
    `SELECT content FROM execution_receipts WHERE receipt_ref = $1`,
    [ref]
  );
  if (rows.length === 0) {
    throw new Error(`Execution receipt not found: ${ref}`);
  }
  return rows[0].content;
}

/**
 * Verify that a receipt reference resolves to content matching the expected hash.
 * Retrieves from durable storage and recomputes the hash.
 * Throws if the receipt is not found or the hash does not match.
 *
 * @param {string} ref - content-addressed receipt reference
 * @param {string} expectedHash - expected sha256:... hash
 * @returns {Promise<string>} the verified receipt content
 */
export async function verifyReceipt(ref, expectedHash) {
  const content = await resolveReceipt(ref);
  const actualHash = computeReceiptHash(content);

  if (actualHash !== expectedHash) {
    throw new Error(
      `Execution receipt hash mismatch: expected ${expectedHash}, computed ${actualHash}`
    );
  }

  return content;
}

/**
 * Parse a verified receipt and return the structured receipt object.
 *
 * @param {string} content - verified receipt content
 * @returns {object} parsed receipt
 */
export function parseReceipt(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_e) {
    throw new Error("Execution receipt is not valid JSON");
  }
  return parsed;
}

// ════════════════════════════════════════════════════════════════════════════
// EXECUTOR REPORT PERSISTENCE (v0.23.0 Task 6, Shape B)
// ════════════════════════════════════════════════════════════════════════════
// Executor reports ride inside the existing execution_receipts table (opaque
// JSON content, write-once, content-addressed). The ref uses the
// 'executor-report:' prefix so it's distinguishable from GitWire's own
// receipts ('receipt:'). No new migration needed.

// Fields excluded from the executor report hash (mirrors
// packages/executor-service/src/executorReportHash.js EXCLUDED_FROM_HASH).
const EXECUTOR_REPORT_HASH_EXCLUDED = new Set(["executor_report_hash", "executor_report_ref"]);

/**
 * Recompute the executor report hash from raw content.
 * Strips executor_report_hash + executor_report_ref fields, then SHA-256
 * over the canonical JSON. Mirrors computeExecutorReportHash in the
// executor-service package — must produce identical results.
 *
 * @param {string} content - raw JSON report content
 * @returns {string} "sha256:<64 hex>"
 */
function recomputeExecutorReportHash(content) {
  const report = JSON.parse(content);
  const input = {};
  for (const key of Object.keys(report)) {
    if (!EXECUTOR_REPORT_HASH_EXCLUDED.has(key)) {
      input[key] = report[key];
    }
  }
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Store a raw executor report durably using the service-provided hash + ref.
 * The ref uses the 'executor-report:' prefix. Write-once (ON CONFLICT DO NOTHING).
 *
 * @param {string} content - canonical JSON of the executor report
 * @param {string} hash - "sha256:..." (computed by the executor service)
 * @param {string} ref - "executor-report:sha256:..." (derived from hash)
 * @returns {Promise<{ ref: string, hash: string }>}
 */
export async function storeExecutorReport(content, hash, ref) {
  await db.query(
    `INSERT INTO execution_receipts (receipt_hash, receipt_ref, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (receipt_hash) DO NOTHING`,
    [hash, ref, content]
  );

  logger.debug({ ref, size: content.length }, "Executor report stored durably");
  return { ref, hash };
}

/**
 * Resolve an executor_report_ref to its raw content from durable storage.
 * @param {string} ref - "executor-report:sha256:..."
 * @returns {Promise<string>} the stored raw report content
 * @throws {Error} if the report is not found
 */
export async function resolveExecutorReport(ref) {
  const { rows } = await db.query(
    `SELECT content FROM execution_receipts WHERE receipt_ref = $1`,
    [ref]
  );
  if (rows.length === 0) {
    throw new Error(`Executor report not found: ${ref}`);
  }
  return rows[0].content;
}

/**
 * Verify that an executor_report_ref resolves to content whose recomputed
 * hash matches the expected hash. This is the load-bearing check for Task 6:
 * no pass receipt is accepted unless the raw executor report can be resolved
 * and its hash recomputed.
 *
 * @param {string} ref - "executor-report:sha256:..."
 * @param {string} expectedHash - "sha256:..." (the hash the receipt claims)
 * @returns {Promise<boolean>} true if the hash matches
 * @throws {Error} if the ref does not resolve (report not persisted)
 */
export async function verifyExecutorReportHash(ref, expectedHash) {
  const content = await resolveExecutorReport(ref);
  try {
    const actualHash = recomputeExecutorReportHash(content);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}
