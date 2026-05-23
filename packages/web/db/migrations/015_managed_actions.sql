-- db/migrations/015_managed_actions.sql
-- Managed actions: track every GitHub mutation GitWire makes so they can be
-- reconciled when conditions change or the PR is closed.
--
-- When GitWire adds a label, posts a comment, or assigns a reviewer, it records
-- the action here. On PR force-push, closure, or re-evaluation, stale actions
-- are deactivated and removed from GitHub.

CREATE TABLE IF NOT EXISTS managed_actions (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT      NOT NULL REFERENCES repositories(github_id),
  source         TEXT        NOT NULL,          -- 'ci_heal', 'triage', 'ai_review', etc.
  source_id      BIGINT,                         -- FK to source table (heal_prs.id, etc.)
  pr_number      INT,                            -- NULL for issue-level actions
  issue_number   INT,
  action_type    TEXT        NOT NULL,          -- 'label', 'comment', 'reviewer', 'approval', 'branch_ref'
  action_key     TEXT        NOT NULL,          -- unique identifier for reconciliation
  action_value   TEXT,                           -- label name, comment body hash, reviewer login
  github_id      BIGINT,                         -- GitHub's resource ID (comment id, etc.)
  context_hash   TEXT,                           -- SHA-256 of triggering context
  active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ
);

-- Fast lookup: find all active actions for a PR+source for reconciliation
CREATE INDEX idx_managed_actions_reconcile
  ON managed_actions (repo_id, pr_number, source, active)
  WHERE active = TRUE;

-- Lookup by action_key for dedup
CREATE INDEX idx_managed_actions_key
  ON managed_actions (repo_id, pr_number, action_key)
  WHERE active = TRUE;

-- Cleanup: find stale actions for closed PRs
CREATE INDEX idx_managed_actions_cleanup
  ON managed_actions (active, created_at);
