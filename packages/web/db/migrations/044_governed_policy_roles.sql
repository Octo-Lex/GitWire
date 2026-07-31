-- Migration 044: governed_policy_roles
-- Governed Policy Authority roles and grants (issue #96, GP-01).
--
-- Creates the gitwire_policy_fn_owner role fail-closed (collision raises).
-- Establishes SELECT-only access for runtime roles. No functions, no
-- EXECUTE grants, no default privileges. Follows the 039 pattern.
--
-- GP-02 through GP-05 will add column-restricted INSERT grants or
-- SECURITY DEFINER functions with REVOKE ALL ... FROM PUBLIC as needed.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Role creation (fail-closed — follows 039 pattern)
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_policy_fn_owner') THEN
    RAISE EXCEPTION 'colliding role already exists: gitwire_policy_fn_owner';
  END IF;

  CREATE ROLE gitwire_policy_fn_owner
    NOLOGIN
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    NOBYPASSRLS;
END
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Schema usage grants
-- ════════════════════════════════════════════════════════════════════════════

GRANT USAGE ON SCHEMA gitwire_policy
  TO gitwire_app, gitwire_operator, gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- Table privileges — SELECT only for runtime roles
-- ════════════════════════════════════════════════════════════════════════════

-- gitwire_app: everyday workers/routes. SELECT only.
-- INSERT/UPDATE/DELETE deferred to GP-02+ (via column grants or functions).
GRANT SELECT ON ALL TABLES IN SCHEMA gitwire_policy TO gitwire_app;

-- gitwire_operator: read-only audit access.
GRANT SELECT ON ALL TABLES IN SCHEMA gitwire_policy TO gitwire_operator;

-- gitwire_policy_fn_owner: schema USAGE only. No table grants until
-- GP-02+ adds specific column grants for each privileged function.
-- (The role exists so future SECURITY DEFINER functions can be owned by it.)

-- PUBLIC: no privileges. Explicitly revoke function execution that
-- PostgreSQL grants by default.
REVOKE ALL ON FUNCTION gitwire_policy.enforce_append_only() FROM PUBLIC;

-- No default privileges configured.
-- Future tables/functions should receive explicit grants in their owning migration.

RESET search_path;
