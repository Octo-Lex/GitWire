-- 041_wave2_runtime_identity.sql
-- Wave 2 runtime identity and scoped authorization — additive schema.
--
-- Boundary (per issue #94):
--   * legacy-key compatibility mapping (maps accepted shared keys to principals);
--   * observe-only authorization decision log;
--   * principal-attribution columns added ALONGSIDE existing legacy actor
--     columns (dual-write — no legacy column removed).
--
-- All objects are additive. No existing table is modified destructively; new
-- columns are nullable so existing rows remain valid. Fail-closed: plain
-- CREATE for new tables (no IF NOT EXISTS) — a pre-existing Wave 2 object
-- aborts rather than being silently adopted. ALTER TABLE ... ADD COLUMN
-- uses IF NOT EXISTS only because adding a column is idempotent and the
-- column is nullable (no data migration, no collision risk).
--
-- Atomicity: scripts/migrate.js wraps each file in BEGIN/COMMIT.

SET search_path = gitwire_auth, pg_catalog;

-- ── 1. legacy_key_mappings ─────────────────────────────────────────────────
-- Maps each accepted shared API key (by its lookup_id fingerprint) to an
-- explicit `legacy-key` principal + credential created by Wave 1's tables.
-- The compatibility adapter consults this table; an unmapped key is rejected
-- with `unmapped_legacy_key` (no implicit fleet-wide authority).
--
-- key_fingerprint: a DERIVED hash (HMAC-SHA256, salted by pepper_version) of
--   the raw shared key. The raw key never enters SQL, this table, logs, or
--   proof evidence. Lookup is by fingerprint equality.
-- principal_id:    the legacy-key principal this key resolves to.
-- credential_id:   the credential record (also derived-hash-only).
-- display_label:   human-readable hint for operators (no secret material).
CREATE TABLE gitwire_auth.legacy_key_mappings (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_fingerprint  text        NOT NULL UNIQUE,
  pepper_version   integer     NOT NULL,
  principal_id     uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  credential_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_credentials(id),
  display_label    text        NOT NULL,
  mapped_at        timestamptz NOT NULL DEFAULT now(),
  retired_at       timestamptz
);

CREATE INDEX ix_legacy_key_mappings_principal
  ON gitwire_auth.legacy_key_mappings (principal_id)
  WHERE retired_at IS NULL;

-- ── 2. auth_decision_log (observe-only evidence) ───────────────────────────
-- Append-only record of every authorization decision computed by the central
-- authorize() service. Used in observe-only mode to compare authoritative
-- decisions against legacy behavior and to surface disagreements. Append-only
-- is enforced by trigger (below) — no UPDATE/DELETE.
--
-- NOTE: this is the OBSERVE-ONLY decision log, distinct from the Wave 4 audit
-- ledger. It records decisions, not command execution.
CREATE TABLE gitwire_auth.auth_decision_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  principal_id      uuid,
  permission        text        NOT NULL,
  resource_type     text        NOT NULL,
  resource_installation_id bigint,
  resource_repository_id   bigint,
  resource_organization     text,
  resource_repository       text,
  allowed           boolean     NOT NULL,
  code              text        NOT NULL,
  matched_assignment_id uuid,
  matched_scope_type text,
  policy_version    text,
  authentication_method text,
  observe_mode      boolean     NOT NULL DEFAULT true,
  legacy_expected   boolean,
  disagreement      boolean,
  detail            jsonb
);

CREATE INDEX ix_auth_decision_log_principal
  ON gitwire_auth.auth_decision_log (principal_id, decided_at DESC);
CREATE INDEX ix_auth_decision_log_resource
  ON gitwire_auth.auth_decision_log (resource_type, resource_repository_id, decided_at DESC)
  WHERE resource_repository_id IS NOT NULL;
CREATE INDEX ix_auth_decision_log_disagreement
  ON gitwire_auth.auth_decision_log (decided_at DESC)
  WHERE disagreement = true;

-- ── 3. Append-only enforcement for auth_decision_log ───────────────────────
CREATE FUNCTION gitwire_auth.enforce_decision_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'auth_decision_log is append-only';
END;
$$;

CREATE TRIGGER trg_decision_log_no_update
  BEFORE UPDATE ON gitwire_auth.auth_decision_log
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_decision_log_append_only();
CREATE TRIGGER trg_decision_log_no_delete
  BEFORE DELETE ON gitwire_auth.auth_decision_log
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_decision_log_append_only();

-- ── 4. Dual-write principal attribution (additive columns) ─────────────────
-- Add a nullable `principal_id` column to existing tables that carry a legacy
-- `actor` / `created_by` TEXT column. New records populate principal_id
-- (server-derived); the legacy column remains as compatibility metadata.
-- Nullable so existing rows (principal unknown at migration time) remain valid.
--
-- These ALTERs are idempotent (IF NOT EXISTS) and non-destructive. The target
-- tables live in the `public` schema (created by earlier migrations), so they
-- are schema-qualified explicitly — the file's search_path is fixed to
-- (gitwire_auth, pg_catalog) for the Wave 2 security objects above, which
-- excludes public by design. Only tables confirmed to exist with a legacy
-- actor/created_by column are targeted.

-- public.decision_log.actor (TEXT) -> + principal_id
ALTER TABLE public.decision_log ADD COLUMN IF NOT EXISTS principal_id uuid;

-- public.repair_proposals.created_by (TEXT) -> + principal_id
ALTER TABLE public.repair_proposals ADD COLUMN IF NOT EXISTS principal_id uuid;

-- public.repair_proposal_events.actor (TEXT) -> + principal_id
ALTER TABLE public.repair_proposal_events ADD COLUMN IF NOT EXISTS principal_id uuid;

-- public.managed_actions: created_by-style column -> + principal_id
ALTER TABLE public.managed_actions ADD COLUMN IF NOT EXISTS principal_id uuid;

-- public.decision_log: index principal_id for principal-scoped queries
CREATE INDEX IF NOT EXISTS ix_decision_log_principal
  ON public.decision_log (principal_id)
  WHERE principal_id IS NOT NULL;

RESET search_path;
