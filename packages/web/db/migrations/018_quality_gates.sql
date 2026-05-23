-- 018_quality_gates.sql
-- Quality gate definitions and evaluation results.
-- Gates define metric thresholds that can block PR merges.

-- Gate definitions per repo
CREATE TABLE quality_gates (
  id              SERIAL PRIMARY KEY,
  repo_id         BIGINT NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  conditions      JSONB NOT NULL,  -- [{metric, operator, threshold}]
  block_on_fail   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, name)
);

CREATE INDEX idx_quality_gates_repo ON quality_gates(repo_id);

-- Gate evaluation results
CREATE TABLE gate_evaluations (
  id              SERIAL PRIMARY KEY,
  gate_id         INTEGER NOT NULL REFERENCES quality_gates(id) ON DELETE CASCADE,
  repo_id         BIGINT NOT NULL,
  head_sha        TEXT,            -- PR commit SHA
  pr_number       INTEGER,         -- PR number
  result          TEXT NOT NULL,   -- 'passed' | 'failed'
  conditions      JSONB NOT NULL,  -- [{metric, operator, threshold, actual, passed}]
  score           INTEGER NOT NULL,  -- 0-100
  passed_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  total_count     INTEGER NOT NULL DEFAULT 0,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms     INTEGER
);

CREATE INDEX idx_gate_evaluations_repo ON gate_evaluations(repo_id, evaluated_at DESC);
CREATE INDEX idx_gate_evaluations_pr ON gate_evaluations(repo_id, pr_number) WHERE pr_number IS NOT NULL;
CREATE INDEX idx_gate_evaluations_sha ON gate_evaluations(repo_id, head_sha) WHERE head_sha IS NOT NULL;
