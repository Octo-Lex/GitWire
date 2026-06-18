-- Migration 031: repair_proposals
-- Governed CI repair proposal model.
-- Represents a proposed repair for a CI failure with strict tool/write
-- authority, evidence requirements, and append-only event history.
--
-- Key invariant: can_write_repository is ALWAYS false.
-- No state transition can set it to true.
-- The "applied" state is reached only through an external governed action.

CREATE TABLE IF NOT EXISTS repair_proposals (
  id                    BIGSERIAL    PRIMARY KEY,
  repo_id               BIGINT       NOT NULL REFERENCES repositories(github_id),

  -- CI failure source (traceable)
  ci_run_id             BIGINT,                          -- soft ref to ci_runs.id (may not exist)
  workflow_run_id       BIGINT       NOT NULL,
  job_id                BIGINT,
  head_sha              TEXT         NOT NULL,
  base_sha              TEXT,                            -- commit the patch was generated against
  failure_type          TEXT,                            -- lint_error, test_failure, build_error, etc.

  -- Idempotency: prevent duplicate proposals for the same CI failure
  source_fingerprint    TEXT         NOT NULL,           -- repo + workflow_run_id + job_id + head_sha + failure_type

  -- Governed task envelope (constraint, NOT capability grant)
  -- Server intersects: repository_policy ∩ worker_capabilities ∩ envelope
  task_envelope         JSONB        NOT NULL,

  -- Structured evidence references (NOT raw model reasoning)
  -- Narrow schema: summary, failure_category, root_cause_claim, confidence, limitations, evidence_ids
  diagnosis             JSONB,

  -- Evidence references (append-only via events table)
  evidence_refs         JSONB,                           -- [{ type, source, excerpt_hash, description }]

  -- Patch proposal (immutable artifact reference, not raw diff)
  -- { files: [{path, change_type, artifact_ref, lines_changed}], total_files, total_lines_changed }
  patch_proposal        JSONB,

  -- Validation result from verification runner
  -- { checks: [{name, passed, output_hash}], overall: pass|fail }
  validation_result     JSONB,

  -- Critic/safety review
  -- { verdict: approve|reject, concerns, scope_violations, unrelated_changes }
  critic_review         JSONB,

  -- Lifecycle state
  status                TEXT NOT NULL DEFAULT 'detected',
  CHECK (status IN (
    'detected', 'evidence_collected', 'proposed', 'verified',
    'review_ready', 'approved', 'applied', 'verified_after_apply',
    'rejected', 'cancelled', 'failed', 'superseded'
  )),

  -- Optimistic concurrency / compare-and-swap
  version               INT NOT NULL DEFAULT 1,

  -- Supersession chain (for revised proposals)
  supersedes_id         BIGINT REFERENCES repair_proposals(id),

  -- Actor metadata (from authenticated principal, never request body)
  created_by            TEXT NOT NULL DEFAULT 'system',
  approved_by           TEXT,
  approved_at           TIMESTAMPTZ,
  approval_reason       TEXT,
  applied_by            TEXT,
  applied_at            TIMESTAMPTZ,
  rejected_by           TEXT,
  rejected_at           TIMESTAMPTZ,
  rejected_reason       TEXT,
  cancelled_by          TEXT,
  cancelled_at          TIMESTAMPTZ,
  cancelled_reason      TEXT,
  failed_reason         TEXT,

  -- External links (soft refs — governed action system)
  managed_action_id     BIGINT,                          -- soft ref to managed_actions.id
  decision_log_id       BIGINT,                          -- soft ref to decision_log.id

  -- Timestamps
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Idempotency: unique constraint on (repo_id, source_fingerprint)
-- Prevents duplicate proposals for the same CI failure.
-- ON CONFLICT in the application returns the existing proposal.
CREATE UNIQUE INDEX idx_repair_fingerprint_unique
  ON repair_proposals (repo_id, source_fingerprint);

-- Indexes
CREATE INDEX idx_repair_repo        ON repair_proposals (repo_id, status);
CREATE INDEX idx_repair_status      ON repair_proposals (status);
CREATE INDEX idx_repair_sha         ON repair_proposals (head_sha);
CREATE INDEX idx_repair_created     ON repair_proposals (created_at DESC);
CREATE INDEX idx_repair_supersedes  ON repair_proposals (supersedes_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_repair_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repair_updated_at
  BEFORE UPDATE ON repair_proposals
  FOR EACH ROW
  EXECUTE FUNCTION update_repair_updated_at();


-- ──────────────────────────────────────────────────────────────────────────
-- Append-only event history table
-- This is the proof trail. The main row is a projection; events are immutable.
-- Each evidence_attached event stores a full snapshot of what was attached
-- (with content hashes) so the trail is reconstructable.
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repair_proposal_events (
  id                    BIGSERIAL    PRIMARY KEY,
  proposal_id           BIGINT       NOT NULL REFERENCES repair_proposals(id) ON DELETE CASCADE,
  event_type            TEXT         NOT NULL,           -- state_transition, evidence_attached, etc.
  from_status           TEXT,
  to_status             TEXT,
  actor                 TEXT         NOT NULL DEFAULT 'system',
  reason                TEXT,
  evidence_snapshot     JSONB,                            -- full snapshot: { field: { value, content_hash } }
  correlation_id        TEXT,                             -- for tracing across services
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repair_events_proposal ON repair_proposal_events (proposal_id, created_at DESC);
CREATE INDEX idx_repair_events_type     ON repair_proposal_events (event_type);

-- Prevent mutation or deletion of event rows (append-only enforcement).
-- Only INSERT is allowed; UPDATE and DELETE are blocked at the database level.
CREATE OR REPLACE FUNCTION prevent_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'repair_proposal_events is append-only: % operation not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_event_update
  BEFORE UPDATE ON repair_proposal_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_event_mutation();

CREATE TRIGGER trg_prevent_event_delete
  BEFORE DELETE ON repair_proposal_events
  FOR EACH ROW
  EXECUTE FUNCTION prevent_event_mutation();
