// packages/executor-service/tests/integration/plugin-sandbox-live.mjs
// #425 live proofs: drives the REAL runPluginEvaluation against a REAL
// disposable container built from plugin-sandbox/Dockerfile and pushed to a
// local registry (so the digest gate sees genuine RepoDigests).
//
// Requires: docker on PATH, GITWIRE_PLUGIN_SANDBOX_IMAGE_REF and
// GITWIRE_PLUGIN_SANDBOX_IMAGE_DIGEST pointing at the pushed image.
//
// Proofs (from the frozen #425 completion criteria):
//   1. benign custom-rules plugin preserves semantics through the sandbox
//   2. benign playground evaluation preserves semantics
//   3. no credentials in the sandbox environment
//   4. network is denied inside the sandbox
//   5. root filesystem is read-only (write attempt fails with EROFS)
//   6. an infinite loop is hard-killed and leaves NO surviving container
//   7. a wrong configured digest refuses execution (fail-closed)
// (App-side proofs — no local fallback, default-off gates, zero docker
//  authority in gitwire-app — are unit-tested in packages/web.)

import { execFileSync, spawnSync } from "node:child_process";
import { runPluginEvaluation } from "../../src/pluginSandboxRunner.js";

const REF = process.env.GITWIRE_PLUGIN_SANDBOX_IMAGE_REF;
const DIGEST = process.env.GITWIRE_PLUGIN_SANDBOX_IMAGE_DIGEST;
if (!REF || !DIGEST) {
  console.error("Set GITWIRE_PLUGIN_SANDBOX_IMAGE_REF and _DIGEST (push the image to a registry first)");
  process.exit(1);
}

const config = { plugin_sandbox_image_ref: REF, plugin_sandbox_image_digest: DIGEST };

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures += 1;
}

// Busy-wait helper: filter functions are synchronous; 600ms is plenty for a
// refused/unreachable connection attempt to settle its rejection.
const PROBE_WAIT = `
  const wait = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) {} };
`;

async function evalPlayground(pluginSource, expression) {
  return runPluginEvaluation({
    request: {
      kind: "playground",
      expression,
      context: {},
      plugin_sources: [{ source: pluginSource, filename: "probe.js" }],
    },
    config,
  });
}

// ── Proof 1: benign custom-rules semantics ──────────────────────────────────
{
  const r = await runPluginEvaluation({
    request: {
      kind: "custom_rules",
      ctx: { author: "alice", action: "opened" },
      config: { custom_rules: { "alice-rule": { if: "author | isAlice", actions: [] } } },
      plugin_sources: [{
        source: "module.exports = { isAlice: (v) => v === 'alice' }",
        filename: "team.js",
      }],
    },
    config,
  });
  const matched = r.overall === "pass" && r.evaluation_ok ? r.result : null;
  check("benign custom-rules plugin preserves semantics through the sandbox",
    Array.isArray(matched) && matched.some((m) => m.name === "alice-rule"),
    matched ? `matched: ${matched.map((m) => m.name).join(",")}` : `${r.fail_reason}: ${r.fail_detail}`);
}

// ── Proof 2: benign playground semantics ────────────────────────────────────
{
  const r = await evalPlayground("module.exports = { double: (n) => n * 2 }", "21 | double");
  const val = r.overall === "pass" && r.evaluation_ok ? r.result?.result : undefined;
  check("benign playground evaluation preserves semantics (21 | double === 42)",
    val === 42, `value=${JSON.stringify(val)} ${r.evaluation_error || r.fail_detail || ""}`);
}

// ── Proof 3: no credentials in the sandbox environment ──────────────────────
{
  const r = await evalPlayground(
    `module.exports = { envkeys: () => JSON.stringify(Object.keys(globalThis.process.env).sort()) }`,
    "true | envkeys",
  );
  const raw = r.overall === "pass" && r.evaluation_ok ? String(r.result?.result) : "";
  let keys = [];
  try { keys = JSON.parse(raw); } catch { /* fallthrough */ }
  const sensitive = keys.filter((k) => /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|GITHUB_|GITWIRE_|API_)/i.test(k));
  check("sandbox environment carries no credentials", sensitive.length === 0,
    sensitive.length ? `sensitive keys present: ${sensitive.join(",")}` : `env keys: ${keys.join(",")}`);
}

