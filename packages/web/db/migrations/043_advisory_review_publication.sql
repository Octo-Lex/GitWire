-- 043: Advisory AI review publication receipt (frozen v1.2)
--
-- Extends ai_reviews with the judgment / integrity / authority / publication
-- receipt so every terminal review is reconstructable, and adds the
-- publication-mode switch to ai_review_config ("advisory" is the pilot
-- default; "legacy_stateful" is the rollback switch).
--
-- Publication state machine: computed -> submitting -> published
-- (terminal failures record 'failed' with a terminal_reason).

ALTER TABLE ai_reviews
  ADD COLUMN IF NOT EXISTS judgment            TEXT,
  ADD COLUMN IF NOT EXISTS published_outcome   TEXT,
  ADD COLUMN IF NOT EXISTS integrity_state     TEXT,
  ADD COLUMN IF NOT EXISTS authority_state     TEXT,
  ADD COLUMN IF NOT EXISTS publication_mode    TEXT,
  ADD COLUMN IF NOT EXISTS policy_blocked      BOOLEAN,
  ADD COLUMN IF NOT EXISTS github_review_event TEXT,
  ADD COLUMN IF NOT EXISTS publication_state   TEXT,
  ADD COLUMN IF NOT EXISTS terminal_reason     TEXT,
  ADD COLUMN IF NOT EXISTS coverage            JSONB,
  ADD COLUMN IF NOT EXISTS evidence_receipts   JSONB,
  -- Lease stamp for the atomic publication claim: set when an invocation
  -- transitions the row to 'submitting'; a crashed claim becomes re-takeable
  -- only after it goes stale, so a live owner between claim and POST can
  -- never be released by a concurrent loser.
  ADD COLUMN IF NOT EXISTS publication_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ar_integrity_state    ON ai_reviews(integrity_state);
CREATE INDEX IF NOT EXISTS idx_ar_publication_state ON ai_reviews(publication_state);

ALTER TABLE ai_review_config
  ADD COLUMN IF NOT EXISTS publication_mode TEXT NOT NULL DEFAULT 'advisory';
