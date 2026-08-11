-- 043_review_integrity_v2.sql
-- Review Integrity v2: persistence columns for evidence manifests,
-- verification receipts, approval eligibility, decision reason,
-- review invocation identity, and integrity version.
--
-- These columns persist the RECEIPT (not a giant copy of Git) so that
-- every decision can be reconstructed from commit-bound evidence
-- references and receipts. Actual source remains reconstructible
-- through immutable Git SHAs stored in the evidence manifest.

ALTER TABLE ai_reviews
  ADD COLUMN IF NOT EXISTS evidence_manifest      JSONB,
  ADD COLUMN IF NOT EXISTS verification_receipt   JSONB,
  ADD COLUMN IF NOT EXISTS approval_eligible      BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS decision_reason        TEXT,
  ADD COLUMN IF NOT EXISTS review_invocation_id   TEXT,
  ADD COLUMN IF NOT EXISTS integrity_version      INTEGER DEFAULT 1;

-- Index for invocation-based recovery lookups
CREATE INDEX IF NOT EXISTS idx_ai_reviews_invocation_id
  ON ai_reviews (review_invocation_id)
  WHERE review_invocation_id IS NOT NULL;

-- Index for filtering by integrity version
CREATE INDEX IF NOT EXISTS idx_ai_reviews_integrity_version
  ON ai_reviews (integrity_version)
  WHERE integrity_version IS NOT NULL;
