-- Migration 026: Heal PR outcome tracking
-- Tracks whether heal PRs were merged, dismissed, or closed without merge.
-- Enables performance measurement of CI heal accuracy.

ALTER TABLE managed_actions
  ADD COLUMN IF NOT EXISTS pr_outcome VARCHAR(20),
  ADD COLUMN IF NOT EXISTS pr_merged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pr_closed_at TIMESTAMPTZ;

-- Index for querying outcomes by pillar
CREATE INDEX IF NOT EXISTS idx_managed_actions_pr_outcome
  ON managed_actions (pillar, pr_outcome)
  WHERE pillar = 'ci_healing' AND pr_outcome IS NOT NULL;

COMMENT ON COLUMN managed_actions.pr_outcome IS 'Final outcome of heal PR: merged, closed, dismissed, stale_closed, ci_failed';
COMMENT ON COLUMN managed_actions.pr_merged_at IS 'Timestamp when the heal PR was merged';
COMMENT ON COLUMN managed_actions.pr_closed_at IS 'Timestamp when the heal PR was closed (without merge)';
