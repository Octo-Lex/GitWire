-- Migration 044: Raise AI review duration ceiling to 600 seconds
-- Unit A recovery correction (2026-08-29).
--
-- The review path resolves its hard timeout from the persisted
-- ai_review_config row (cfg.max_duration_seconds * 1000), so the
-- 600-second service fallback (DEFAULT_MAX_DURATION_MS) is bypassed for
-- every activated repository. Thinking-model reviews measured ~209 s under
-- the raised token budgets; the 300 s ceiling aborts them mid-flight.
--
-- This migration aligns the persisted path with the service fallback:
--   * column default 300 -> 600
--   * rows still at the old 300 default -> 600
-- Operator-set values other than 300 are preserved.

ALTER TABLE ai_review_config
  ALTER COLUMN max_duration_seconds SET DEFAULT 600;

UPDATE ai_review_config
  SET max_duration_seconds = 600
  WHERE max_duration_seconds = 300;
