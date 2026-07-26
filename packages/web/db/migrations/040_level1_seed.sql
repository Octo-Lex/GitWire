-- 040_level1_seed.sql
-- Level 1 authority core — canonical built-in roles, canonical permissions,
-- and initial bootstrap state only.
--
-- Boundary (per Wave 1 / issue #81):
--   * canonical built-in roles,
--   * canonical permissions attached to those roles,
--   * initial bootstrap state only.
--
-- 040 does NOT create an administrator principal, credential, or assignment.
-- The zero-administrator bootstrap model (Wave 1 binding architecture) creates
-- the administrator atomically via complete_bootstrap (039) at first run, not
-- via a migration. Fresh auth_bootstrap_state is seeded 'enabled' by 038.
--
-- No passwords or production credentials appear in this file or any migration.
-- The placeholder admin permission set is the authoritative source for the
-- application-layer evaluator; no raw secret is referenced here.
--
-- Idempotency: every INSERT uses ON CONFLICT DO NOTHING on a natural key, so a
-- direct re-execution of 040 (e.g. by the seed-proof fixture) is a no-op for
-- INSERT. Canonical drift is rejected explicitly by the verification block
-- below: a canonical row that already exists with DIFFERENT attributes is NOT
-- silently preserved — the verification raises. (ON CONFLICT DO NOTHING alone
-- would preserve a drifted row; the verification closes that gap.)

SET search_path = gitwire_auth, pg_catalog;

-- ── 1. Canonical built-in roles ────────────────────────────────────────────
-- Minimal, stable set. The 'admin' role is created here so complete_bootstrap
-- (039) can resolve it; the administrator principal/credential/assignment is
-- NOT created here.
INSERT INTO gitwire_auth.auth_roles (name, description, is_builtin, status)
VALUES
  ('admin', 'Full administrative access (fleet scope). Assigned to the bootstrap administrator.', true, 'active'),
  ('operator', 'Operational inspection and cutover transitions. No direct table UPDATE.', true, 'active'),
  ('legacy-key', 'Narrow bridge for existing shared-key clients during migration.', true, 'active')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Canonical permissions ───────────────────────────────────────────────
-- Attached to built-in roles. These are the authoritative permission tokens
-- the application-layer evaluator consults (level-1-core.md §5). The
-- legacy-key set is deliberately narrow: read/list/create/update/enqueue on
-- installation-scoped resources, no manage/approve/revoke/audit.
INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
SELECT r.id, t.perm
FROM gitwire_auth.auth_roles r
CROSS JOIN (
  VALUES
    -- admin: full operational set on repository/installation.
    ('admin', 'repository:read'),
    ('admin', 'repository:list'),
    ('admin', 'repository:update'),
    ('admin', 'repository:create'),
    ('admin', 'repository:github:act'),
    ('admin', 'installation:read'),
    ('admin', 'installation:list'),
    -- operator: read/list only — mutations go through transition_enforcement_state.
    ('operator', 'repository:read'),
    ('operator', 'repository:list'),
    ('operator', 'installation:read'),
    ('operator', 'installation:list'),
    -- legacy-key: narrow bridge (no manage/approve/revoke/audit).
    ('legacy-key', 'repository:read'),
    ('legacy-key', 'repository:list'),
    ('legacy-key', 'repository:create'),
    ('legacy-key', 'repository:update')
) AS t(role, perm)
WHERE r.name = t.role
  AND r.is_builtin
ON CONFLICT (role_id, permission) DO NOTHING;

-- ── 3. Initial bootstrap state ─────────────────────────────────────────────
-- Fresh state is 'enabled'. This is the only bootstrap seed; the recovery
-- marker table is created empty by 038. 040 asserts the enabled default so a
-- re-apply after rollback restores the initial bootstrap posture (an operator
-- who previously bootstrapped will have state='disabled' in their real data;
-- the rollback/reapply proof operates on a fresh disposable database where
-- 'enabled' is correct).
INSERT INTO gitwire_auth.auth_bootstrap_state (id, state, bootstrap_count)
VALUES (1, 'enabled', 0)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Initial enforcement state (defensive) ───────────────────────────────
-- 038 already seeds this row to 'observed'. Re-assert here so a direct
-- re-execution of 040 in the seed-proof fixture observes the canonical
-- default even if run in isolation against a schema that has the table but a
-- non-default row. ON CONFLICT DO NOTHING preserves any operator-driven
-- transition (we do not clobber a real cutover state).
INSERT INTO gitwire_auth.auth_enforcement_state (id, state)
VALUES (1, 'observed')
ON CONFLICT (id) DO NOTHING;

-- ── 5. Canonical drift verification (fail-closed) ──────────────────────────
-- A canonical row that already exists with DIFFERENT attributes is drift.
-- ON CONFLICT DO NOTHING above would silently preserve it; this block raises
-- instead, so a drifted canonical seed fails 040 on re-execution. Each
-- assertion compares the stored row to its canonical expected value.

DO $$
DECLARE
  v_drift text := '';
  v_n int;
BEGIN
  -- Role attribute drift: each canonical role must have exactly the expected
  -- description, is_builtin=true, status='active'.
  IF EXISTS (
    SELECT 1 FROM gitwire_auth.auth_roles
    WHERE name = 'admin'
      AND (description IS DISTINCT FROM 'Full administrative access (fleet scope). Assigned to the bootstrap administrator.'
           OR is_builtin IS DISTINCT FROM true
           OR status IS DISTINCT FROM 'active')
  ) THEN
    v_drift := v_drift || ' admin-role-attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gitwire_auth.auth_roles
    WHERE name = 'operator'
      AND (description IS DISTINCT FROM 'Operational inspection and cutover transitions. No direct table UPDATE.'
           OR is_builtin IS DISTINCT FROM true
           OR status IS DISTINCT FROM 'active')
  ) THEN
    v_drift := v_drift || ' operator-role-attributes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gitwire_auth.auth_roles
    WHERE name = 'legacy-key'
      AND (description IS DISTINCT FROM 'Narrow bridge for existing shared-key clients during migration.'
           OR is_builtin IS DISTINCT FROM true
           OR status IS DISTINCT FROM 'active')
  ) THEN
    v_drift := v_drift || ' legacy-key-role-attributes';
  END IF;

  -- Permission-set drift: the canonical permission set per role must match
  -- EXACTLY (no missing, no extra). Compare as sorted text aggregates.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT r.name,
             string_agg(arp.permission, ',' ORDER BY arp.permission) AS actual
      FROM gitwire_auth.auth_role_permissions arp
      JOIN gitwire_auth.auth_roles r ON r.id = arp.role_id
      WHERE r.name IN ('admin','operator','legacy-key') AND r.is_builtin
      GROUP BY r.name
    ) cur
    FULL JOIN (
      VALUES
        ('admin', 'installation:list,installation:read,repository:create,repository:github:act,repository:list,repository:read,repository:update'),
        ('operator', 'installation:list,installation:read,repository:list,repository:read'),
        ('legacy-key', 'repository:create,repository:list,repository:read,repository:update')
    ) AS exp(name, perms) ON cur.name = exp.name
    WHERE cur.actual IS DISTINCT FROM exp.perms
  ) THEN
    v_drift := v_drift || ' permission-set';
  END IF;

  -- Canonical built-in role count drift: exactly the 3 canonical roles exist
  -- as is_builtin (no extra built-in roles injected).
  SELECT count(*) INTO v_n FROM gitwire_auth.auth_roles WHERE is_builtin;
  IF v_n != 3 THEN
    v_drift := v_drift || ' builtin-role-count';
  END IF;

  IF v_drift != '' THEN
    RAISE EXCEPTION 'canonical seed drift detected:%', v_drift;
  END IF;
END $$;

RESET search_path;
