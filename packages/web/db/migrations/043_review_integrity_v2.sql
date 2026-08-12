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

-- Observability: review metrics log table for structured per-review metrics
CREATE TABLE IF NOT EXISTS review_metrics_log (
  id                      BIGSERIAL PRIMARY KEY,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Decision outcome
  event                   TEXT NOT NULL,
  check_state             TEXT NOT NULL,
  approval_eligible       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Coverage
  coverage_complete       BOOLEAN NOT NULL DEFAULT FALSE,
  total_changed_files     INTEGER NOT NULL DEFAULT 0,
  fully_covered           INTEGER NOT NULL DEFAULT 0,
  partial                 INTEGER NOT NULL DEFAULT 0,
  unavailable             INTEGER NOT NULL DEFAULT 0,
  coverage_limits         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Primary findings
  primary_finding_count   INTEGER NOT NULL DEFAULT 0,
  primary_material_count  INTEGER NOT NULL DEFAULT 0,

  -- Verifier
  verifier_status         TEXT NOT NULL DEFAULT 'not_run',
  verifier_finding_count  INTEGER NOT NULL DEFAULT 0,
  verifier_material_count INTEGER NOT NULL DEFAULT 0,
  verifier_incomplete     BOOLEAN NOT NULL DEFAULT FALSE,
  verifier_tokens         INTEGER NOT NULL DEFAULT 0,
  verifier_latency_ms     INTEGER NOT NULL DEFAULT 0,
  verifier_unresolved_context INTEGER NOT NULL DEFAULT 0,

  -- Tokens and latency
  primary_tokens          INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,
  primary_latency_ms      INTEGER NOT NULL DEFAULT 0,
  total_latency_ms        INTEGER NOT NULL DEFAULT 0,

  -- Context broker
  context_reads           INTEGER NOT NULL DEFAULT 0,
  context_searches        INTEGER NOT NULL DEFAULT 0,
  context_rounds          INTEGER NOT NULL DEFAULT 0,
  context_exhausted       BOOLEAN NOT NULL DEFAULT FALSE,
  context_retrieved_chars INTEGER NOT NULL DEFAULT 0,

  -- Mutation safety
  mutation_retries        INTEGER NOT NULL DEFAULT 0,
  duplicate_prevention_events INTEGER NOT NULL DEFAULT 0,

  -- Verifier overturn (verifier finds material when primary found none)
  verifier_overturn       BOOLEAN NOT NULL DEFAULT FALSE,

  -- Context-retrieval token estimate (chars / 4 as approximate token count)
  context_retrieval_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_review_metrics_recorded_at
  ON review_metrics_log (recorded_at);
CREATE INDEX IF NOT EXISTS idx_review_metrics_event
  ON review_metrics_log (event);
CREATE INDEX IF NOT EXISTS idx_review_metrics_verifier_status
  ON review_metrics_log (verifier_status);