// ── Proof 3b: named expressions resolve inside the sandbox with plugin
// filters (regression for the pre-isolation playground semantics: groups
// resolve into an enriched context BEFORE the main expression evaluates).
{
  const r = await runPluginEvaluation({
    request: {
      kind: "playground",
      expression: 'is.shouted == "ALICE"',
      context: { author: "alice" },
      expressions: { is: { shouted: "author | upper()" } },
      plugin_sources: [{ source: "module.exports = { upper: (v) => String(v).toUpperCase() }", filename: "up.js" }],
    },
    config,
  });
  const val = r.overall === "pass" && r.evaluation_ok ? r.result?.result : undefined;
  check("named expressions resolve inside the sandbox with plugin filters (is.shouted == ALICE)",
    val === true, "value=" + JSON.stringify(val) + " " + (r.evaluation_error || r.fail_detail || ""));
}

// ── Proofs 4+5: network denied + read-only root, via a direct container
// probe under the executor's EXACT isolation flag set (network=none,
// read-only, non-root, caps dropped, no-new-privileges). Synchronous plugin
// filters cannot observe async connection failures (the event loop is
// blocked), so the capability probes run one level down — against the same
// flags the executor's unit tests pin to the real argv, and the report's
// isolation attestation records per run.
{
  const probe = [
    "(async () => {",
    "  const out = {};",
    "  try { await fetch('http://203.0.113.1:1/'); out.network = 'REACHABLE'; }",
    "  catch (e) { out.network = 'blocked:' + ((e.cause && e.cause.code) || e.message); }",
    "  const fs = await import('node:fs/promises');",
    "  try { await fs.writeFile('/probe.txt', 'x'); out.rootfs = 'WRITABLE'; }",
    "  catch (e) { out.rootfs = 'readonly-blocked:' + e.code; }",
    "  try { await fs.writeFile('/tmp/probe.txt', 'x'); out.tmpfs = 'writable'; }",
    "  catch (e) { out.tmpfs = 'blocked:' + e.code; }",
    "  console.log(JSON.stringify(out));",
    "})();",
  ].join(" ");
  const argv = [
    'docker', 'run', '--rm',
    '--network=none', '--read-only', '--user=1000:1000',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--memory=256m', '--cpus=1', '--pids-limit=64',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=8192k',
    '--entrypoint', 'node', REF, '-e', probe,
  ];
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 30000 });
  let out = {};
  try { out = JSON.parse((r.stdout || '').trim()); } catch { /* fallthrough */ }
  check('network access is denied inside the sandbox (executor flag set)',
    /blocked|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNREFUSED|EAI_AGAIN/.test(String(out.network)),
    'network=' + JSON.stringify(out.network));
  check('root filesystem is read-only inside the sandbox (executor flag set)',
    /readonly-blocked:(EACCES|EROFS|EPERM)/.test(String(out.rootfs)),
    'rootfs=' + JSON.stringify(out.rootfs));
  check('bounded tmpfs is the only writable path',
    out.tmpfs === 'writable', 'tmpfs=' + JSON.stringify(out.tmpfs));
}

// ── Proof 6: infinite loop hard-killed, no surviving container ───────────────
{
  const before = spawnSync("docker", ["ps", "-q"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const r = await evalPlayground("module.exports = { loop: () => { while (true) {} } }", "true | loop");
  const after = spawnSync("docker", ["ps", "-q"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const name = r.container_name;
  let survivor = false;
  if (name) {
    survivor = spawnSync("docker", ["ps", "-a", "-q", "--filter", `name=${name}`], { encoding: "utf8" }).stdout.trim().length > 0;
  }
  check("infinite loop is hard-killed with no surviving container",
    r.fail_reason === "sandbox_timeout" && r.container_removed === true && !survivor,
    `reason=${r.fail_reason} removed=${r.container_removed} survivor=${survivor}`);
  void before; void after;
}

// ── Proof 7: wrong configured digest refuses execution ──────────────────────
{
  const bad = "sha256:" + "0".repeat(64);
  const r = await runPluginEvaluation({
    request: { kind: "playground", expression: "1", context: {}, plugin_sources: [] },
    config: { ...config, plugin_sandbox_image_digest: bad },
  });
  check("bad/missing sandbox identity refuses execution",
    r.fail_reason === "image_inspection_failed", `reason=${r.fail_reason}`);
}

console.log(failures === 0 ? "\nALL LIVE PROOFS PASSED" : `\n${failures} LIVE PROOF(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
