-- 019_action_lifecycle.sql
-- Action lifecycle state machine: track every GitWire action from proposal to reconciliation.

-- Add lifecycle columns to managed_actions.
-- repo_full_name is added here (not in 015's CREATE TABLE) because the index
-- below needs it and 015 only defined repo_id. IF NOT EXISTS keeps this
-- idempotent for databases where the column was added ad-hoc (e.g. CT 115's
-- first-boot path). Without this, a fresh-DB migration fails at the index.
ALTER TABLE managed_actions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'succeeded',
  ADD COLUMN IF NOT EXISTS repo_full_name TEXT,
  ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retries INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS parent_action_id BIGINT REFERENCES managed_actions(id),
  ADD COLUMN IF NOT EXISTS evidence JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_status TEXT;

-- Update existing rows to have resolved_at = created_at (they're already done)
UPDATE managed_actions
SET status = 'succeeded',
    proposed_at = created_at,
    approved_at = created_at,
    executed_at = created_at,
    resolved_at = created_at,
    reconciliation_status = 'confirmed'
WHERE status = 'succeeded' AND resolved_at IS NULL;

-- Index for querying by status
CREATE INDEX IF NOT EXISTS idx_managed_actions_status ON managed_actions(status);
CREATE INDEX IF NOT EXISTS idx_managed_actions_repo_status ON managed_actions(repo_full_name, status);
CREATE INDEX IF NOT EXISTS idx_managed_actions_resolved_at ON managed_actions(resolved_at)
  WHERE resolved_at IS NULL;

-- Reconciliation log — tracks drift detection results
CREATE TABLE IF NOT EXISTS action_reconciliation_log (
  id BIGSERIAL PRIMARY KEY,
  action_id BIGINT NOT NULL REFERENCES managed_actions(id),
  check_type TEXT NOT NULL,           -- 'label', 'pr_state', 'review', 'comment', 'branch'
  expected TEXT,                        -- what we expect to see
  actual TEXT,                          -- what we actually found
  drifted BOOLEAN NOT NULL DEFAULT false,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_action ON action_reconciliation_log(action_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_drift ON action_reconciliation_log(drifted)
  WHERE drifted = true;
