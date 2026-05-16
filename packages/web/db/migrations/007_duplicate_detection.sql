-- db/migrations/007_duplicate_detection.sql
-- Stores vector embeddings for issues and duplicate detection signals.
--
-- We store embeddings as REAL[] (PostgreSQL float4 array) rather than
-- requiring pgvector. Cosine similarity is computed in JavaScript for
-- simplicity; if the corpus grows beyond ~50k issues, migrating to
-- pgvector with an IVFFlat index is the natural upgrade path.

-- ── Issue embeddings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS issue_embeddings (
  id            BIGSERIAL    PRIMARY KEY,
  issue_id      BIGINT       NOT NULL UNIQUE REFERENCES issues(github_id) ON DELETE CASCADE,
  repo_id       BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  -- Embedding vector from Voyage AI voyage-3-lite (512 dims)
  -- Stored as float4 array; cast to float8 for arithmetic
  embedding     REAL[]       NOT NULL,
  -- The text that was embedded (title + first 500 chars of body)
  embedded_text TEXT         NOT NULL,
  model         TEXT         NOT NULL DEFAULT 'voyage-3-lite',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_repo ON issue_embeddings(repo_id);

-- ── Duplicate signals ─────────────────────────────────────────────────────────
-- One row per detected duplicate pair. source = the new issue,
-- target = the existing canonical issue it resembles.
CREATE TABLE IF NOT EXISTS duplicate_signals (
  id              BIGSERIAL    PRIMARY KEY,
  source_issue_id BIGINT       NOT NULL REFERENCES issues(github_id) ON DELETE CASCADE,
  target_issue_id BIGINT       NOT NULL REFERENCES issues(github_id) ON DELETE CASCADE,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  similarity      REAL         NOT NULL,  -- 0.0-1.0 cosine similarity
  -- Status set by a human or automation
  status          TEXT         NOT NULL DEFAULT 'pending',  -- pending | confirmed | dismissed
  -- GitHub comment ID posted on the source issue (so we can edit it later)
  comment_id      BIGINT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(source_issue_id, target_issue_id)
);

CREATE INDEX IF NOT EXISTS idx_dup_source ON duplicate_signals(source_issue_id);
CREATE INDEX IF NOT EXISTS idx_dup_target ON duplicate_signals(target_issue_id);
CREATE INDEX IF NOT EXISTS idx_dup_repo   ON duplicate_signals(repo_id);
CREATE INDEX IF NOT EXISTS idx_dup_status ON duplicate_signals(status);

-- Track embedding coverage on the issues table
ALTER TABLE issues
  ADD COLUMN IF NOT EXISTS embedding_id    BIGINT,
  ADD COLUMN IF NOT EXISTS duplicate_of    BIGINT,   -- github_id of canonical if confirmed
  ADD COLUMN IF NOT EXISTS dup_check_at    TIMESTAMPTZ;
