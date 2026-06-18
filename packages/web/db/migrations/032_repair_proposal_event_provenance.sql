-- ════════════════════════════════════════════════════════════════════════════
-- 032: Repair proposal event provenance — forward-only migration
-- ════════════════════════════════════════════════════════════════════════════
-- Adds source_delivery_id to repair_proposal_events so that each CI evidence
-- collection event records the GitHub webhook delivery ID that triggered it,
-- alongside the existing correlation_id (execution tracing).

ALTER TABLE repair_proposal_events
  ADD COLUMN IF NOT EXISTS source_delivery_id TEXT;
