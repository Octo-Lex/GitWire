// tests/integration/gp04-service-e2e.test.js
// GP-04 F6 obligation #1: exercise evaluateChangeRequest() through the REAL
// service layer against a disposable PostgreSQL database with a genuine
// non-superuser ACL boundary.
//
// Two-identity setup (per review correction):
//   * bootstrap pool connected as the container admin (proof) — applies
//     migrations and seeds fixtures;
//   * runtime pool connected natively as the migration-created LOGIN role
//     gitwire_app (password set via ALTER ROLE) — injected as the service's
//     db via jest.unstable_mockModule of ../../src/lib/db.js.
//
// This is test-only dependency substitution. No production-code DI seam,
// setter, env hook, or DB bypass is introduced. The service code runs
// unmodified; session_user = 'gitwire_app' holds natively; the SECURITY
// DEFINER, CAS, ACL, and session_user checks inside finalize_policy_evaluation
// all fire for real.
//
// Per review note #1: evaluateChangeRequest() does not receive req and does
// not call observeAuthorize. This service test calls it directly with a
// principalId and seeds only the actor-eligibility state the SQL function
// requires. req.auth, the three GP-04 permissions, and observer assertions
// belong in gp04-routes-e2e.test.js.

import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
// From packages/web/tests/integration/ → repo root is 4 levels up.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

// ── disposable-DB helpers (mirror run_gp04_validation_simulation_proof.mjs) ──
function docker(...a) { return execFileSync("docker", a, { encoding: "utf8" }).trim(); }
function pickPort() {
  return new Promise((r, j) => {
    const s = createServer();
    s.unref();
    s.on("error", j);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
  });
}
function waitForReady(url, ms) {
  const st = Date.now();
  return new Promise((r, j) => {
    const t = async () => {
      try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.end(); r(); }
      catch { if (Date.now() - st > ms) return j(new Error("not ready")); setTimeout(t, 500); }
    };
    t();
  });
}
async function applyMigrations(client) {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map(r => r.version));
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(file + ": " + err.message);
    }
  }
}

// ── module-under-test state (populated in beforeAll) ──
let bootstrapPool = null;   // superuser (proof)
let runtimePool = null;     // non-superuser (gitwire_app)
let evaluateChangeRequest = null;
let pgCid = null;
let pgName = null;

// Shared fixtures
const VALID_PAYLOAD = { version: 1, pillars: { triage: { enabled: true } }, settings: { dry_run: true } };
const INVALID_PAYLOAD = { version: 1, pillars: { triage: { enabled: "not_a_boolean" } }, settings: { dry_run: true } };

// Helper: drive a change request to the submitted state. All SECURITY DEFINER
// lifecycle calls (create_policy_change_request, create_policy_version,
// select_policy_version, submit_policy_change_request) enforce
// session_user = 'gitwire_app', so they MUST run via the runtime pool
// (native gitwire_app), not the bootstrap (proof) pool. The bootstrap pool is
// reserved for superuser-only fixture seeding and postcondition inspection.
async function createSubmittedCR(authorPid) {
  const cr = await runtimePool.query({
    text: "SELECT gitwire_policy.create_policy_change_request('repository','gp04-svc/test','test-config',$1) as id",
    values: [authorPid],
  });
  const crId = cr.rows[0].id;
  const v = await runtimePool.query({
    text: "SELECT gitwire_policy.create_policy_version($1, $2, $3) as id",
    values: [crId, JSON.stringify(VALID_PAYLOAD), authorPid],
  });
  const vId = v.rows[0].id;
  await runtimePool.query({
    text: "SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)",
    values: [crId, vId, authorPid],
  });
  const sel = await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] });
  await runtimePool.query({
    text: "SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)",
    values: [crId, Number(sel.rows[0].state_revision), authorPid],
  });
  const fresh = await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] });
  return { crId, vId, stateRevision: Number(fresh.rows[0].state_revision) };
}

