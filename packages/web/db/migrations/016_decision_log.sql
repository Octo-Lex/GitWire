-- db/migrations/016_decision_log.sql
-- Decision log: records WHY each GitWire worker made its decision.
-- Complements the action_feed (what happened) with the reasoning chain
-- (conditions evaluated, config used, conclusion reached).

CREATE TABLE IF NOT EXISTS decision_log (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT      NOT NULL REFERENCES repositories(github_id),
  source         TEXT        NOT NULL,          -- 'ci_heal', 'triage', 'ai_review', 'issue_fix', 'merge_queue', 'enforcement', 'trust'
  trigger_event  TEXT        NOT NULL,          -- 'push', 'pr_opened', 'label_added', 'workflow_completed'
  target_type    TEXT        NOT NULL,          -- 'pr' or 'issue'
  target_number  INT         NOT NULL,
  pillar         TEXT,                           -- which pillar was evaluated
  decision       TEXT        NOT NULL,          -- 'acted', 'skipped', 'dry_run', 'blocked', 'error'
  reason         TEXT,                           -- human-readable explanation
  conditions     JSONB,                         -- evaluated conditions with results
  config_used    JSONB,                         -- snapshot of relevant config at decision time
  commit_sha     TEXT,
  actor          TEXT        NOT NULL DEFAULT 'gitwire[bot]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Query: recent decisions for a repo
CREATE INDEX idx_decision_log_repo ON decision_log (repo_id, created_at DESC);

-- Query: decisions for a specific PR or issue
CREATE INDEX idx_decision_log_target ON decision_log (repo_id, target_type, target_number, created_at DESC);

-- Query: decisions by source/worker
CREATE INDEX idx_decision_log_source ON decision_log (source, created_at DESC);
