-- Migration 020: Structured review schema
-- Adds columns for bundle-driven review output (autoreview patterns).
--
-- New columns:
--   overall_correctness  — "patch is correct" | "patch is incorrect"
--   overall_confidence   — numeric 0-1
--   overall_explanation  — LLM's overall assessment text
--   ignored_findings     — findings rejected by scope validation (JSONB)
--   review_engine        — which engine ran (default: "claude")
--   duration_ms          — wall-clock review duration
--   config_snapshot      — config at review time (TEXT, added by earlier migration but ensure exists)

-- Add new columns to ai_reviews
ALTER TABLE ai_reviews
  ADD COLUMN IF NOT EXISTS overall_correctness TEXT,
  ADD COLUMN IF NOT EXISTS overall_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS overall_explanation TEXT,
  ADD COLUMN IF NOT EXISTS ignored_findings JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS review_engine TEXT NOT NULL DEFAULT 'claude',
  ADD COLUMN IF NOT EXISTS duration_ms INT;

-- Add new columns to ai_review_config for bundle-driven review settings
ALTER TABLE ai_review_config
  ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'claude',
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
  ADD COLUMN IF NOT EXISTS max_duration_seconds INT NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS bundle_max_chars INT NOT NULL DEFAULT 180000,
  ADD COLUMN IF NOT EXISTS require_file_scope BOOLEAN NOT NULL DEFAULT TRUE;

-- Index for filtering by engine and duration analytics
CREATE INDEX IF NOT EXISTS idx_ar_engine  ON ai_reviews(review_engine);
CREATE INDEX IF NOT EXISTS idx_ar_duration ON ai_reviews(duration_ms) WHERE duration_ms IS NOT NULL;

-- Add ai_review_pass_rate metric support: track review outcomes per repo
-- This enables a quality gate metric: what fraction of recent reviews passed?
CREATE INDEX IF NOT EXISTS idx_ar_verdict_repo ON ai_reviews(repo_id, verdict);
