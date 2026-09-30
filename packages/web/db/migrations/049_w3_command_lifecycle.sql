-- 049_w3_command_lifecycle.sql
-- W3-02 — CAS/versioned mutation lifecycle primitives (claim-then-advance).
--
-- Non-destructive from the 048 baseline, with ONE controlled replacement:
-- the W3-01-owned trg_mutation_commands_no_update trigger becomes the
-- transition guard. DELETE/TRUNCATE protections on mutation_commands and the
-- entire mutation_outbox wall are unchanged.
--
-- Mechanism (frozen in issue #402):
--   * public.mutation_transition_legality — the legal-edge table (data, so
--     later migrations add states without touching guard functions);
--   * public.mutation_command_transitions — the append-only journal whose
--     UNIQUE (command_id, from_version) / (command_id, to_version) make the
--     claim INSERT the compare-and-swap arbiter (one writer per version);
--   * claim guard (BEFORE INSERT on the journal): from_version must equal the
--     command's current version, to_version = from_version + 1, from_status
--     must equal the command's current status, and the edge must be legal;
--   * transition guard (BEFORE UPDATE on mutation_commands): intent columns
--     immutable; version increments exactly once; edge legal; a matching
--     claim exists; performer and timestamp agree with the claim;
--   * deferred consistency check (CONSTRAINT TRIGGER on the journal): at
--     COMMIT every new claim must correspond to the resulting command state —
--     a claim without its advance cannot commit, and vice versa.
--
-- Because the application connects as the table-owning superuser, this is
-- constraint/trigger enforcement, not privilege enforcement: it guards all
-- supported paths, on the same protection level as the W3-01 walls. A
-- deliberate superuser can still disable triggers — outside the threat model.

-- ── 1. Command lifecycle columns ────────────────────────────────────────────
-- Historical 048 rows initialize deterministically at version 1 / 'created'
-- via the column DEFAULT; no synthetic journal row is created.
ALTER TABLE public.mutation_commands
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN last_transition_at timestamptz,
  ADD COLUMN last_transitioned_by text;

-- ── 2. Legality table ───────────────────────────────────────────────────────
CREATE TABLE public.mutation_transition_legality (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  CONSTRAINT pk_mutation_transition_legality PRIMARY KEY (from_status, to_status)
);

INSERT INTO public.mutation_transition_legality (from_status, to_status) VALUES
  ('created',   'claimed'),
  ('created',   'cancelled'),
  ('claimed',   'executing'),
  ('claimed',   'cancelled'),
  ('executing', 'completed'),
  ('executing', 'failed');

-- ── 3. Transition journal ───────────────────────────────────────────────────
CREATE TABLE public.mutation_command_transitions (
  seq             BIGSERIAL   PRIMARY KEY,
  command_id      uuid        NOT NULL
                              REFERENCES public.mutation_commands(id) ON DELETE RESTRICT,
  from_status     text        NOT NULL,
  to_status       text        NOT NULL,
  from_version    BIGINT      NOT NULL,
  to_version      BIGINT      NOT NULL,
  transitioned_by text        NOT NULL,
  transitioned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason          text,

  -- The claim INSERT is the compare-and-swap arbiter: one edge out of a
  -- version, one edge into a version — a strict linear chain per command.
  CONSTRAINT uq_mutation_transitions_from_version
    UNIQUE (command_id, from_version),
  CONSTRAINT uq_mutation_transitions_to_version
    UNIQUE (command_id, to_version),
  CONSTRAINT chk_mutation_transitions_version_step
    CHECK (to_version = from_version + 1)
);

CREATE INDEX ix_mutation_transitions_command
  ON public.mutation_command_transitions (command_id, seq);

-- ── 4. Claim guard ──────────────────────────────────────────────────────────
CREATE FUNCTION w3_02_validate_transition_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_command public.mutation_commands%ROWTYPE;
BEGIN
  SELECT * INTO v_command
    FROM public.mutation_commands
   WHERE id = NEW.command_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition claim references unknown command %', NEW.command_id;
  END IF;
  IF NEW.from_version IS DISTINCT FROM v_command.version THEN
    RAISE EXCEPTION 'transition claim version mismatch: command at version %, claim from version %',
      v_command.version, NEW.from_version;
  END IF;
  IF NEW.to_version IS DISTINCT FROM NEW.from_version + 1 THEN
    RAISE EXCEPTION 'transition claim must advance exactly one version';
  END IF;
  IF NEW.from_status IS DISTINCT FROM v_command.status THEN
    RAISE EXCEPTION 'transition claim status mismatch: command in %, claim from %',
      v_command.status, NEW.from_status;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.mutation_transition_legality l
     WHERE l.from_status = NEW.from_status
       AND l.to_status = NEW.to_status
  ) THEN
    RAISE EXCEPTION 'transition claim edge % -> % is not legal', NEW.from_status, NEW.to_status;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mutation_transitions_validate_claim
  BEFORE INSERT ON public.mutation_command_transitions
  FOR EACH ROW EXECUTE FUNCTION w3_02_validate_transition_claim();

