// tests/integration/gp04-routes-e2e.test.js
// GP-04 F6 obligation #2 (HTTP 200/400/409/422) and #3 (exact-key body
// whitelist), plus full req.auth context and the REAL observeAuthorize path.
//
// Two-identity disposable DB; only ../../src/lib/db.js (db transport) and
// ../../src/lib/logger.js are mocked. governedPolicyService and
// observeAdopt run for real — observe-only, non-blocking, real decision log.
// req.auth is seeded via a minimal test middleware that mirrors how the
// production authContext middleware populates req.auth.principalId +
// authenticationMethod.

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
const INVALID_PAYLOAD = { version: 1, pillars: { triage: { enabled: "not_a_boolean" } }, settings: { dry_run: true } };

let bootstrapPool = null;
let runtimePool = null;
let governedPolicyRouter = null;
let expressMod = null;
let httpMod = null;
let pgCid = null;

async function createSubmittedCR(authorPid, payload = VALID_PAYLOAD) {
  // Use runtimePool (gitwire_app) for the lifecycle calls to keep the ACL
  // boundary honest end-to-end.
  const cr = await runtimePool.query({
    text: "SELECT gitwire_policy.create_policy_change_request('repository','gp04-rt/test','test-config',$1) as id",
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

async function withServer(principalId, fn) {
  const app = expressMod.default();
  app.use(expressMod.default.json());
  // Minimal test middleware mirroring authContext.js: populates req.auth.
  app.use((req, _res, next) => {
    req.auth = { principalId, authenticationMethod: "api_key" };
    next();
  });
  app.use("/api/policy", governedPolicyRouter);
  const server = httpMod.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  try { return await fn("http://127.0.0.1:" + port); }
  finally { await new Promise(r => server.close(r)); }
}

describe("GP-04 routes end-to-end (real observer, real service, non-superuser gitwire_app)", () => {
  beforeAll(async () => {
    const pgPort = await pickPort();
    const pgName = "gp04-rt-" + pgPort;
    pgCid = docker("run", "-d", "--rm", "--name", pgName,
      "-p", "127.0.0.1:" + pgPort + ":5432",
      "-e", "POSTGRES_USER=proof", "-e", "POSTGRES_PASSWORD=proof-only", "-e", "POSTGRES_DB=proofdb",
      "postgres:16-alpine");
    const bootstrapUrl = "postgresql://proof:proof-only@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(bootstrapUrl, 60_000);
    bootstrapPool = new pg.Pool({ connectionString: bootstrapUrl });
    await applyMigrations(bootstrapPool);
    await bootstrapPool.query("ALTER ROLE gitwire_app WITH PASSWORD 'gp04-runtime'");

    // Seed principal + the three GP-04 permissions the real observer evaluates.
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principals (principal_type, display_name) VALUES ('legacy-key','gp04-rt-admin') ON CONFLICT DO NOTHING");
    const adminPid = (await bootstrapPool.query("SELECT id FROM gitwire_auth.auth_principals WHERE display_name='gp04-rt-admin'")).rows[0].id;
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_principal_roles (principal_id, role_id, scope_type, granted_by) SELECT $1, r.id, 'fleet', $1 FROM gitwire_auth.auth_roles r WHERE r.name='admin' ON CONFLICT DO NOTHING", [adminPid]);
    await bootstrapPool.query("INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) SELECT id, p FROM gitwire_auth.auth_roles, (VALUES ('policy_change_request:evaluate'),('policy_validation_evidence:read'),('policy_simulation_evidence:read'),('policy_change_request:create'),('policy_change_request:update')) AS t(p) WHERE name='admin' ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO installations (github_id, account_login, account_type) VALUES (99001, 'gp04-rt', 'Organization') ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO repositories (github_id, installation_id, full_name, owner, name, private, default_branch, language, stars, open_issues, open_prs) VALUES (99002, 99001, 'gp04-rt/test', 'gp04-rt', 'test', false, 'main', 'typescript', 0, 0, 0) ON CONFLICT DO NOTHING");
    await bootstrapPool.query("INSERT INTO decision_log (repo_id, source, trigger_event, target_type, target_number, decision, reason) VALUES (99002, 'ci_heal', 'workflow_completed', 'pr', 1, 'acted', 'seed')");

    const runtimeUrl = "postgresql://gitwire_app:gp04-runtime@127.0.0.1:" + pgPort + "/proofdb";
    await waitForReady(runtimeUrl, 30_000);
    runtimePool = new pg.Pool({ connectionString: runtimeUrl });

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

    expressMod = await import("express");
    httpMod = await import("node:http");
    governedPolicyRouter = (await import("../../src/routes/governedPolicy.js")).governedPolicyRouter;

    globalThis.__gp04RtAdminPid = adminPid;
  }, 120_000);

  afterAll(async () => {
    try { if (runtimePool) await runtimePool.end(); } catch {}
    try { if (bootstrapPool) await bootstrapPool.end(); } catch {}
    try { if (pgCid) docker("rm", "-f", pgCid); } catch {}
  }, 60_000);

  // ── 200 happy path ──────────────────────────────────────────────────────
  it("POST /evaluate → 200 { state: awaiting_approval } on valid payload", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid);
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: stateRevision }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.state).toBe("awaiting_approval");
      expect(body.validationEvidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  // ── 400 missing key ─────────────────────────────────────────────────────
  it("POST /evaluate → 400 when expectedStateRevision missing", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId } = await createSubmittedCR(adminPid);
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── 400 extra/unknown keys (conventional + __proto__ raw) ───────────────
  it("POST /evaluate → 400 on conventional unknown own key (results)", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid);
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: stateRevision, results: { foo: 1 } }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("POST /evaluate → 400 on prohibited GP-04 fields (hashes, actor, principalId, versionId, simulationProfile, limit)", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    for (const extraKey of ["hashes", "actor", "principalId", "versionId", "simulationProfile", "limit"]) {
      const { crId, stateRevision } = await createSubmittedCR(adminPid);
      await withServer(adminPid, async (base) => {
        const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedStateRevision: stateRevision, [extraKey]: "x" }),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  it("POST /evaluate → 400 on raw __proto__ JSON injection (prototype pollution attempt)", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid);
    await withServer(adminPid, async (base) => {
      // Raw JSON: __proto__ as a literal key so the parser can't special-case it away.
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"expectedStateRevision":' + stateRevision + ',"__proto__":{"polluted":true}}',
      });
      expect(res.status).toBe(400);
    });
  });

  // ── 400 wrong type / shape ───────────────────────────────────────────────
  it("POST /evaluate → 400 on null, array, boolean, string body", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid);
    const cases = [
      { label: "null", raw: "null" },
      { label: "array", raw: "[1,2]" },
      { label: "boolean", raw: "true" },
      { label: "string", raw: '"hello"' },
    ];
    for (const c of cases) {
      await withServer(adminPid, async (base) => {
        const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: c.raw,
        });
        expect(res.status).toBe(400);
      });
    }
  });

  it("POST /evaluate → 400 on string revision (no coercion), negative, float, unsafe integer", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid);
    const badRevs = [
      { label: "string", val: String(stateRevision) },
      { label: "negative", val: -1 },
      { label: "float", val: 1.5 },
      { label: "unsafe", val: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const c of badRevs) {
      await withServer(adminPid, async (base) => {
        const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedStateRevision: c.val }),
        });
        expect(res.status).toBe(400);
      });
    }
  });

  // ── 400 wrong state (draft CR cannot be evaluated) ──────────────────────
  it("POST /evaluate → 400 when CR is in draft state", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    // Create a CR but do NOT submit it — stays in draft.
    const cr = await runtimePool.query({
      text: "SELECT gitwire_policy.create_policy_change_request('repository','gp04-rt/test','test-config',$1) as id",
      values: [adminPid],
    });
    const crId = cr.rows[0].id;
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: 0 }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── 409 CAS conflict ────────────────────────────────────────────────────
  it("POST /evaluate → 409 on stale expectedStateRevision (CAS)", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId } = await createSubmittedCR(adminPid);
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: 99999 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("concurrently");
    });
  });

  // ── 422 committed computed rejection ────────────────────────────────────
  it("POST /evaluate → 422 { state: rejected } on invalid payload (committed computed rejection)", async () => {
    const adminPid = globalThis.__gp04RtAdminPid;
    const { crId, stateRevision } = await createSubmittedCR(adminPid, INVALID_PAYLOAD);
    await withServer(adminPid, async (base) => {
      const res = await fetch(base + "/api/policy/change-requests/" + crId + "/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStateRevision: stateRevision }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.state).toBe("rejected");
    });
  });
}, 300_000);
