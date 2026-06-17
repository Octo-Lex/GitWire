-- Migration 028: rollout approval metadata
-- Adds rejected state, approval metadata, and rejection tracking.
-- Makes the approval workflow explicit and auditable.

-- Add rejected to status CHECK constraint
ALTER TABLE policy_rollout_plans DROP CONSTRAINT IF EXISTS policy_rollout_plans_status_check;
ALTER TABLE policy_rollout_plans
  ADD CONSTRAINT policy_rollout_plans_status_check
  CHECK (status IN ('draft', 'validated', 'review_ready', 'approved', 'promoted', 'rolled_back', 'cancelled', 'rejected'));

-- Approval metadata
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS approval_reason TEXT;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS acknowledged_recommendations JSONB;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS reviewed_evidence JSONB;

-- Rejection metadata
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS rejected_by TEXT;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE policy_rollout_plans ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
