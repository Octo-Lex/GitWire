-- Migration 029: rollout promotion metadata
-- Adds promotion_reason column for audit trail.

ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS promotion_reason TEXT;
