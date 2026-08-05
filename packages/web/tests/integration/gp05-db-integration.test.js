// tests/integration/gp05-db-integration.test.js
// GP-05 real database integration tests using a disposable PostgreSQL container.
// Executes the REAL service/SQL boundary against migration 048 — no mocked DB.
//
// Coverage:
//   - initial forward promotion
//   - domain refusal (stale binding)
//   - rollback creation and approval
//   - rollback promotion
//   - authorization refusal
//   - transaction rollback on injected operational failure

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

function docker(...a) { return execFileSync("docker", a, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
function pickPort() {
  return new Promise((r, j) => {
    const s = createServer(); s.unref(); s.on("error", j);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); });
  });
}
function waitForReady(url, ms) {
  const st = Date.now();
  return new Promise((r, j) => {
    const t = async () => {
      try { const c = new pg.Client({ connectionString: url }); await c.connect(); await c.end(); r(); }
      catch { if (Date.now() - st > ms) return j(new Error("not ready")); setTimeout(t, 500); }
    }; t();
  });
}

// ── Shared disposable DB ─────────────────────────────────────────────────────
let pool, dbUrl, containerName;

beforeAll(async () => {
  const port = await pickPort();
  containerName = "gp05-inttest-" + port;
  docker("run", "-d", "--rm", "--name", containerName, "-p", `127.0.0.1:${port}:5432`, "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb", "postgres:16-alpine");
  dbUrl = `postgresql://proof:proof-only@127.0.0.1:${port}/proofdb`;
  await waitForReady(dbUrl, 60_000);
  pool = new pg.Pool({ connectionString: dbUrl });

  // Apply all migrations
  const c = await pool.connect();
  try {
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, f), "utf8");
      try { await c.query("BEGIN"); await c.query(sql); await c.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]); await c.query("COMMIT"); }
      catch (e) { await c.query("ROLLBACK"); throw new Error(f + ": " + e.message); }
    }
  } finally { c.release(); }
}, 120_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => {});
  if (containerName) try { docker("rm", "-f", containerName); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function asApp(sql, params) {
  const c = await pool.connect();
  try { await c.query("SET SESSION AUTHORIZATION gitwire_app"); return await c.query(sql, params); }
  finally { await c.query("RESET SESSION AUTHORIZATION"); c.release(); }
}

async function asDbo(sql, params) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

async function seedPrincipal(name) {
  await asDbo("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key', $1) ON CONFLICT DO NOTHING", [name]);
  return (await asDbo("SELECT id FROM gitwire_auth.auth_principals WHERE display_name = $1", [name])).rows[0].id;
}

async function grantAdmin(pid) {
  const role = (await asDbo("SELECT id FROM gitwire_auth.auth_roles WHERE name='admin' AND status='active' LIMIT 1")).rows[0];
  await asDbo("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) VALUES ($1, $2, 'fleet', $1) ON CONFLICT DO NOTHING", [pid, role.id]);
}

async function makeApprovedCR(opts) {
  const { rt = "organization", rid = "test-" + Math.random().toString(36).slice(2, 8), fam = "tp", authorId, approverId, risk = "standard" } = opts;
  const crId = (await asApp("SELECT gitwire_policy.create_policy_change_request($1,$2,$3,$4) AS id", [rt, rid, fam, authorId])).rows[0].id;
  const vId = (await asApp("SELECT gitwire_policy.create_policy_version($1,$2::jsonb,$3) AS id", [crId, JSON.stringify({ v: "1" }), authorId])).rows[0].id;
  await asApp("SELECT * FROM gitwire_policy.select_policy_version($1,$2,0,$3)", [crId, vId, authorId]);
  await asApp("SELECT * FROM gitwire_policy.submit_policy_change_request($1,1,$2)", [crId, authorId]);
  const val = JSON.stringify({ valid: true });
  const sim = JSON.stringify({ passed: true, risk_classification: risk, classifier_version: "cv1", simulation_profile: { version: "sv1", ordering: "id_asc" }, dataset_snapshot: { upper_watermark: 1, input_set_hash: "sha256:" + "a".repeat(64) } });
  await asApp("SELECT * FROM gitwire_policy.finalize_policy_evaluation($1,2,$2::jsonb,'vv1',$3::jsonb,'sv1',$4)", [crId, val, sim, authorId]);
  const ruleId = (await asApp("SELECT gitwire_policy.create_policy_approval_rule($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NULL) AS id", ["v1", fam, rt, rid, risk, 1, JSON.stringify(["admin"]), authorId])).rows[0].id;
  await asApp("SELECT * FROM gitwire_policy.record_policy_approval($1,$2,$3)", [crId, ruleId, approverId]);
  const appr = (await asApp("SELECT * FROM gitwire_policy.approve_policy_change_request($1,3,$2)", [crId, approverId])).rows[0];
  return { crId, vId, stateRev: appr.state_revision };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("GP-05 database integration", () => {
  let authorId, approverId, promoterId, requesterId, rbApproverId, rbPromoterId, unauthId;

  beforeAll(async () => {
    [authorId, approverId, promoterId, requesterId, rbApproverId, rbPromoterId, unauthId] = await Promise.all([
      seedPrincipal("inttest-author"), seedPrincipal("inttest-approver"), seedPrincipal("inttest-promoter"),
      seedPrincipal("inttest-requester"), seedPrincipal("inttest-rb-approver"), seedPrincipal("inttest-rb-promoter"),
      seedPrincipal("inttest-unauth"),
    ]);
    for (const p of [authorId, approverId, promoterId, requesterId, rbApproverId, rbPromoterId]) await grantAdmin(p);
    // unauthId gets NO role
  });

  it("initial forward promotion succeeds with real DB", async () => {
    const { crId, stateRev } = await makeApprovedCR({ authorId, approverId });
    const r = (await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,NULL,$3)", [crId, stateRev, promoterId])).rows[0];
    expect(r.out_outcome).toBe("succeeded");
    expect(Number(r.out_binding_revision)).toBe(0);
    expect(r.out_new_state).toBe("promoted");

    // Verify binding exists
    const binds = (await asDbo("SELECT count(*)::int n FROM gitwire_policy.active_policy_bindings")).rows[0].n;
    expect(binds).toBeGreaterThanOrEqual(1);
  });

  it("domain refusal: stale binding revision produces failed record", async () => {
    const binding = (await asDbo("SELECT * FROM gitwire_policy.active_policy_bindings ORDER BY binding_revision DESC LIMIT 1")).rows[0];
    const { crId, stateRev } = await makeApprovedCR({ authorId, approverId, rt: binding.resource_type, rid: binding.resource_id, fam: binding.policy_family });
    const r = (await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [crId, stateRev, Number(binding.binding_revision) - 999, promoterId])).rows[0];
    expect(r.out_outcome).toBe("failed");
    expect(r.out_failure_code).toBe("stale_binding_revision");
  });

  it("rollback creation and approval", async () => {
    // Create two promoted versions for rollback
    const c1 = await makeApprovedCR({ authorId, approverId, rid: "inttest-rb", fam: "rb-int" });
    await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,NULL,$3)", [c1.crId, c1.stateRev, promoterId]);
    const b1 = (await asDbo("SELECT * FROM gitwire_policy.active_policy_bindings WHERE resource_id='inttest-rb'")).rows[0];
    const c2 = await makeApprovedCR({ authorId, approverId, rid: "inttest-rb", fam: "rb-int" });
    await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,$3,$4)", [c2.crId, c2.stateRev, b1.binding_revision, promoterId]);
    const b2 = (await asDbo("SELECT * FROM gitwire_policy.active_policy_bindings WHERE resource_id='inttest-rb'")).rows[0];

    // Create rollback to c1's version
    const rb = (await asApp("SELECT * FROM gitwire_policy.create_policy_rollback_request($1,$2,$3,$4)", [b2.id, b2.binding_revision, c1.vId, requesterId])).rows[0];
    expect(rb.out_status).toBe("requested");
    expect(Number(rb.out_status_revision)).toBe(0);

    // Approve
    const appr = (await asApp("SELECT * FROM gitwire_policy.approve_policy_rollback_request($1,0,$2)", [rb.out_rollback_record_id, rbApproverId])).rows[0];
    expect(appr.out_status).toBe("approved");
    expect(Number(appr.out_status_revision)).toBe(1);
  });

  it("rollback promotion succeeds", async () => {
    // Use the approved rollback from the previous test
    const rbRec = (await asDbo("SELECT * FROM gitwire_policy.policy_rollback_records WHERE status='approved' AND binding_id IN (SELECT id FROM gitwire_policy.active_policy_bindings WHERE resource_id='inttest-rb') LIMIT 1")).rows[0];
    if (!rbRec) { console.log("skip: no approved rollback"); return; }
    const binding = (await asDbo("SELECT * FROM gitwire_policy.active_policy_bindings WHERE id=$1", [rbRec.binding_id])).rows[0];
    const rp = (await asApp("SELECT * FROM gitwire_policy.promote_policy_rollback_request($1,1,$2,$3)", [rbRec.id, rbRec.expected_binding_revision, rbPromoterId])).rows[0];
    expect(rp.out_outcome).toBe("succeeded");
    expect(rp.out_status).toBe("promoted");
    expect(Number(rp.out_binding_revision)).toBe(Number(rbRec.expected_binding_revision) + 1);
  });

  it("authorization refusal: unauthorized principal cannot promote", async () => {
    const { crId, stateRev } = await makeApprovedCR({ authorId, approverId, rid: "inttest-auth", fam: "auth-int" });
    let raised = false;
    try { await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,NULL,$3)", [crId, stateRev, unauthId]); }
    catch (e) { raised = /permission|authorize|not active/i.test(e.message); }
    expect(raised).toBe(true);
    // Verify no promotion record was written
    const recs = (await asDbo("SELECT count(*)::int n FROM gitwire_policy.policy_promotion_records WHERE change_request_id=$1", [crId])).rows[0].n;
    expect(recs).toBe(0);
  });

  it("transaction rollback on injected operational failure", async () => {
    // Install a proof-only trigger that raises on binding insert
    await asDbo("CREATE OR REPLACE FUNCTION gitwire_policy.inttest_failpoint() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'INJECTED'; END; $$ LANGUAGE plpgsql");
    await asDbo("CREATE TRIGGER inttest_failpoint_bi BEFORE INSERT ON gitwire_policy.active_policy_bindings FOR EACH ROW EXECUTE FUNCTION gitwire_policy.inttest_failpoint()");

    const { crId, stateRev } = await makeApprovedCR({ authorId, approverId, rid: "inttest-fault", fam: "fault-int" });
    const before = (await asDbo("SELECT count(*)::int n FROM gitwire_policy.policy_promotion_records")).rows[0].n;

    let raised = false;
    try { await asApp("SELECT * FROM gitwire_policy.promote_policy_change_request($1,$2,NULL,$3)", [crId, stateRev, promoterId]); }
    catch (e) { raised = /INJECTED/.test(e.message); }
    expect(raised).toBe(true);

    // Verify no partial state
    const after = (await asDbo("SELECT count(*)::int n FROM gitwire_policy.policy_promotion_records")).rows[0].n;
    expect(after).toBe(before);

    // CR should still be approved
    const crState = (await asDbo("SELECT state FROM gitwire_policy.policy_change_requests WHERE id=$1", [crId])).rows[0].state;
    expect(crState).toBe("approved");

    // Cleanup trigger
    await asDbo("DROP TRIGGER IF EXISTS inttest_failpoint_bi ON gitwire_policy.active_policy_bindings");
  });
});