-- ── 5. Journal is append-only (same protection family as 048) ───────────────
CREATE TRIGGER trg_mutation_transitions_no_update
  BEFORE UPDATE ON public.mutation_command_transitions
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_transitions_no_delete
  BEFORE DELETE ON public.mutation_command_transitions
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_transitions_no_truncate
  BEFORE TRUNCATE ON public.mutation_command_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w3_mutation_command_append_only();

-- ── 6. Deferred consistency: a claim without its advance cannot commit ─────
CREATE FUNCTION w3_02_verify_claim_committed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_version BIGINT;
  v_status  text;
BEGIN
  SELECT version, status INTO v_version, v_status
    FROM public.mutation_commands
   WHERE id = NEW.command_id;

  IF v_version IS DISTINCT FROM NEW.to_version OR v_status IS DISTINCT FROM NEW.to_status THEN
    RAISE EXCEPTION 'orphaned transition claim: command % is at version %/%, claim expected %/%',
      NEW.command_id, v_version, v_status, NEW.to_version, NEW.to_status;
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_mutation_transitions_verify_committed
  AFTER INSERT ON public.mutation_command_transitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION w3_02_verify_claim_committed();

-- ── 7. Command transition guard (replaces the 048 blanket no-update) ────────
CREATE FUNCTION w3_02_guard_command_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Intent is immutable: every 048 intent column must be identical.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
     OR NEW.resource_identity IS DISTINCT FROM OLD.resource_identity
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.request IS DISTINCT FROM OLD.request
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.authorization_evidence_id IS DISTINCT FROM OLD.authorization_evidence_id
     OR NEW.policy_context IS DISTINCT FROM OLD.policy_context
     OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'mutation command intent is immutable';
  END IF;

  -- Version advances exactly once, on a legal edge.
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'mutation command version must advance exactly once';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.mutation_transition_legality l
     WHERE l.from_status = OLD.status
       AND l.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'transition edge % -> % is not legal', OLD.status, NEW.status;
  END IF;

  -- A matching claim must exist, and the command row cannot contradict it:
  -- performer and timestamp must agree with the journal (the journal is the
  -- authority for the transition's audit fields).
  IF NOT EXISTS (
    SELECT 1 FROM public.mutation_command_transitions t
     WHERE t.command_id = OLD.id
       AND t.from_version = OLD.version
       AND t.to_version = NEW.version
       AND t.from_status = OLD.status
       AND t.to_status = NEW.status
       AND t.transitioned_by = NEW.last_transitioned_by
       AND t.transitioned_at = NEW.last_transition_at
  ) THEN
    RAISE EXCEPTION 'mutation command transition has no matching journal claim';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER trg_mutation_commands_no_update ON public.mutation_commands;

CREATE TRIGGER trg_mutation_commands_transition_guard
  BEFORE UPDATE ON public.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION w3_02_guard_command_transition();
