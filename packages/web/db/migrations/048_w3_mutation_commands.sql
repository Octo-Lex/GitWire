-- 048_w3_mutation_commands.sql
-- W3-01 — Canonical Mutation Commands, Transactional Outbox, Database Idempotency
--
-- Additive substrate only. Establishes durable mutation INTENT:
--   * immutable command rows (public.mutation_commands);
--   * transactional initial outbox events (public.mutation_outbox);
--   * database-enforced idempotency over
--     (namespace, authoritative resource identity, idempotency key);
--   * command-bound authorization evidence via FK to the existing
--     append-only gitwire_auth.auth_decision_log (cross-schema reference
--     follows the 046 policy_promotion_records precedent).
--
-- No executor, dispatcher, receipt, reconciliation, lifecycle machinery, or
-- writer cutover is introduced here (W3-02 .. W3-09 own those). No
-- pre-existing object is modified. No CASCADE anywhere.
--
-- Uniqueness domain note: resource_identity is the canonical authoritative
-- resource string (e.g. "repository:<github_id>") carried by the service;
-- the physical index adds the operation discriminator so one producer
-- namespace may reuse a key across distinct operations on the same resource
-- without weakening per-operation idempotency.

CREATE TABLE public.mutation_commands (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace                text        NOT NULL,
  idempotency_key          text        NOT NULL,
  operation                text        NOT NULL,
  resource_type            text        NOT NULL,
  resource_identity        text        NOT NULL,
  target                   jsonb       NOT NULL,
  request                  jsonb       NOT NULL,
  request_hash             text        NOT NULL
                                       CONSTRAINT chk_mutation_commands_hash
                                       CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  principal_id             uuid        NOT NULL
                                       REFERENCES gitwire_auth.auth_principals(id)
                                       ON DELETE RESTRICT,
  authorization_evidence_id uuid       NOT NULL
                                       REFERENCES gitwire_auth.auth_decision_log(id)
                                       ON DELETE RESTRICT,
  policy_context           jsonb,
  approval_ref             text,
  correlation_id           text,
  status                   text        NOT NULL DEFAULT 'created',
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mutation_commands_idempotency
    UNIQUE (namespace, resource_identity, idempotency_key, operation)
);

CREATE INDEX ix_mutation_commands_resource
  ON public.mutation_commands (resource_type, resource_identity, created_at DESC);

CREATE INDEX ix_mutation_commands_principal
  ON public.mutation_commands (principal_id, created_at DESC);

CREATE INDEX ix_mutation_commands_evidence
  ON public.mutation_commands (authorization_evidence_id);

-- The transactional outbox. `seq` is the database-owned monotonic ordering
-- identity (never created_at alone); `event_id` is the stable event identity.
-- UNIQUE (command_id, event_type) guarantees at most one initial
-- `mutation.command.created` event per command while leaving room for later
-- W3 event types without schema change.
CREATE TABLE public.mutation_outbox (
  seq           BIGSERIAL   PRIMARY KEY,
  event_id      uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  command_id    uuid        NOT NULL
                            REFERENCES public.mutation_commands(id)
                            ON DELETE RESTRICT,
  event_type    text        NOT NULL,
  request_hash  text        NOT NULL
                            CONSTRAINT chk_mutation_outbox_hash
                            CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_mutation_outbox_event_per_command
    UNIQUE (command_id, event_type)
);

CREATE INDEX ix_mutation_outbox_command
  ON public.mutation_outbox (command_id);

CREATE INDEX ix_mutation_outbox_type_seq
  ON public.mutation_outbox (event_type, seq);

-- W3-01 mutation intent is append-only: a committed command's intent fields
-- and its outbox events can never be rewritten or removed through supported
-- application/database paths (repository-consistent with 041/045/046/047).
CREATE FUNCTION enforce_w3_mutation_command_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_mutation_commands_no_update
  BEFORE UPDATE ON public.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_commands_no_delete
  BEFORE DELETE ON public.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_commands_no_truncate
  BEFORE TRUNCATE ON public.mutation_commands
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w3_mutation_command_append_only();

CREATE TRIGGER trg_mutation_outbox_no_update
  BEFORE UPDATE ON public.mutation_outbox
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_outbox_no_delete
  BEFORE DELETE ON public.mutation_outbox
  FOR EACH ROW EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
CREATE TRIGGER trg_mutation_outbox_no_truncate
  BEFORE TRUNCATE ON public.mutation_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w3_mutation_command_append_only();
