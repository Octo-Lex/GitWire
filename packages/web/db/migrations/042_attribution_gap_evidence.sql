-- 042_attribution_gap_evidence.sql
-- Wave 2 runtime attribution gap evidence (issue #94).
--
-- Append-only table for structured authority.attribution_gap events. Each gap
-- emits exactly one row when a writer is called without a principalId. This is
-- a transitional safeguard — the final Wave 2 target is 42/42 adopted writers
-- with 0 gaps.
--
-- Fail-closed: plain CREATE (no IF NOT EXISTS) for the new table.
-- Append-only enforced by trigger.
-- No CASCADE, no passwords, no secrets.

SET search_path = gitwire_auth, pg_catalog;

CREATE TABLE gitwire_auth.attribution_gap_evidence (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event         text        NOT NULL DEFAULT 'authority.attribution_gap',
  reason_code   text        NOT NULL,
  surface_id    text        NOT NULL,
  writer        text        NOT NULL,
  table_name    text        NOT NULL,
  operation     text        NOT NULL,
  principal_id  uuid,
  legacy_actor  text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_attribution_gap_surface
  ON gitwire_auth.attribution_gap_evidence (surface_id, occurred_at DESC);

CREATE INDEX ix_attribution_gap_reason
  ON gitwire_auth.attribution_gap_evidence (reason_code, occurred_at DESC);

-- Wave 2 grants: the attribution gap table is written by the application
-- (recordAttributionGap runs as gitwire_app) and inspected by the operator.
-- USAGE on the schema is already granted by 039; table-level privileges are
-- specified here.
GRANT INSERT ON gitwire_auth.attribution_gap_evidence TO gitwire_app;
GRANT SELECT ON gitwire_auth.attribution_gap_evidence TO gitwire_operator;

-- Append-only trigger
CREATE FUNCTION gitwire_auth.enforce_attribution_gap_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'attribution_gap_evidence is append-only';
END;
$$;

CREATE TRIGGER trg_attribution_gap_no_update
  BEFORE UPDATE ON gitwire_auth.attribution_gap_evidence
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_attribution_gap_append_only();
CREATE TRIGGER trg_attribution_gap_no_delete
  BEFORE DELETE ON gitwire_auth.attribution_gap_evidence
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_attribution_gap_append_only();

RESET search_path;
