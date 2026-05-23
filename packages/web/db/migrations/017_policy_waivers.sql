-- Migration 017: policy_waivers
-- Time-limited policy exceptions with audit trail.
-- Allows temporary bypass of specific pillars (e.g., CI heal freeze during release).

CREATE TABLE IF NOT EXISTS policy_waivers (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT      NOT NULL REFERENCES repositories(github_id),
  pillar      TEXT        NOT NULL,                -- 'ci_healing', 'ai_review', 'triage', etc.
  scope       TEXT        NOT NULL DEFAULT 'repo', -- 'repo', 'branch', 'pr', 'issue'
  scope_value TEXT,                                -- branch name, PR/issue number, etc.
  reason      TEXT        NOT NULL,                -- why the waiver was granted
  granted_by  TEXT        NOT NULL,                -- GitHub username
  expires_at  TIMESTAMPTZ,                         -- NULL = indefinite (until revoked)
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

-- Fast lookup: find active waivers for a repo+pillar
CREATE INDEX idx_waivers_active ON policy_waivers (repo_id, pillar, active)
  WHERE active = TRUE;

-- Fast lookup: find expiring waivers for cleanup
CREATE INDEX idx_waivers_expiry ON policy_waivers (expires_at)
  WHERE active = TRUE;

-- Find waivers by scope (e.g., all waivers for a specific branch)
CREATE INDEX idx_waivers_scope ON policy_waivers (repo_id, scope, scope_value)
  WHERE active = TRUE;
