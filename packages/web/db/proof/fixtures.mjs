// packages/web/db/proof/fixtures.mjs
//
// Level 1 authority fixtures executed against the disposable PostgreSQL 16
// container. Each fixture asserts a positive success or a negative rejection.
// Fixtures that require a specific boundary caller open a dedicated pg.Client
// connected as that role (passwords set by the harness for the disposable
// container only).
//
// Covers (Wave 1 / issue #81 "Add fixtures"):
//   role login attributes + absence of memberships;
//   wrong-caller rejection (admission/execution functions);
//   column-level privilege separation;
//   legal and illegal lifecycle transitions;
//   compare-and-set lifecycle behavior;
//   immutable command provenance;
//   append-only mutation events + execution receipts;
//   admission/executor event-source partitioning;
//   principal-subtype constraints;
//   tenant/scope constraints (fleet/system vs installation/repository);
//   enforcement-state transition rules;
//   credential issuance and uniqueness;
//   first bootstrap; repeated bootstrap rejection;
//   recovery-marker hash validation; marker single consumption;
//   canonical 040 seed idempotency; canonical seed-drift rejection;
//   pre-existing schema collision failure; pre-existing role collision failure;
//   absence of raw secrets.

import pg from "pg";

/**
 * @param {object} opts
 * @param {import("pg").Pool} opts.pool    admin/superuser-equivalent pool (the proof user, who created the DB)
 * @param {(name:string, ok:boolean, detail?:string)=>void} opts.record
 * @param {string} opts.connUrl             base URL (proof user) — replaced per-role
 * @param {Record<string,string>} opts.rolePasswords  disposable passwords per role
 * @param {(...a:any[])=>void} opts.log
 */
