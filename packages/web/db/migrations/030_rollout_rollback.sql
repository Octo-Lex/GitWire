-- Migration 030: rollback evidence
-- Adds rollback evidence fields for audit trail.
-- Captures replaced config and evidence metadata during rollback.

ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS rollback_reason TEXT;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS rollback_evidence JSONB;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS replaced_config_snapshot JSONB;
