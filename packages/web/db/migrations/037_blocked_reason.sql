-- 037_blocked_reason.sql
-- Add blocked_reason column and blocked state support to managed_actions.
--
-- The "blocked" state means a deterministic guard deliberately prevented
-- execution (drift, policy denial, duplicate, etc.). This is distinct from
-- "failed" which means execution was attempted and crashed.
--
-- The blocked_reason column stores the typed reason (BLOCKED_REASONS enum)
-- so abstention outcomes are queryable: "automation did not act BECAUSE X."

ALTER TABLE managed_actions
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Index for querying abstention metrics by reason
CREATE INDEX IF NOT EXISTS idx_managed_actions_blocked_reason
  ON managed_actions (blocked_reason)
  WHERE blocked_reason IS NOT NULL;
