-- db/migrations/005_governance.sql
-- GitWire Maintainer v2: Org governance tables
--   members             — org/installation-level members with roles
--   repo_collaborators  — per-repo collaborator access (synced from GitHub)
--   branch_rules        — branch protection rules per repo (synced from GitHub)
--   audit_log           — every permission/rule change recorded here

-- ── Members ───────────────────────────────────────────────────────────────────
-- One row per GitHub user per installation.
CREATE TABLE IF NOT EXISTS members (
  id              BIGSERIAL    PRIMARY KEY,
  installation_id BIGINT       NOT NULL REFERENCES installations(github_id),
  github_login    TEXT         NOT NULL,
  github_id       BIGINT,
  avatar_url      TEXT,
  role            TEXT         NOT NULL DEFAULT 'member',  -- 'owner' | 'member'
  site_admin      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(installation_id, github_login)
);

CREATE INDEX IF NOT EXISTS idx_members_installation ON members(installation_id);
CREATE INDEX IF NOT EXISTS idx_members_login        ON members(github_login);

-- ── Repo collaborators ────────────────────────────────────────────────────────
-- Explicit collaborator records per repository (includes outside collaborators).
CREATE TABLE IF NOT EXISTS repo_collaborators (
  id            BIGSERIAL    PRIMARY KEY,
  repo_id       BIGINT       NOT NULL REFERENCES repositories(github_id),
  github_login  TEXT         NOT NULL,
  github_id     BIGINT,
  avatar_url    TEXT,
  -- GitHub permission levels: pull | triage | push | maintain | admin
  permission    TEXT         NOT NULL DEFAULT 'pull',
  role_name     TEXT,                                      -- display name GitHub returns
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, github_login)
);

CREATE INDEX IF NOT EXISTS idx_collabs_repo  ON repo_collaborators(repo_id);
CREATE INDEX IF NOT EXISTS idx_collabs_login ON repo_collaborators(github_login);

-- ── Branch protection rules ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branch_rules (
  id                          BIGSERIAL    PRIMARY KEY,
  repo_id                     BIGINT       NOT NULL REFERENCES repositories(github_id),
  pattern                     TEXT         NOT NULL,       -- e.g. 'main', 'release/*'
  -- Core protection settings
  required_reviews            INT          NOT NULL DEFAULT 0,
  dismiss_stale_reviews       BOOLEAN      NOT NULL DEFAULT FALSE,
  require_code_owner_reviews  BOOLEAN      NOT NULL DEFAULT FALSE,
  require_status_checks       BOOLEAN      NOT NULL DEFAULT FALSE,
  required_status_checks      TEXT[]       NOT NULL DEFAULT '{}',  -- check names
  require_up_to_date_branch   BOOLEAN      NOT NULL DEFAULT FALSE,
  enforce_admins              BOOLEAN      NOT NULL DEFAULT FALSE,
  restrict_pushes             BOOLEAN      NOT NULL DEFAULT FALSE,
  push_allowlist              TEXT[]       NOT NULL DEFAULT '{}',   -- logins
  allow_force_pushes          BOOLEAN      NOT NULL DEFAULT FALSE,
  allow_deletions             BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Sync metadata
  github_rule_id              INT,
  synced_at                   TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, pattern)
);

CREATE INDEX IF NOT EXISTS idx_branch_rules_repo ON branch_rules(repo_id);

-- ── Audit log ─────────────────────────────────────────────────────────────────
-- Append-only record of every change made through the maintainer API.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL    PRIMARY KEY,
  actor       TEXT         NOT NULL,    -- github login of the person who triggered the action
  action      TEXT         NOT NULL,    -- e.g. 'collaborator.add', 'branch_rule.update'
  target_type TEXT         NOT NULL,    -- 'repo' | 'member' | 'branch_rule'
  target_id   TEXT         NOT NULL,    -- repo full_name, login, etc.
  payload     JSONB,
  success     BOOLEAN      NOT NULL DEFAULT TRUE,
  error       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(created_at DESC);
