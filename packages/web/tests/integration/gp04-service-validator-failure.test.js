// tests/integration/gp04-service-validator-failure.test.js
// GP-04 validator operational-exception safety.
//
// Proves that when validateConfig() throws an operational exception (as opposed
// to returning { valid: false }), the service evaluateChangeRequest() never
// reaches the SQL finalizer, and all persistent state is unchanged.
//
// Per Commit 3 authorization:
//   * mock only the validation engine export needed by the service
//     (validateConfig from @gitwire/rules);
//   * make validateConfig() throw a stable sentinel error;
//   * inject the same native, non-superuser gitwire_app database wrapper used
//     by Commit 1 (jest.unstable_mockModule of ../../src/lib/db.js);
//   * create a real submitted change request;
//   * call the real evaluateChangeRequest() service;
//   * assert the sentinel error propagates;
//   * assert exact pre/post equality for request state, state revision,
//     validation-evidence count, simulation-evidence count, GP-04 event count.
//
// This test proves the service never reaches the SQL finalizer after an
// operational validator exception. The real validator path (valid:true and
// valid:false) is already exercised by Commit 1's gp04-service-e2e.test.js.

import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "web", "db", "migrations");

const SENTINEL = "gp04-sentinel-validator-crash";

function docker(...a) { return execFileSync("docker", a, { encoding: "utf8" }).trim(); }
function pickPort() {
  return new Promise((r, j) => {
    const s = createServer();
    s.unref(); s.on("error", j);
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

const VALID_PAYLOAD = { version: 1, pillars: { triage: { enabled: true } }, settings: { dry_run: true } };

let bootstrapPool = null;
let runtimePool = null;
let evaluateChangeRequest = null;
let pgCid = null;

describe("GP-04 validator operational-exception safety", () => {
  beforeAll(async () => {
    const pgPort = await pickPort();
    const pgName = "gp04-vfail-" + pgPort;
    pgCid = docker("run", "-d", "--rm", "--name", pgName,
      "-p", "127.0.0.1:" + pgPort + ":5432",
      "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb",
      "postgres:16-alpine");
    const bootstrapUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(bootstrapUrl, 60_000);
    bootstrapPool = new pg.Pool({ connectionString: bootstrapUrl });
    await applyMigrations(bootstrapPool);
    await bootstrapPool.query("ALTER ROLE gitwire_app WITH PASSWORD 'gp04-vfail-rt'");

    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-vfail-admin') ON CONFLICT DO NOTHING");
    const adminPid = (await bootstrapPool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-vfail-admin'")).rows[0].id;
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [adminPid]);
    await bootstrapPool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp04-vfail', 'Organization') ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp04-vfail/test', 'gp04-vfail', 'test', false, 'main', 'typescript', 0, 0, 0) ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO decision_log (repo_id, source, trigger_event, target_type, target_number, decision, reason) VALUES (99002, 'ci_heal', 'workflow_completed', 'pr', 1, 'acted', 'seed')");

    const runtimeUrl = "postgresql://gitwire_app:gp04-vfail-rt@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(runtimeUrl, 30_000);
    runtimePool = new pg.Pool({ connectionString: runtimeUrl });

    // Mock ONLY the validation engine export. validateConfig throws the sentinel.
    jest.unstable_mockModule("@gitwire/rules", () => ({
      validateConfig: jest.fn(() => { throw new Error(SENTINEL); }),
    }));
    // Inject the native non-superuser gitwire_app db wrapper.
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

    globalThis.__gp04VfailAdminPid = adminPid;
  }, 120_000);

  afterAll(async () => {
    try { if (runtimePool) await runtimePool.end(); } catch {}
    try { if (bootstrapPool) await bootstrapPool.end(); } catch {}
    try { if (pgCid) docker("rm", "-f", pgCid); } catch {}
  }, 60_000);

  it("validateConfig throwing → sentinel propagates, zero persistent effects", async () => {
    const authorPid = globalThis.__gp04VfailAdminPid;

    // Create a real submitted CR via the runtime pool (gitwire_app).
    const cr = await runtimePool.query({
      text: "SELECT gitwire_policy.create_policy_change_request('repository','gp04-vfail/test','test-config',$1) as id",
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
    const stateRevision = Number(fresh.rows[0].state_revision);

    // Snapshot all five persistent invariants BEFORE.
    const before = {
      state: (await bootstrapPool.query({ text: "SELECT state FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state,
      revision: Number((await bootstrapPool.query({ text: "SELECT state_revision FROM gitwire_policy.policy_change_requests WHERE id = $1", values: [crId] })).rows[0].state_revision),
      valCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_validation_evidence")).rows[0].n,
      simCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_simulation_evidence")).rows[0].n,
      evtCount: (await bootstrapPool.query("SELECT count(*)::int n FROM gitwire_policy.policy_transition_events WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected')")).rows[0].n,
    };

    // Call the real service. validateConfig throws the sentinel.
    let thrown = null;
    try {
      await evaluateChangeRequest({ changeRequestId: crId, expectedStateRevision: stateRevision, principalId: authorPid });
    } catch (e) {
      thrown = e;
    }

    // The sentinel error must propagate.
    expect(thrown).not.toBeNull();
    expect(thrown.message).toBe(SENTINEL);

    // All five persistent invariants must be byte-identical.
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
}, 180_000);
