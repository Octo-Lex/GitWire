-- Migration 023: Unify action lifecycle
-- Backfill legacy recordAction() rows with state machine columns.
-- All actions get lifecycle-appropriate status and timestamps.

-- Step 1: Mark legacy actions that are still active as 'succeeded'
-- (they completed successfully, just weren't tracked through the state machine)
UPDATE managed_actions
SET status = 'succeeded',
    proposed_at = created_at,
    approved_at = created_at,
    executed_at = created_at,
    resolved_at = created_at
WHERE proposed_at IS NULL
  AND active = TRUE;

-- Step 2: Mark legacy actions that were deactivated as 'cancelled'
UPDATE managed_actions
SET status = 'cancelled',
    proposed_at = created_at,
    resolved_at = COALESCE(deactivated_at, created_at)
WHERE proposed_at IS NULL
  AND active = FALSE;

-- Step 3: Backfill pillar from source for legacy rows that don't have it
UPDATE managed_actions
SET pillar = CASE source
  WHEN 'ci_heal' THEN 'ci_healing'
  WHEN 'triage' THEN 'triage'
  WHEN 'custom_rules' THEN 'custom_rules'
  WHEN 'ai_triage' THEN 'triage'
  WHEN 'ai_heal' THEN 'ci_healing'
  ELSE source
END
WHERE pillar IS NULL OR pillar = '';

-- Step 4: Backfill target_type and target_number from pr_number/issue_number
-- Only for rows that don't have these set yet
UPDATE managed_actions
SET target_type = 'pr',
    target_number = pr_number
WHERE target_type IS NULL
  AND pr_number IS NOT NULL;

UPDATE managed_actions
SET target_type = 'issue',
    target_number = issue_number
WHERE target_type IS NULL
  AND issue_number IS NOT NULL;
