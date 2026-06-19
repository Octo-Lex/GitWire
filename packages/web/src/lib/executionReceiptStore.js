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
