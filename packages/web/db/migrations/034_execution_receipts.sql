-- 034_execution_receipts.sql
-- Durable content-addressed storage for sandbox execution receipts.
--
-- A receipt is immutable evidence that a specific patch artifact was
-- applied to a specific source snapshot at a specific base SHA and
-- that a canonical validation plan was executed in an isolated sandbox.
--
-- The receipt_hash (SHA-256 of canonical receipt content) is the primary
-- key. Receipts are write-once: INSERT with ON CONFLICT DO NOTHING.
-- They are never deleted — the same receipt can be referenced by multiple
-- verifications and critic reviews.
--
-- Replaying the same execution fingerprint returns the existing receipt
-- rather than re-running or overwriting.

CREATE TABLE IF NOT EXISTS execution_receipts (
  receipt_hash       TEXT PRIMARY KEY,
  receipt_ref        TEXT UNIQUE NOT NULL,
  content            TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
