-- Migration 027: policy_rollout_plans
-- Controlled rollout workflow for policy changes.
-- Stores proposed config, validation evidence, simulation summaries,
-- approval state, and previous policy snapshots for rollback.

CREATE TABLE IF NOT EXISTS policy_rollout_plans (
  id                    BIGSERIAL    PRIMARY KEY,
  repo_id               BIGINT       NOT NULL REFERENCES repositories(github_id),

  -- Proposed policy
  proposed_config       JSONB        NOT NULL,                  -- raw proposed config object
  normalized_config     JSONB,                                  -- redacted normalized config

  -- Evidence summaries (attached during lifecycle)
  validation_result     JSONB,                                  -- { valid, errors, warnings, risky_settings, ... }
  simulation_summary    JSONB,                                  -- { events_considered, would_act, would_skip, ... }
  diff_impact_summary   JSONB,                                  -- { dry_run_change, pillars_enabled, ... }
  recommendations_summary JSONB,                                -- { critical, warning, info, top_recommendations }

  -- Lifecycle state
  -- draft → validated → review_ready → approved → promoted
  --    ↘ cancelled
  -- promoted → rolled_back
  status                TEXT         NOT NULL DEFAULT 'draft',
  CHECK (status IN ('draft', 'validated', 'review_ready', 'approved', 'promoted', 'rolled_back', 'cancelled')),

  -- Previous policy snapshot (for rollback)
  previous_config       JSONB,                                  -- config before promotion

  -- Actor metadata
  created_by            TEXT         NOT NULL,                   -- GitHub username of creator
  approved_by           TEXT,                                   -- GitHub username of approver
  approved_at           TIMESTAMPTZ,                             -- when approval was granted
  promoted_by           TEXT,                                   -- who promoted to live
  promoted_at           TIMESTAMPTZ,                             -- when promotion happened
  rolled_back_by        TEXT,                                   -- who rolled back
  rolled_back_at        TIMESTAMPTZ,                             -- when rollback happened
  cancelled_by          TEXT,                                   -- who cancelled
  cancelled_at          TIMESTAMPTZ,

  -- Review notes
  review_notes          TEXT,                                   -- optional notes from reviewer

  -- Timestamps
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_rollout_repo       ON policy_rollout_plans (repo_id, status);
CREATE INDEX idx_rollout_status     ON policy_rollout_plans (status);
CREATE INDEX idx_rollout_created_by ON policy_rollout_plans (created_by);
CREATE INDEX idx_rollout_created_at ON policy_rollout_plans (created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_rollout_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rollout_updated_at
  BEFORE UPDATE ON policy_rollout_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_rollout_updated_at();