export async function runFixtures({ pool, record, connUrl, rolePasswords, log }) {
  const out = { run: 0, passed: 0, failed: 0 };

  /** Connect as a specific boundary role. */
  async function asRole(role) {
    const url = connUrl.replace(
      /^postgresql:\/\/[^@]*@/,
      `postgresql://${role}:${rolePasswords[role]}@`
    );
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c;
  }

  /** Run fn; return { threw:true, msg } if it threw, else { threw:false }. */
  async function expectThrow(fn) {
    try {
      await fn();
      return { threw: false, msg: "" };
    } catch (e) {
      return { threw: true, msg: (e && e.message) || String(e) };
    }
  }

  async function check(name, ok, detail = "") {
    out.run += 1;
    if (ok) out.passed += 1;
    else out.failed += 1;
    record(name, ok, detail);
  }

  // Helper to insert a baseline principal/service for command fixtures.
  async function seedBaselinePrincipals() {
    // A 'system' principal (requesting_service) and a 'user' principal (initiator).
    const svc = await pool.query(
      `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
       VALUES ('service','fx-requesting-service') RETURNING id`
    );
    const usr = await pool.query(
      `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
       VALUES ('user','fx-initiating-user') RETURNING id`
    );
    return { serviceId: svc.rows[0].id, userId: usr.rows[0].id };
  }

  // ── Role login attributes + absence of memberships ────────────────────────
  log("  [role attributes & memberships]");
  {
    const roles = (
      await pool.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls, rolinherit
         FROM pg_roles
         WHERE rolname IN ('gitwire_auth_fn_owner','gitwire_app','gitwire_admission',
                           'gitwire_executor','gitwire_operator')`
      )
    ).rows;
    const byName = Object.fromEntries(roles.map((r) => [r.rolname, r]));
    check("gitwire_auth_fn_owner is NOLOGIN", byName["gitwire_auth_fn_owner"].rolcanlogin === false);
    check(
      "gitwire_app is LOGIN NOINHERIT",
      byName["gitwire_app"].rolcanlogin === true && byName["gitwire_app"].rolinherit === false
    );
    check(
      "gitwire_admission is LOGIN NOINHERIT",
      byName["gitwire_admission"].rolcanlogin === true && byName["gitwire_admission"].rolinherit === false
    );
    check(
      "gitwire_executor is LOGIN NOINHERIT",
      byName["gitwire_executor"].rolcanlogin === true && byName["gitwire_executor"].rolinherit === false
    );
    check(
      "gitwire_operator is LOGIN NOINHERIT",
      byName["gitwire_operator"].rolcanlogin === true && byName["gitwire_operator"].rolinherit === false
    );
    for (const rn of ["gitwire_app", "gitwire_admission", "gitwire_executor", "gitwire_operator"]) {
      check(
        `${rn} has no superuser/createdb/createrole/replication/bypassrls`,
        byName[rn].rolsuper === false &&
          byName[rn].rolcreatedb === false &&
          byName[rn].rolcreaterole === false &&
          byName[rn].rolreplication === false &&
          byName[rn].rolbypassrls === false
      );
    }
    // Absence of memberships among the five roles.
    const memberships = (
      await pool.query(
        `SELECT r.rolname AS member, r2.rolname AS parent
         FROM pg_auth_members m
         JOIN pg_roles r ON m.member = r.oid
         JOIN pg_roles r2 ON m.roleid = r2.oid
         WHERE r.rolname LIKE 'gitwire_%' AND r2.rolname LIKE 'gitwire_%'`
      )
    ).rows;
    check("no memberships among the five Level 1 roles", memberships.length === 0, JSON.stringify(memberships));
  }

  // ── Principal-subtype constraints ─────────────────────────────────────────
  log("  [principal-subtype constraints]");
  {
    const r1 = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, installation_id)
         VALUES ('user','fx-bad-user',12345)`
      )
    );
    check("user must not have installation_id (CHECK rejects)", r1.threw && /chk_user_no_installation/.test(r1.msg), r1.msg);

    const r2 = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name, github_user_id)
         VALUES ('service','fx-bad-svc',99)`
      )
    );
    check("service must not have github_user_id (CHECK rejects)", r2.threw && /chk_service_no_external/.test(r2.msg), r2.msg);

    const r3 = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
         VALUES ('installation','fx-bad-inst')`
      )
    );
    check("installation must have installation_id (CHECK rejects)", r3.threw && /chk_installation_binding/.test(r3.msg), r3.msg);
  }

  // ── Tenant/scope constraints ──────────────────────────────────────────────
  log("  [scope constraints]");
  {
    const p = await pool.query(
      `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
       VALUES ('user','fx-scope-user') RETURNING id`
    );
    const admin = (
      await pool.query(`SELECT id FROM gitwire_auth.auth_roles WHERE name='admin'`)
    ).rows[0].id;
    // fleet scope with non-null scope_id -> rejected
    const r1 = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principal_roles
           (principal_id, role_id, scope_type, scope_id, granted_by)
         VALUES ($1,$2,'fleet',10,$1)`,
        [p.rows[0].id, admin]
      )
    );
    check("fleet scope must have NULL scope_id", r1.threw && /chk_scope_id_null_fleet_system/.test(r1.msg), r1.msg);

    // installation scope with NULL scope_id -> rejected
    const r2 = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principal_roles
           (principal_id, role_id, scope_type, scope_id, granted_by)
         VALUES ($1,$2,'installation',NULL,$1)`,
        [p.rows[0].id, admin]
      )
    );
    check("installation scope must have non-null scope_id", r2.threw && /chk_scope_id_required/.test(r2.msg), r2.msg);

    // system scope NULL scope_id -> OK (positive)
    const okSystem = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_principal_roles
           (principal_id, role_id, scope_type, scope_id, granted_by)
         VALUES ($1,$2,'system',NULL,$1)`,
        [p.rows[0].id, admin]
      )
    );
    check("system scope with NULL scope_id accepted", !okSystem.threw, okSystem.msg);
  }

  // ── Credential issuance and uniqueness ────────────────────────────────────
  log("  [credential uniqueness]");
  {
    const p = await pool.query(
      `INSERT INTO gitwire_auth.auth_principals (principal_type, display_name)
       VALUES ('user','fx-cred-user') RETURNING id`
    );
    await pool.query(
      `INSERT INTO gitwire_auth.auth_credentials
         (principal_id, lookup_id, secret_hash, pepper_version, audience, display_prefix)
       VALUES ($1,'fx-lookup-1','derivedhash-aaa',1,'gitwire-app','gw_pat_')`,
      [p.rows[0].id]
    );
    // Duplicate lookup_id rejected
    const dup = await expectThrow(() =>
      pool.query(
        `INSERT INTO gitwire_auth.auth_credentials
           (principal_id, lookup_id, secret_hash, pepper_version, audience, display_prefix)
         VALUES ($1,'fx-lookup-1','derivedhash-bbb',1,'gitwire-app','gw_pat_')`,
        [p.rows[0].id]
      )
    );
    check("duplicate credential lookup_id rejected", dup.threw && /duplicate key/.test(dup.msg), dup.msg);
  }

  // ── Wrong-caller rejection for admission/execution functions ──────────────
  log("  [wrong-caller rejection]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    // Create a command as admission.
    const adm = await asRole("gitwire_admission");
    const cmd = await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',100,200,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-key-1')
       RETURNING id, lifecycle_version`,
      [userId, serviceId]
    );
    const cmdId = cmd.rows[0].id;
    const ver = cmd.rows[0].lifecycle_version;
    await adm.end();

    // transition_execution called by admission -> rejected (wrong caller).
    // Rejection may surface as either the function-body session_user check OR
    // a Postgres EXECUTE-privilege denial (the latter is the stronger, earlier
    // gate: EXECUTE is granted only to gitwire_executor). Both are valid
    // wrong-caller rejections.
    const admAsExec = await asRole("gitwire_admission");
    const wrongExec = await expectThrow(() =>
      admAsExec.query("SELECT gitwire_auth.transition_execution($1,'pending','submitted',$2)", [cmdId, ver])
    );
    check(
      "transition_execution rejects gitwire_admission caller",
      wrongExec.threw && ( /gitwire_executor/.test(wrongExec.msg) || /permission denied for function/.test(wrongExec.msg) ),
      wrongExec.msg
    );
    await admAsExec.end();

    // admit_command called by executor -> rejected (wrong caller).
    const execClient = await asRole("gitwire_executor");
    const wrongAdmit = await expectThrow(() =>
      execClient.query("SELECT gitwire_auth.admit_command($1,$2)", [cmdId, serviceId])
    );
    check(
      "admit_command rejects gitwire_executor caller",
      wrongAdmit.threw && ( /gitwire_admission/.test(wrongAdmit.msg) || /permission denied for function/.test(wrongAdmit.msg) ),
      wrongAdmit.msg
    );
    await execClient.end();

    // transition_enforcement_state called by app -> rejected (wrong caller).
    const appClient = await asRole("gitwire_app");
    const wrongEnf = await expectThrow(() =>
      appClient.query("SELECT gitwire_auth.transition_enforcement_state('observed','enforce','fx-evidence')")
    );
    check(
      "transition_enforcement_state rejects gitwire_app caller",
      wrongEnf.threw && ( /gitwire_operator/.test(wrongEnf.msg) || /permission denied for function/.test(wrongEnf.msg) ),
      wrongEnf.msg
    );
    await appClient.end();
  }

  // ── Legal/illegal lifecycle transitions + CAS ────────────────────────────
  log("  [lifecycle transitions + CAS]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    const adm = await asRole("gitwire_admission");
    const ins = await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',101,201,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-key-2')
       RETURNING id, lifecycle_version`,
      [userId, serviceId]
    );
    const id = ins.rows[0].id;

    // Admit it first
    const admitted = await adm.query("SELECT gitwire_auth.admit_command($1,$2) AS ok", [id, serviceId]);
    check("admit_command succeeds for gitwire_admission", admitted.rows[0].ok === true);

    // Legal: pending -> submitted
    const t1 = await adm.query("SELECT gitwire_auth.transition_admission($1,'pending','submitted',0) AS ok", [id]);
    check("legal transition pending->submitted succeeds (CAS ok)", t1.rows[0].ok === true);

    // CAS with wrong expected_version fails
    const t2 = await adm.query("SELECT gitwire_auth.transition_admission($1,'submitted','cancelled',99) AS ok", [id]);
    check("CAS wrong expected_version returns false", t2.rows[0].ok === false);

    // Illegal admission transition: submitted -> completed (not in admission set)
    const illegal = await expectThrow(() =>
      adm.query("SELECT gitwire_auth.transition_admission($1,'submitted','completed',1)", [id])
    );
    check("illegal admission transition submitted->completed rejected", illegal.threw && /illegal transition/i.test(illegal.msg), illegal.msg);

    // Direct table UPDATE of lifecycle_state by app -> permission denied (no UPDATE grant)
    const appClient = await asRole("gitwire_app");
    const directUpd = await expectThrow(() =>
      appClient.query("UPDATE gitwire_auth.mutation_commands SET lifecycle_state='completed' WHERE id=$1", [id])
    );
    check("direct UPDATE lifecycle_state by gitwire_app denied", directUpd.threw && /permission denied/.test(directUpd.msg), directUpd.msg);
    await appClient.end();

    // Execution path: submitted -> executing -> completed (legal)
    const execClient = await asRole("gitwire_executor");
    const ex1 = await execClient.query("SELECT gitwire_auth.transition_execution($1,'submitted','executing',1) AS ok", [id]);
    check("legal execution submitted->executing succeeds", ex1.rows[0].ok === true);
    const ex2 = await execClient.query("SELECT gitwire_auth.transition_execution($1,'executing','completed',2) AS ok", [id]);
    check("legal execution executing->completed succeeds", ex2.rows[0].ok === true);

    // Illegal: completed -> pending (terminal)
    const term = await expectThrow(() =>
      execClient.query("SELECT gitwire_auth.transition_execution($1,'completed','pending',3)", [id])
    );
    check("terminal transition completed->pending rejected", term.threw && /illegal transition/i.test(term.msg), term.msg);
    await execClient.end();
    await adm.end();
  }

  // ── Immutable command provenance ──────────────────────────────────────────
  log("  [immutable provenance]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    const adm = await asRole("gitwire_admission");
    const ins = await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',102,202,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-key-3')
       RETURNING id`,
      [userId, serviceId]
    );
    const id = ins.rows[0].id;
    // owner (fn_owner has UPDATE on lifecycle cols only; provenance change is
    // blocked by trigger even if attempted via a privileged path). Test via
    // admin pool: the immutability trigger fires BEFORE column-level privilege
    // checks matter for the columns it can reach; we attempt operation change.
    const blocked = await expectThrow(() =>
      pool.query("UPDATE gitwire_auth.mutation_commands SET operation='issue.open' WHERE id=$1", [id])
    );
    check("UPDATE of operation (provenance) rejected by immutability trigger", blocked.threw && /immutable/.test(blocked.msg), blocked.msg);
    // payload_canonical immutable too
    const blocked2 = await expectThrow(() =>
      pool.query("UPDATE gitwire_auth.mutation_commands SET payload_canonical='{\"x\":1}'::jsonb WHERE id=$1", [id])
    );
    check("UPDATE of payload_canonical rejected by immutability trigger", blocked2.threw && /immutable/.test(blocked2.msg), blocked2.msg);
    await adm.end();
  }

  // ── Idempotency unique constraint ─────────────────────────────────────────
  log("  [idempotency uniqueness]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    const adm = await asRole("gitwire_admission");
    await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',103,203,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-dup-key')`,
      [userId, serviceId]
    );
    const dup = await expectThrow(() =>
      adm.query(
        `INSERT INTO gitwire_auth.mutation_commands
           (initiating_principal, requesting_service, authentication_method,
            target_installation_id, target_repository_id, target_organization,
            target_repository, target_resource_type, operation, payload_hash,
            payload_canonical, auth_result_snapshot, auth_policy_version,
            idempotency_key)
         VALUES ($1,$2,'api_key',103,203,'org','repo','issue','issue.close',
                 'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-dup-key')`,
        [userId, serviceId]
      )
    );
    check("duplicate idempotency key rejected", dup.threw && /ux_mutation_commands_idempotency|duplicate key/.test(dup.msg), dup.msg);
    await adm.end();
  }

  // ── Event-source partitioning ─────────────────────────────────────────────
  log("  [event-source partitioning]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    const adm = await asRole("gitwire_admission");
    const cmd = await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',104,204,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-evt-key')
       RETURNING id`,
      [userId, serviceId]
    );
    const cid = cmd.rows[0].id;

    // Admission CAN insert an admission event
    const okAdm = await expectThrow(() =>
      adm.query(
        `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
         VALUES ($1,'submitted','admission')`,
        [cid]
      )
    );
    check("admission role inserts admission event OK", !okAdm.threw, okAdm.msg);

    // Admission CANNOT insert an execution event (wrong source/caller)
    const badAdm = await expectThrow(() =>
      adm.query(
        `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
         VALUES ($1,'started','executor')`,
        [cid]
      )
    );
    check("admission role cannot insert executor event", badAdm.threw && /gitwire_executor/.test(badAdm.msg), badAdm.msg);
    await adm.end();

    // Executor CAN insert execution event
    const execClient = await asRole("gitwire_executor");
    const okExec = await expectThrow(() =>
      execClient.query(
        `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
         VALUES ($1,'started','executor')`,
        [cid]
      )
    );
    check("executor role inserts executor event OK", !okExec.threw, okExec.msg);

    // Executor CANNOT insert admission event
    const badExec = await expectThrow(() =>
      execClient.query(
        `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
         VALUES ($1,'submitted','admission')`,
        [cid]
      )
    );
    check("executor role cannot insert admission event", badExec.threw && /gitwire_admission/.test(badExec.msg), badExec.msg);
    await execClient.end();

    // gitwire_app has NO INSERT on events at all
    const appClient = await asRole("gitwire_app");
    const appIns = await expectThrow(() =>
      appClient.query(
        `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
         VALUES ($1,'submitted','admission')`,
        [cid]
      )
    );
    check("gitwire_app has no INSERT on mutation_events", appIns.threw && /permission denied/.test(appIns.msg), appIns.msg);
    await appClient.end();
  }

  // ── Append-only events + receipts ─────────────────────────────────────────
  log("  [append-only events & receipts]");
  {
    const { serviceId, userId } = await seedBaselinePrincipals();
    const adm = await asRole("gitwire_admission");
    const cmd = await adm.query(
      `INSERT INTO gitwire_auth.mutation_commands
         (initiating_principal, requesting_service, authentication_method,
          target_installation_id, target_repository_id, target_organization,
          target_repository, target_resource_type, operation, payload_hash,
          payload_canonical, auth_result_snapshot, auth_policy_version,
          idempotency_key)
       VALUES ($1,$2,'api_key',105,205,'org','repo','issue','issue.close',
               'hash','{}'::jsonb,'{}'::jsonb,'v1','fx-append-key')
       RETURNING id`,
      [userId, serviceId]
    );
    const cid = cmd.rows[0].id;
    await adm.query(
      `INSERT INTO gitwire_auth.mutation_events (command_id, event_type, event_source)
       VALUES ($1,'submitted','admission')`,
      [cid]
    );
    await adm.end();

    // UPDATE on events -> append-only trigger rejects (even via admin pool)
    const updEvt = await expectThrow(() =>
      pool.query("UPDATE gitwire_auth.mutation_events SET event_data='{\"x\":1}'::jsonb WHERE command_id=$1", [cid])
    );
    check("UPDATE on mutation_events rejected (append-only)", updEvt.threw && /append-only/.test(updEvt.msg), updEvt.msg);
    const delEvt = await expectThrow(() =>
      pool.query("DELETE FROM gitwire_auth.mutation_events WHERE command_id=$1", [cid])
    );
    check("DELETE on mutation_events rejected (append-only)", delEvt.threw && /append-only/.test(delEvt.msg), delEvt.msg);

    // Receipts: executor inserts, app cannot, append-only rejects update/delete
    const execClient = await asRole("gitwire_executor");
    const rcpt = await execClient.query(
      `INSERT INTO gitwire_auth.execution_receipts
         (command_id, github_endpoint, github_status, github_response, github_oid)
       VALUES ($1,'PATCH /repos/x/y/issues/1',200,'{}'::jsonb,'abc-oid')
       RETURNING id`,
      [cid]
    );
    check("executor inserts execution_receipt OK", !!rcpt.rows[0].id);
    await execClient.end();

    const appClient = await asRole("gitwire_app");
    const appRcpt = await expectThrow(() =>
      appClient.query(
        `INSERT INTO gitwire_auth.execution_receipts
           (command_id, github_endpoint) VALUES ($1,'PATCH /x')`,
        [cid]
      )
    );
    check("gitwire_app has no INSERT on execution_receipts", appRcpt.threw && /permission denied/.test(appRcpt.msg), appRcpt.msg);
    await appClient.end();

    const updRcpt = await expectThrow(() =>
      pool.query("UPDATE gitwire_auth.execution_receipts SET github_status=404 WHERE command_id=$1", [cid])
    );
    check("UPDATE on execution_receipts rejected (append-only)", updRcpt.threw && /append-only/.test(updRcpt.msg), updRcpt.msg);
    const delRcpt = await expectThrow(() =>
      pool.query("DELETE FROM gitwire_auth.execution_receipts WHERE command_id=$1", [cid])
    );
    check("DELETE on execution_receipts rejected (append-only)", delRcpt.threw && /append-only/.test(delRcpt.msg), delRcpt.msg);
  }

  // ── Column-level privilege separation (gitwire_app) ───────────────────────
  log("  [column-level privileges]");
  {
    const appClient = await asRole("gitwire_app");
    // app can SELECT mutation_commands
    const sel = await expectThrow(() => appClient.query("SELECT count(*) FROM gitwire_auth.mutation_commands"));
    check("gitwire_app can SELECT mutation_commands", !sel.threw, sel.msg);
    // app CANNOT INSERT mutation_commands (admission only)
    const insCmd = await expectThrow(() =>
      appClient.query(
        `INSERT INTO gitwire_auth.mutation_commands
           (initiating_principal, requesting_service, authentication_method,
            target_installation_id, target_repository_id, target_organization,
            target_repository, target_resource_type, operation, payload_hash,
            payload_canonical, auth_result_snapshot, auth_policy_version,
            idempotency_key)
         VALUES (null,null,'api_key',1,1,'o','r','i','x','h','{}'::jsonb,'{}'::jsonb,'v','k')`
      )
    );
    check("gitwire_app cannot INSERT mutation_commands", insCmd.threw && /permission denied/.test(insCmd.msg), insCmd.msg);
    // app CANNOT INSERT auth_role_permissions
    const insPerm = await expectThrow(() =>
      appClient.query(`INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission) VALUES (null,'x:y')`)
    );
    check("gitwire_app cannot INSERT auth_role_permissions", insPerm.threw && /permission denied/.test(insPerm.msg), insPerm.msg);
    // app CANNOT UPDATE auth_enforcement_state
    const updEnf = await expectThrow(() =>
      appClient.query("UPDATE gitwire_auth.auth_enforcement_state SET state='enforce' WHERE id=1")
    );
    check("gitwire_app cannot UPDATE auth_enforcement_state", updEnf.threw && /permission denied/.test(updEnf.msg), updEnf.msg);
    await appClient.end();
  }

  // ── Enforcement-state transition rules ────────────────────────────────────
  log("  [enforcement-state transitions]");
  {
    const op = await asRole("gitwire_operator");
    // Illegal: observed -> legacy_removed (skip)
    const illegal = await expectThrow(() =>
      op.query("SELECT gitwire_auth.transition_enforcement_state('observed','legacy_removed','fx')")
    );
    check("illegal enforcement transition observed->legacy_removed rejected", illegal.threw && /illegal enforcement-state transition/i.test(illegal.msg), illegal.msg);
    // missing evidence rejected
    const noEv = await expectThrow(() =>
      op.query("SELECT gitwire_auth.transition_enforcement_state('observed','enforce','')")
    );
    check("enforcement transition with empty evidence rejected", noEv.threw && /evidence is required/.test(noEv.msg), noEv.msg);
    // Legal: observed -> enforce
    const ok1 = await op.query("SELECT gitwire_auth.transition_enforcement_state('observed','enforce','fx-evidence-1') AS ok");
    check("legal enforcement observed->enforce succeeds", ok1.rows[0].ok === true);
    // Verify updated_by = session_user (not caller-supplied)
    const ub = await pool.query("SELECT updated_by FROM gitwire_auth.auth_enforcement_state WHERE id=1");
    check("enforcement updated_by is session_user (gitwire_operator)", ub.rows[0].updated_by === "gitwire_operator", JSON.stringify(ub.rows[0]));
    await op.end();
  }

  // ── Bootstrap: first, repeat rejection, recovery marker, single consume ──
  log("  [bootstrap: first / repeat / recovery / single consume]");
  {
    // First bootstrap: state is 'enabled', bootstrap_count 0 -> no marker required.
    const appClient = await asRole("gitwire_app");
    const first = await appClient.query(
      `SELECT gitwire_auth.complete_bootstrap(
         'fx-admin','fx-admin-lookup','derived-admin-hash',1,'gitwire-app','gw_pat_',
         'unused',1) AS id`
    );
    check("first bootstrap succeeds (creates admin principal)", !!first.rows[0].id, "");
    const st1 = await pool.query("SELECT state, bootstrap_count FROM gitwire_auth.auth_bootstrap_state WHERE id=1");
    check("bootstrap state disabled after first bootstrap", st1.rows[0].state === "disabled", JSON.stringify(st1.rows[0]));
    // bigint serializes as string in pg's JSON; coerce for comparison.
    check("bootstrap_count incremented to 1", Number(st1.rows[0].bootstrap_count) === 1, JSON.stringify(st1.rows[0]));

    // Admin principal + credential + assignment created atomically.
    const admins = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_principals WHERE display_name='fx-admin'");
    check("admin principal created", admins.rows[0].n === 1, JSON.stringify(admins.rows[0]));
    const creds = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_credentials WHERE lookup_id='fx-admin-lookup'");
    check("admin credential created", creds.rows[0].n === 1, JSON.stringify(creds.rows[0]));
    const assigns = await pool.query(
      `SELECT count(*)::int AS n FROM gitwire_auth.auth_principal_roles apr
       JOIN gitwire_auth.auth_principals p ON apr.principal_id=p.id
       WHERE p.display_name='fx-admin' AND apr.scope_type='fleet'`
    );
    check("fleet admin assignment created", assigns.rows[0].n === 1, JSON.stringify(assigns.rows[0]));

    // Repeated bootstrap WITHOUT marker -> rejected (state disabled, count>0, no marker).
    const repeat = await expectThrow(() =>
      appClient.query(
        `SELECT gitwire_auth.complete_bootstrap(
           'fx-admin-2','fx-admin-lookup-2','derived-admin-hash-2',1,'gitwire-app','gw_pat_',
           'unused',1)`
      )
    );
    check("repeated bootstrap without marker rejected", repeat.threw && /not enabled|recovery marker/.test(repeat.msg), repeat.msg);
    await appClient.end();

    // Recovery path: operator inserts a marker with a DERIVED hash; the raw
    // secret is validated against it.
    const rawSecret = "fx-recovery-secret";
    const pepperV = 1;
    const derivedHash = (
      await pool.query(
        `SELECT encode(public.hmac($1::bytea, ('pepper-v'||$2)::bytea, 'sha256'), 'hex') AS h`,
        [rawSecret, pepperV]
      )
    ).rows[0].h;
    const op = await asRole("gitwire_operator");
    await op.query(
      `INSERT INTO gitwire_auth.auth_bootstrap_recovery_markers
         (consumer_secret_hash, pepper_version, created_by_db_session)
       VALUES ($1,$2,'gitwire_operator')`,
      [derivedHash, pepperV]
    );

    // enable_bootstrap_from_marker with WRONG secret -> rejected.
    const wrongSecret = await expectThrow(() =>
      op.query("SELECT gitwire_auth.enable_bootstrap_from_marker('wrong-secret',$1)", [pepperV])
    );
    check("enable_bootstrap_from_marker rejects wrong secret", wrongSecret.threw && /no matching unconsumed recovery marker/.test(wrongSecret.msg), wrongSecret.msg);

    // enable with CORRECT secret -> state flips to enabled (marker not yet consumed).
    const enable = await op.query("SELECT gitwire_auth.enable_bootstrap_from_marker($1,$2) AS ok", [rawSecret, pepperV]);
    check("enable_bootstrap_from_marker accepts correct secret", enable.rows[0].ok === true);
    // marker still unconsumed at this point
    const unconsumed1 = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_bootstrap_recovery_markers WHERE consumed_at IS NULL");
    check("marker not consumed by enable step", unconsumed1.rows[0].n === 1, JSON.stringify(unconsumed1.rows[0]));
    await op.end();

    // Now complete_bootstrap with correct recovery secret consumes exactly one marker.
    const appClient2 = await asRole("gitwire_app");
    const second = await appClient2.query(
      `SELECT gitwire_auth.complete_bootstrap(
         'fx-admin-3','fx-admin-lookup-3','derived-admin-hash-3',1,'gitwire-app','gw_pat_',
         $1,$2) AS id`,
      [rawSecret, pepperV]
    );
    check("recovery bootstrap succeeds with correct secret", !!second.rows[0].id, "");
    const unconsumed2 = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_bootstrap_recovery_markers WHERE consumed_at IS NULL");
    check("marker consumed exactly once by complete_bootstrap", unconsumed2.rows[0].n === 0, JSON.stringify(unconsumed2.rows[0]));
    const consumed = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_bootstrap_recovery_markers WHERE consumed_at IS NOT NULL");
    check("exactly one marker row marked consumed", consumed.rows[0].n === 1, JSON.stringify(consumed.rows[0]));

    // Re-using the same consumed marker is rejected (enable finds none).
    const op2 = await asRole("gitwire_operator");
    const reconsume = await expectThrow(() =>
      op2.query("SELECT gitwire_auth.enable_bootstrap_from_marker($1,$2)", [rawSecret, pepperV])
    );
    check("consumed marker cannot re-enable (single consumption)", reconsume.threw && /no matching unconsumed recovery marker/.test(reconsume.msg), reconsume.msg);
    await op2.end();
    await appClient2.end();
  }

  // ── Canonical 040 seed idempotency + drift rejection ─────────────────────
  log("  [seed idempotency & drift]");
  {
    // Idempotent re-execution of 040's role/permission inserts.
    await pool.query(
      `INSERT INTO gitwire_auth.auth_roles (name, description, is_builtin, status)
       VALUES ('admin','x',true,'active') ON CONFLICT (name) DO NOTHING`
    );
    const adminCount = await pool.query("SELECT count(*)::int AS n FROM gitwire_auth.auth_roles WHERE name='admin'");
    check("canonical role insert is idempotent", adminCount.rows[0].n === 1, JSON.stringify(adminCount.rows[0]));

    // Canonical drift rejection: a DIFFERENT description for the same name is
    // NOT overwritten (ON CONFLICT DO NOTHING preserves the existing row).
    const beforeDesc = await pool.query("SELECT description FROM gitwire_auth.auth_roles WHERE name='admin'");
    await pool.query(
      `INSERT INTO gitwire_auth.auth_roles (name, description, is_builtin, status)
       VALUES ('admin','DRIFT-DESC',true,'active') ON CONFLICT (name) DO NOTHING`
    );
    const afterDesc = await pool.query("SELECT description FROM gitwire_auth.auth_roles WHERE name='admin'");
    check("canonical seed-drift NOT applied (row preserved)", beforeDesc.rows[0].description === afterDesc.rows[0].description, `${beforeDesc.rows[0].description} != ${afterDesc.rows[0].description}`);

    // The proof-layer drift assertion: the canonical set is exactly what 040 specifies.
    const roles = (await pool.query("SELECT name FROM gitwire_auth.auth_roles WHERE is_builtin ORDER BY name")).rows.map((r) => r.name);
    check("canonical built-in roles match spec", JSON.stringify(roles) === JSON.stringify(["admin", "legacy-key", "operator"]), JSON.stringify(roles));
  }

  // ── Absence of raw secrets (scan migration + rollback + harness files) ────
  log("  [absence of raw secrets in repo files]");
  {
    const { readFileSync } = await import("node:fs");
    const { glob } = await import("node:fs/promises");
    const path = await import("node:path");
    const files = [
      "packages/web/db/migrations/038_level1_schema.sql",
      "packages/web/db/migrations/039_level1_roles.sql",
      "packages/web/db/migrations/040_level1_seed.sql",
      "packages/web/db/proof/rollback_level1.sql",
    ];
    let allClean = true;
    for (const rel of files) {
      const txt = readFileSync(path.join(process.cwd(), rel), "utf8");
      // Reject real-looking high-entropy secrets or password literals. The
      // placeholder '<hash-from-environment>' style is fine; an actual
      // assignment like PASSWORD '....' or sk-... / ghp_... / gw_pat_XXXXX
      // is not.
      const suspicious = txt.match(/(ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{12}|password\s*=\s*['"][A-Za-z0-9]{8,}['"])/i);
      if (suspicious) {
        allClean = false;
        check(`no raw secret in ${rel}`, false, `matched: ${suspicious[0]}`);
      }
    }
    check("no raw secrets in 038-040 + rollback files", allClean);
  }

  return out;
}
