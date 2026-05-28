-- 021_action_state_machine_columns.sql
-- Add columns required by actionStateMachine.js that migration 019 missed.
-- Without these, propose() fails with "column X of relation managed_actions does not exist".

ALTER TABLE managed_actions
  ADD COLUMN IF NOT EXISTS pillar TEXT,
  ADD COLUMN IF NOT EXISTS target_type TEXT,
  ADD COLUMN IF NOT EXISTS target_number INTEGER;

-- Backfill pillar from source for existing rows
UPDATE managed_actions SET pillar = source WHERE pillar IS NULL AND source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_managed_actions_pillar ON managed_actions(pillar)
  WHERE pillar IS NOT NULL;