// Same as above but lets the caller choose the payload (for the invalid case).
async function createSubmittedCRWithPayload(authorPid, payload) {
  const cr = await runtimePool.query({
    text: "SELECT gitwire_policy.create_policy_change_request('repository','gp04-svc/test','test-config',$1) as id",
    values: [authorPid],
  });
  const crId = cr.rows[0].id;
  const v = await runtimePool.query({
    text: "SELECT gitwire_policy.create_policy_version($1, $2, $3) as id",
    values: [crId, JSON.stringify(payload), authorPid],
  });
  const vId = v.rows[0].id;
  await runtimePool.query({
    text: "SELECT * FROM gitwire_policy.select_policy_version($1, $2, 0, $3)",
    values: [crId, vId, authorPid],
  });
  const sel = await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] });
  await runtimePool.query({
    text: "SELECT * FROM gitwire_policy.submit_policy_change_request($1, $2, $3)",
    values: [crId, Number(sel.rows[0].state_revision), authorPid],
  });
  const fresh = await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] });
  return { crId, vId, stateRevision: Number(fresh.rows[0].state_revision) };
}

describe("GP-04 service end-to-end (real evaluateChangeRequest, non-superuser gitwire_app)", () => {
  beforeAll(async () => {
    const pgPort = await pickPort();
    pgName = "gp04-svc-" + pgPort;
    pgCid = docker("run", "-d", "--rm", "--name", pgName,
      "-p", "127.0.0.1:" + pgPort + ":5432",
      "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb",
      "postgres:16-alpine");
    const bootstrapUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(bootstrapUrl, 60_000);

    bootstrapPool = new pg.Pool({ connectionString: bootstrapUrl });
    await applyMigrations(bootstrapPool);

    // Set a password on the migration-created gitwire_app LOGIN role so we can
    // connect natively as it (non-superuser).
    await bootstrapPool.query("ALTER ROLE gitwire_app WITH PASSWORD 'gp04-runtime'");

    // Seed fixtures as the bootstrap admin.
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-svc-admin') ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-svc-author') ON CONFLICT DO NOTHING");
    const adminPid = (await bootstrapPool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-svc-admin'")).rows[0].id;
    const authorPid = (await bootstrapPool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-svc-author'")).rows[0].id;
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [adminPid]);
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [authorPid]);
    await bootstrapPool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp04-svc', 'Organization') ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp04-svc/test', 'gp04-svc', 'test', false, 'main', 'typescript', 0, 0, 0) ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO decision_log (repo_id, source, trigger_event, target_type, target_number, decision, reason) VALUES (99002, 'ci_heal', 'workflow_completed', 'pr', 1, 'acted', 'seed')");

    // Native non-superuser pool — this is the runtime identity the service will use.
    const runtimeUrl = "postgresql://gitwire_app:gp04-runtime@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(runtimeUrl, 30_000);
    runtimePool = new pg.Pool({ connectionString: runtimeUrl });

    // Confirm native session_user is exactly gitwire_app (not a superuser).
    // Note: pg lowercases unquoted aliases, so quote to preserve camelCase.
    const { rows: [{ me, isSuper }] } = await runtimePool.query('SELECT current_user AS me, rolsuper AS "isSuper" FROM pg_roles WHERE rolname = current_user');
    expect(me).toBe("gitwire_app");
    expect(isSuper).toBe(false);

    // Inject ONLY the db transport — the service code runs unmodified.
    jest.unstable_mockModule("../../src/lib/db.js", () => ({
      db: {
        query: (text, params) => runtimePool.query(text, params),
        transaction: async (fn) => {
          const c = await runtimePool.connect();
          try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
          catch (e) { await c.query("ROLLBACK"); throw e; }
          finally { c.release(); }
        },
        end: () => runtimePool.end(),
        pool: runtimePool,
      },
    }));
    jest.unstable_mockModule("../../src/lib/logger.js", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    }));

    const svc = await import("../../src/services/governedPolicyService.js");
    evaluateChangeRequest = svc.evaluateChangeRequest;

    // expose for helpers
    globalThis.__gp04AdminPid = adminPid;
    globalThis.__gp04AuthorPid = authorPid;
  }, 120_000);

  afterAll(async () => {
    try { if (runtimePool) await runtimePool.end(); } catch {}
    try { if (bootstrapPool) await bootstrapPool.end(); } catch {}
    try { if (pgCid) docker("rm", "-f", pgCid); } catch {}
  }, 60_000);

  // ── Happy path ──────────────────────────────────────────────────────────
  it("happy path: evaluateChangeRequest → awaiting_approval, both evidence rows present", async () => {
    const authorPid = globalThis.__gp04AuthorPid;
    const { crId, vId, stateRevision } = await createSubmittedCR(authorPid);

    const result = await evaluateChangeRequest({ changeRequestId: crId, expectedStateRevision: stateRevision, principalId: authorPid });

    expect(result.state).toBe("awaiting_approval");
    expect(result.stateRevision).toBe(stateRevision + 1);
    expect(result.validationEvidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.simulationEvidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const val = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", values: [vId] });
    expect(val.rows[0].n).toBe(1);
    const sim = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", values: [vId] });
    expect(sim.rows[0].n).toBe(1);
  });

  // ── Computed-policy rejection (invalid payload) ─────────────────────────
  it("computed rejection: invalid payload → rejected, validation evidence only, no simulation evidence", async () => {
    const authorPid = globalThis.__gp04AuthorPid;
    const { crId, vId, stateRevision } = await createSubmittedCRWithPayload(authorPid, INVALID_PAYLOAD);

    const result = await evaluateChangeRequest({ changeRequestId: crId, expectedStateRevision: stateRevision, principalId: authorPid });

    expect(result.state).toBe("rejected");
    expect(result.simulationEvidenceHash).toBeNull();
    expect(result.validationEvidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const val = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence WHERE version_id = $1", values: [vId] });
    expect(val.rows[0].n).toBe(1);
    const sim = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence WHERE version_id = $1", values: [vId] });
    expect(sim.rows[0].n).toBe(0);
    const evt = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE change_request_id = $1 AND to_state = 'rejected'", values: [crId] });
    expect(evt.rows[0].n).toBe(1);
  });

  // ── Operational failure invariants ───────────────────────────────────────
  // Inject a fault by temporarily revoking the simulator's required SELECT on
  // decision_log so simulatePolicyObject() throws a privilege error AFTER the
  // service has loaded the CR/version (validation passes) but BEFORE the
  // SQL finalizer is invoked. Proves all four persistent invariants hold and
  // the thrown error is the expected privilege error.
  it("operational failure: simulator privilege error leaves CR submitted, revision unchanged, zero evidence, zero GP-04 events", async () => {
    const authorPid = globalThis.__gp04AuthorPid;
    const { crId, stateRevision } = await createSubmittedCR(authorPid);

    // Snapshot the four persistent invariants BEFORE the faulted call.
    const before = {
      state: (await bootstrapPool.query({ text: "SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state,
      revision: Number((await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state_revision),
      valCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };
    expect(before.state).toBe("submitted");

    let thrown = null;
    try {
      // Fault: revoke the simulator's decision_log read (bootstrap = superuser).
      await bootstrapPool.query("REVOKE SELECT (id, source, trigger_event, target_type, target_number, pillar, decision, reason, repo_id) ON public.decision_log FROM gitwire_app");

      await evaluateChangeRequest({ changeRequestId: crId, expectedStateRevision: stateRevision, principalId: authorPid });
    } catch (e) {
      thrown = e;
    } finally {
      // Restore the grant unconditionally.
      await bootstrapPool.query("GRANT SELECT (id, source, trigger_event, target_type, target_number, pillar, decision, reason, repo_id) ON public.decision_log TO gitwire_app");
    }

    // The call must have thrown a privilege error (not a silent success, not an unrelated setup failure).
    expect(thrown).not.toBeNull();
    expect(thrown.message.toLowerCase()).toContain("permission denied");

    // All four persistent invariants must be byte-identical to the BEFORE snapshot.
    const after = {
      state: (await bootstrapPool.query({ text: "SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state,
      revision: Number((await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state_revision),
      valCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };
    expect(after.state).toBe(before.state);
    expect(after.revision).toBe(before.revision);
    expect(after.valCount).toBe(before.valCount);
    expect(after.simCount).toBe(before.simCount);
    expect(after.evtCount).toBe(before.evtCount);
  });

  // ── Grant matrix proof (correction #7) ───────────────────────────────────
  describe("least-privilege grant matrix (gitwire_app, non-superuser)", () => {
    it("public.repositories: no table-level SELECT, exact column SELECT set, no writes", async () => {
      // No table-level SELECT for gitwire_app
      const tbl = await bootstrapPool.query("SELECT has_table_privilege('gitwire_app','public.repositories','SELECT') as ok");
      expect(tbl.rows[0].ok).toBe(false);

      const grantedCols = ["github_id", "full_name", "owner"];
      for (const col of grantedCols) {
        const r = await bootstrapPool.query({ text: "SELECT has_column_privilege('gitwire_app','public.repositories',$1,'SELECT') as ok", values: [col] });
        expect(r.rows[0].ok).toBe(true);
      }
      // Negative column: confirm ungranted, including any inherited/PUBLIC rights
      const negCols = ["language", "stars", "default_branch"];
      for (const col of negCols) {
        const r = await bootstrapPool.query({ text: "SELECT has_column_privilege('gitwire_app','public.repositories',$1,'SELECT') as ok", values: [col] });
        expect(r.rows[0].ok).toBe(false);
      }
      // No INSERT/UPDATE/DELETE at table or column level
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const r = await bootstrapPool.query({ text: "SELECT has_table_privilege('gitwire_app','public.repositories',$1) as ok", values: [priv] });
        expect(r.rows[0].ok).toBe(false);
      }
      // A query over every granted column succeeds as gitwire_app
      await runtimePool.query("SELECT github_id, full_name, owner FROM public.repositories LIMIT 1");
      // A query over an ungranted column fails as gitwire_app
      let denied = false;
      try { await runtimePool.query("SELECT language FROM public.repositories LIMIT 1"); }
      catch (e) { denied = /permission denied|no such column/i.test(e.message) || e.message.toLowerCase().includes("permission"); }
      expect(denied).toBe(true);
    });

    it("public.decision_log: no table-level SELECT, exact column SELECT set, no writes", async () => {
      const tbl = await bootstrapPool.query("SELECT has_table_privilege('gitwire_app','public.decision_log','SELECT') as ok");
      expect(tbl.rows[0].ok).toBe(false);

      const grantedCols = ["id", "source", "trigger_event", "target_type", "target_number", "pillar", "decision", "reason", "repo_id"];
      for (const col of grantedCols) {
        const r = await bootstrapPool.query({ text: "SELECT has_column_privilege('gitwire_app','public.decision_log',$1,'SELECT') as ok", values: [col] });
        expect(r.rows[0].ok).toBe(true);
      }
      // Negative columns (created_at and pillar are common; pick ones not in the granted set)
      const negCols = ["created_at"];
      for (const col of negCols) {
        // Some columns may not exist on decision_log; only assert unreadable where the column exists.
        const exists = await bootstrapPool.query({ text: "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='decision_log' AND column_name=$1", values: [col] });
        if (exists.rows[0].n === 1) {
          const r = await bootstrapPool.query({ text: "SELECT has_column_privilege('gitwire_app','public.decision_log',$1,'SELECT') as ok", values: [col] });
          expect(r.rows[0].ok).toBe(false);
        }
      }
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const r = await bootstrapPool.query({ text: "SELECT has_table_privilege('gitwire_app','public.decision_log',$1) as ok", values: [priv] });
        expect(r.rows[0].ok).toBe(false);
      }
      // A query over every granted column succeeds
      await runtimePool.query("SELECT id, source, trigger_event, target_type, target_number, pillar, decision, reason, repo_id FROM public.decision_log LIMIT 1");
    });
  });
}, 180_000);
