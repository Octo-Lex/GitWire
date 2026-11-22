// tests/unit/prune-script-failclosed.test.js
// #483 v5 (R3/R4/R5) shell-level regressions: drive the REAL executor
// script against a stubbed docker/df toolchain and assert (a) fail-closed
// behavior — a failed docker ps/inspect aborts before ANY rmi; missing or
// incomplete current-release metadata aborts — and (b) the positive
// selection path: only old images under the three release repositories
// are removed; pinned validator, unmanaged images, running refs, and
// rollback-recorded identities survive.
//
// The stub `docker` records every invocation to a log so tests can assert
// "no rmi was ever invoked" — the strongest form of fail-closed.

import { jest } from "@jest/globals";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "prune-protected-images.sh");

// Distinct 64-hex digests for n up to 255: two hex digits repeated 32x.
const D = (n) => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;
const APP = "ghcr.io/octo-lex/gitwire-app";
const EXEC = "ghcr.io/octo-lex/gitwire-executor-service";
const DASH = "ghcr.io/octo-lex/gitwire-dashboard";
const VAL = "ghcr.io/octo-lex/gitwire-validator";
const PG = "docker.io/library/postgres";

function fixture({ psFail = false, inspectFail = false, images = [], runningIds = [], runningNames = [], envRefs = true, extraReleaseDirs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prune-test-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const work = join(dir, "work");
  mkdirSync(join(work, "releases"), { recursive: true });
  // Production topology: releases/current is a symlink to releases/<sha>.
  // The <sha> target dir ALSO appears in directory listings with the same
  // records — the selector must exclude both entries.
  const CURRENT_SHA = "cccc3333333333333333333333333333333333333";
  mkdirSync(join(work, "releases", CURRENT_SHA));
  try {
    symlinkSync(CURRENT_SHA, join(work, "releases", "current"), "dir");
  } catch {
    // Windows without symlink privilege: junctions need none.
    try { symlinkSync(join(work, "releases", CURRENT_SHA), join(work, "releases", "current"), "junction"); }
    catch { mkdirSync(join(work, "releases", "current")); }
  }
  mkdirSync(join(work, "releases", "aaaa1111111111111111111111111111111111111"));
  mkdirSync(join(work, "releases", "bbbb2222222222222222222222222222222222222"));

  const envFile = join(work, "production.env");
  writeFileSync(envFile, envRefs ? [
    "# production config",
    `GITWIRE_VALIDATOR_IMAGE_REF=${VAL}@${D(9)}`,
    `GITWIRE_VALIDATOR_IMAGE_DIGEST=${D(9)}`,
  ].join("\n") + "\n" : [
    "# production config with NO digest-qualified refs (record-only)",
    "GITWIRE_SOME_PLAIN_VALUE=yes",
  ].join("\n") + "\n");

  const cur = join(work, "releases", CURRENT_SHA, "images.env");
  writeFileSync(cur, [
    `GITWIRE_APP_IMAGE=${APP}@${D(5)}`,
    `GITWIRE_EXECUTOR_IMAGE=${EXEC}@${D(5)}`,
    `GITWIRE_DASHBOARD_IMAGE=${DASH}@${D(5)}`,
  ].join("\n") + "\n");

  // Extra historical records for the R7 regression (app digests D(11)+,
  // mtimes forced oldest-first so ls -1dt orders them predictably).
  let extraN = 0;
  for (const dir of extraReleaseDirs) {
    extraN += 1;
    mkdirSync(join(work, "releases", dir), { recursive: true });
    writeFileSync(join(work, "releases", dir, "images.env"),
      `GITWIRE_APP_IMAGE=${APP}@${D(10 + extraN)}\nGITWIRE_EXECUTOR_IMAGE=${EXEC}@${D(10 + extraN)}\nGITWIRE_DASHBOARD_IMAGE=${DASH}@${D(10 + extraN)}\n`);
    const t = new Date(Date.UTC(2026, 8, extraN)); // forced mtime — deterministic ls -1dt
    utimesSync(join(work, "releases", dir), t, t);
  }
  // Rollback record: app@D(1) is OLD but recorded — must survive.
  writeFileSync(join(work, "releases", "aaaa1111111111111111111111111111111111111", "images.env"),
    `GITWIRE_APP_IMAGE=${APP}@${D(1)}\nGITWIRE_EXECUTOR_IMAGE=${EXEC}@${D(1)}\nGITWIRE_DASHBOARD_IMAGE=${DASH}@${D(1)}\n`);
  writeFileSync(join(work, "releases", "bbbb2222222222222222222222222222222222222", "images.env"),
    `GITWIRE_APP_IMAGE=${APP}@${D(2)}\nGITWIRE_EXECUTOR_IMAGE=${EXEC}@${D(2)}\nGITWIRE_DASHBOARD_IMAGE=${DASH}@${D(2)}\n`);
  // aaaa/bbbb are OLD records (Aug) — the rollback window must select the
  // three NEWEST records (rr4/rr3/rr2, Sep), not these.
  const aug = (d) => new Date(Date.UTC(2026, 7, d));
  for (const name of readdirSync(join(work, "releases"))) {
    if (name.startsWith("aaaa")) utimesSync(join(work, "releases", name), aug(1), aug(1));
    if (name.startsWith("bbbb")) utimesSync(join(work, "releases", name), aug(2), aug(2));
  }

  const imagesJsonl = images.map((x) => JSON.stringify({
    Repository: x.repository, Tag: x.tag ?? "<none>", Digest: x.digest ?? "<none>",
    ID: x.id, CreatedAt: x.created,
  })).join("\n");

  // Stub docker: logs every call to a file path given via env (separator-
  // safe); fixture data arrives via env too.
  const STUB = [
    '#!/usr/bin/env bash',
    'echo "docker $*" >> "$PRUNE_TEST_LOG"',
    'if [ "$1" = "ps" ]; then',
    '  if [ "${PRUNE_TEST_PS_FAIL:-0}" = "1" ]; then exit 1; fi',
    '  if [ "$2" = "--format" ]; then',
    '    printf "%s\n" "$PRUNE_TEST_RUNNING_NAMES"',
    '  else',
    '    printf "%s\n" "$PRUNE_TEST_RUNNING_PS_IDS"',
    '  fi',
    '  exit 0',
    'fi',
    'if [ "$1" = "inspect" ]; then',
    '  if [ "${PRUNE_TEST_INSPECT_FAIL:-0}" = "1" ]; then exit 1; fi',
    '  printf "%s\n" "$PRUNE_TEST_RUNNING_IDS"',
    '  exit 0',
    'fi',
    'if [ "$1" = "images" ]; then',
    '  printf "%s\n" "$PRUNE_TEST_IMAGES"',
    '  exit 0',
    'fi',
    'if [ "$1" = "rmi" ]; then exit 0; fi',
    'exit 0'
  ].join("\n") + "\n";
  writeFileSync(join(binDir, "docker"), STUB);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(join(binDir, "flock"), [
    "#!/usr/bin/env bash",
    "exit 0",
  ].join("\n") + "\n");
  writeFileSync(join(binDir, "df"), [
    "#!/usr/bin/env bash",
    'echo "Filesystem 50G 11G 40G 22% /"',
  ].join("\n") + "\n");

  const envPayloads = {
    PRUNE_TEST_IMAGES: imagesJsonl,
    PRUNE_TEST_RUNNING_PS_IDS: runningIds.map((i) => i.slice(0, 12)).join("\n"),
    PRUNE_TEST_RUNNING_IDS: runningIds.join("\n"),
    PRUNE_TEST_RUNNING_NAMES: runningNames.join("\n"),
  };
  const logFile = join(dir, "docker.log");
  chmodSync(join(binDir, "flock"), 0o755);
  chmodSync(join(binDir, "df"), 0o755);
  return { dir, binDir, work, envFile, logFile, envPayloads };
}

function spawnPrune(fx, { extraEnv = {}, dryRun = true, workTree } = {}) {
  const env = {
    ...process.env,
    PATH: `${fx.binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    PRUNE_TEST_PS_FAIL: "0",
    PRUNE_TEST_INSPECT_FAIL: "0",
    ...fx.envPayloads,
    PRUNE_TEST_LOG: fx.logFile,
    ...extraEnv,
  };
  if (dryRun) env.DRY_RUN = "1";
  return spawnSync("bash", [join(workTree, "scripts", "prune-protected-images.sh"), fx.envFile, "3", "10"], {
    env,
    encoding: "utf8",
    cwd: fx.work,
  });
}

function stageWorkTree(fx) {
  const scriptsDir = join(fx.work, "scripts");
  const libDir = join(fx.work, "packages", "web", "src", "lib");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(fx.work, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(scriptsDir, "prune-protected-images.sh"), readFileSync(SCRIPT, "utf8"));
  writeFileSync(join(libDir, "imageRetentionPolicy.js"),
    readFileSync(join(REPO_ROOT, "packages", "web", "src", "lib", "imageRetentionPolicy.js"), "utf8"));
  return fx.work;
}

function dockerLog(fx) {
  return existsSync(fx.logFile) ? readFileSync(fx.logFile, "utf8") : "";
}

const BASE_IMAGES = [
  // App: D1/D2 rollback-recorded; D5 current + running; D3/D4 recency window.
  { repository: APP, digest: D(1), id: "app1", created: "2026-11-01" },
  { repository: APP, digest: D(2), id: "app2", created: "2026-11-05" },
  { repository: APP, digest: D(3), id: "app3", created: "2026-11-10" },
  { repository: APP, digest: D(4), id: "app4", created: "2026-11-15" },
  { repository: APP, digest: D(5), id: "app5", created: "2026-11-21" },
  // UNPROTECTED accumulation: old app images beyond every keep rule.
  { repository: APP, digest: D(6), id: "app6", created: "2026-10-01" },
  { repository: APP, digest: D(7), id: "app7", created: "2026-10-05" },
  // Current-release peers so the mandatory gate resolves.
  { repository: EXEC, digest: D(5), id: "exec5", created: "2026-11-21" },
  { repository: DASH, digest: D(5), id: "dash5", created: "2026-11-21" },
  // Validator: pinned D9 present — protected, NEVER eligible.
  { repository: VAL, digest: D(9), id: "val9", created: "2026-05-01" },
  // Unmanaged: postgres — never eligible.
  { repository: PG, tag: "16", digest: null, id: "pg16", created: "2024-01-01" },
];

describe("prune script — shell-level fail-closed + selection regressions (R3/R4/R5)", () => {
  jest.setTimeout(60_000);

  it("R3 fail-closed: docker ps failure aborts with NO rmi invocation", () => {
    const fx = fixture({ images: BASE_IMAGES, runningIds: ["sha256:" + "f".repeat(64)], runningNames: [`${APP}:latest`] });
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { extraEnv: { PRUNE_TEST_PS_FAIL: "1" }, workTree });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("docker ps failed");
    expect(dockerLog(fx)).not.toContain("rmi");
  });

  it("R3 fail-closed: docker inspect failure aborts with NO rmi invocation", () => {
    const fx = fixture({ images: BASE_IMAGES, runningIds: ["sha256:" + "f".repeat(64)], runningNames: [`${APP}:latest`] });
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { extraEnv: { PRUNE_TEST_INSPECT_FAIL: "1" }, workTree });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("docker inspect failed");
    expect(dockerLog(fx)).not.toContain("rmi");
  });

  it("R5 fail-closed: missing current release record aborts", () => {
    const fx = fixture({ images: BASE_IMAGES });
    rmSync(join(fx.work, "releases", "cccc3333333333333333333333333333333333333", "images.env"));
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { workTree });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("current release record missing");
    expect(dockerLog(fx)).not.toContain("rmi");
  });

  it("R5 fail-closed: incomplete current record (missing dashboard key) aborts", () => {
    const fx = fixture({ images: BASE_IMAGES });
    const cur = join(fx.work, "releases", "current", "images.env");
    writeFileSync(cur, `GITWIRE_APP_IMAGE=${APP}@${D(5)}\nGITWIRE_EXECUTOR_IMAGE=${EXEC}@${D(5)}\n`);
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { workTree });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("GITWIRE_DASHBOARD_IMAGE");
    expect(dockerLog(fx)).not.toContain("rmi");
  });

  it("R6 regression: record-only configuration (production.env with NO digest refs) reaches a decision instead of aborting", () => {
    const fx = fixture({ images: BASE_IMAGES, envRefs: false, runningIds: [], runningNames: [] });
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { workTree });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("decision:");
    expect(r.stdout).toContain("mandatory_ok=true"); // record refs are the mandatory set and all resolve
  });

  it("R7 regression: current symlink excluded from rollback records — N DISTINCT historical records protected", () => {
    // Four historical records with forced mtimes (Sep1<2<3<4): rr1=a..rr4=d.
    // keepPerRepo=3 protects the three NEWEST (d,c,b) + current; record a
    // (D11) is beyond the window and IS removable; b/c/d protected BY RECORD.
    const fx = fixture({
      images: [
        ...BASE_IMAGES,
        { repository: APP, digest: D(11), id: "appRec1", created: "2026-09-01" },
        { repository: APP, digest: D(12), id: "appRec2", created: "2026-09-05" },
        { repository: APP, digest: D(13), id: "appRec3", created: "2026-09-10" },
        { repository: APP, digest: D(14), id: "appRec4", created: "2026-09-15" },
      ],
      runningIds: [],
      runningNames: [],
      extraReleaseDirs: [
        "rr1111111111111111111111111111111111111111",
        "rr2222222222222222222222222222222222222222",
        "rr3333333333333333333333333333333333333333",
        "rr4444444444444444444444444444444444444444"],
    });
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { workTree });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain("appRec1");   // record a: outside the 3-slot window
    expect(out).not.toContain("appRec2"); // record b: protected by RECORD
    expect(out).not.toContain("appRec3"); // record c: protected by RECORD
    expect(out).not.toContain("appRec4"); // record d: protected by RECORD
  });
  it("POSITIVE PATH (dry-run): only old release-repo accumulation removed; validator/unmanaged/running/rollback-recorded all survive", () => {
    const fx = fixture({
      images: BASE_IMAGES,
      runningIds: ["sha256:" + "f".repeat(64)], // running container on app5 (by id)
      runningNames: [`${APP}@${D(5)}`],
    });
    const workTree = stageWorkTree(fx);
    const r = spawnPrune(fx, { workTree, dryRun: true });
    expect(r.status).toBe(0);
    const out = r.stdout;
    // Removed: ONLY the unprotected accumulation (app6/app7 — beyond the
    // rollback records, recency window, current release, and running refs).
    expect(out).toContain("app6");
    expect(out).toContain("app7");
    // Survivors explicitly NOT in the removal list.
    expect(out).not.toContain("app1");   // rollback-recorded (releases/aaaa images.env)
    expect(out).not.toContain("app2");   // rollback-recorded (releases/bbbb)
    expect(out).not.toContain("app3");   // recency window (3 newest per repo)
    expect(out).not.toContain("app4");   // recency window
    expect(out).not.toContain("app5");   // current release record + running
    expect(out).not.toContain("exec5");  // current release record
    expect(out).not.toContain("dash5");  // current release record
    expect(out).not.toContain("val9");   // pinned validator — protected, not eligible
    expect(out).not.toContain("pg16");   // unmanaged repository — never eligible
  });
});

import { rmSync, chmodSync, utimesSync, readdirSync, symlinkSync } from "node:fs";
