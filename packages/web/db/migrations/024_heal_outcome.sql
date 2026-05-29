-- Migration 024: Add heal_outcome column to managed_actions
-- Lightweight L1.5 hook for future closed-loop verification.
-- Values: NULL (legacy) → 'pending' (heal created) → 'verified' | 'ineffective' | 'unknown'
-- Updated lazily by background job (deferred).

ALTER TABLE managed_actions
  ADD COLUMN IF NOT EXISTS heal_outcome VARCHAR(16);

COMMENT ON COLUMN managed_actions.heal_outcome IS
  'Outcome of a ci_healing action: pending, verified (CI passed), ineffective (CI still fails), unknown (timed out). NULL for non-heal actions.';
