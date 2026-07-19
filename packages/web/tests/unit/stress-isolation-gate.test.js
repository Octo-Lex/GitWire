// tests/unit/stress-isolation-gate.test.js
//
// Negative tests for the stress-isolation static gate.
// Proves each detector fails when its prohibited construct is introduced,
// and that a clean contracted fixture + allowlist behave correctly.
// Parameterized across all mutating methods and legacy helper families.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { scanStressIsolation, collectStressIsolationFiles, scanDockerfiles, validateComposeDockerfiles, verifyKnownDockerfilesExist } from "../../../../scripts/check-stress-isolation.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stress-gate-test-"));
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

const CLEAN_FILE = `
import { runContractedBurst } from "./burst-runner.js";
import { apiContractedOperation, STATUS_SETS } from "./response-contracts.js";
describe("clean", () => {
  it("uses contracted operations", async () => {
    const ops = [apiContractedOperation("/api/repos", { kind: "read", expectedStatuses: STATUS_SETS.READ_OK })];
    await runContractedBurst(ops, { concurrency: 1, pacing: { mode: "none" } });
  });
});
`;

describe("stress-isolation static gate — negative tests", () => {
  let dir;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("clean contracted fixture passes with zero violations", () => {
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    expect(scanStressIsolation({ dir })).toEqual([]);
  });

  // Parameterized: all mutating methods
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`raw ${method} fetch is detected`, () => {
      writeFile(dir, "bad.test.js", `
        fetch("http://x/api", { method: "${method}", body: "{}" });
      `);
      const violations = scanStressIsolation({ dir });
      expect(violations.some(v => v.msg.includes("raw mutating"))).toBe(true);
    });
  }

  it("apiBurstOperation is detected", () => {
    writeFile(dir, "bad.test.js", `apiBurstOperation("/api/repos", { kind: "read" });`);
    expect(scanStressIsolation({ dir }).some(v => v.msg.includes("apiContractedOperation"))).toBe(true);
  });

  it("boundedBurst is detected", () => {
    writeFile(dir, "bad.test.js", `boundedBurst(tasks, { maxConcurrent: 2 });`);
    expect(scanStressIsolation({ dir }).some(v => v.msg.includes("runContractedBurst"))).toBe(true);
  });

  // Parameterized: all legacy helper families
  for (const helper of ["get", "post", "put", "patch", "del"]) {
    it(`await ${helper}() legacy helper is detected`, () => {
      writeFile(dir, "bad.test.js", `const res = await ${helper}("/api/repos");`);
      expect(scanStressIsolation({ dir }).some(v => v.msg.includes("legacy helper"))).toBe(true);
    });
  }

  it("inline status array [200, 429] is detected", () => {
    writeFile(dir, "bad.test.js", `expectedStatuses: [200, 429],`);
    expect(scanStressIsolation({ dir }).some(v => v.msg.includes("inline status array"))).toBe(true);
  });

  it("nonexistent directory fails closed (not empty result)", () => {
    const violations = scanStressIsolation({ dir: "/nonexistent/path/that/does/not/exist" });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].msg).toContain("cannot read");
  });

  it("directory with no scannable stress files fails closed", () => {
    writeFile(dir, "helper.js", `const x = 1;`);
    const violations = scanStressIsolation({ dir });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].msg).toContain("no scannable stress files");
  });

  it("allowlisted files are skipped entirely", () => {
    writeFile(dir, "skipped.test.js", `
      apiBurstOperation("/api/repos");
      boundedBurst([]);
      await get("/x");
      fetch("http://x", { method: "POST" });
      [200, 429]
    `);
    expect(scanStressIsolation({ dir, allowlist: new Set(["skipped.test.js"]) })).toEqual([]);
  });

  it("root-level non-test, non-module files are ignored (library code is not scanned)", () => {
    // burst-runner.js, response-contracts.js, stress-helpers.js at the stress
    // root are consumed-by-tests library code, not tests/modules. They are
    // intentionally NOT scanned by the isolation gate.
    writeFile(dir, "helper.js", `apiBurstOperation("/api/repos");`);
    // Need at least one .test.js file for the directory to be valid.
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    expect(scanStressIsolation({ dir })).toEqual([]);
  });
});

// ─── Recursive module discovery (P2) ──────────────────────────────────────

describe("stress-isolation recursive module discovery", () => {
  let dir;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("collectStressIsolationFiles discovers nested .test.js files", () => {
    writeFile(dir, "top.test.js", CLEAN_FILE);
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFile(path.join(dir, "nested"), "deep.test.js", CLEAN_FILE);
    const found = collectStressIsolationFiles(dir).map((c) => c.rel).sort();
    expect(found).toEqual(["nested/deep.test.js", "top.test.js"]);
  });

  it("collectStressIsolationFiles discovers module files under modules/", () => {
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "scenario-harness.js", "export const x = 1;");
    writeFile(path.join(dir, "modules"), "util.mjs", "export const y = 2;");
    // Root-level non-test, non-module files are NOT discovered.
    writeFile(dir, "library.js", "export const z = 3;");
    const found = collectStressIsolationFiles(dir).map((c) => c.rel).sort();
    expect(found).toEqual(["modules/scenario-harness.js", "modules/util.mjs"]);
  });

  it("a directory symbolic link fails closed as a violation (not silently clean)", () => {
    // A directory symlink whose own name is not a scannable pattern (e.g.
    // modules/linked → /elsewhere) can still be an import target on Linux
    // (`import "./linked/evil.js"` executes code outside the scanner). The
    // gate must report EVERY symlink beneath the stress tree, not just
    // file-shaped scannable-named ones. The scanner does not follow the
    // link, but it must surface it.
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "real.js", "export const x = 1;");
    try {
      fs.symlinkSync("/nonexistent/target", path.join(dir, "modules", "linked"), "dir");
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "ENOSYS") throw err;
      return; // platform cannot create symlinks — skip, not fail
    }
    writeFile(dir, "clean.test.js", CLEAN_FILE); // satisfy non-empty scan
    const violations = scanStressIsolation({ dir });
    expect(violations).toContainEqual({
      file: "modules/linked",
      msg: "symbolic links are not permitted in the stress isolation surface",
    });
  });

  it("a scannable-name symbolic link fails closed as a violation (not silently clean)", () => {
    // A symlink whose name matches the scannable pattern (e.g.
    // modules/adapter.js → /elsewhere/evil.js) would be executable at runtime
    // but its target is outside the committed tree the gate scans. The gate
    // must NOT silently treat it as clean; it must report the symlink itself.
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "real.js", "export const x = 1;");
    const symlinkPath = path.join(dir, "modules", "adapter.js");
    try {
      fs.symlinkSync("/nonexistent/target", symlinkPath, "file");
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "ENOSYS") throw err;
      return; // platform cannot create symlinks — skip, not fail
    }
    writeFile(dir, "clean.test.js", CLEAN_FILE); // satisfy non-empty scan
    const violations = scanStressIsolation({ dir });
    expect(violations).toContainEqual({
      file: "modules/adapter.js",
      msg: "symbolic links are not permitted in the stress isolation surface",
    });
  });

  it("unreadable individual stress file produces a structured violation (not a throw)", () => {
    // The pure scanner contract: every failure mode returns structured
    // violations, never throws. A file that exists in the collected list
    // but cannot be read (permissions, race) must surface as a violation.
    //
    // Platform caveat: Windows ACLs govern access, not POSIX mode bits, so
    // chmod(000) may succeed without actually blocking Node reads. Probe
    // whether the platform honors the mode; if not, skip the test rather
    // than falsely pass (the contract is still verified on Linux CI).
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    const unreadable = path.join(dir, "modules", "locked.js");
    writeFile(path.join(dir, "modules"), "locked.js", "export const x = 1;");
    try {
      fs.chmodSync(unreadable, 0o000);
    } catch (err) {
      if (err.code !== "EPERM") throw err;
      return; // chmod itself refused — skip, not fail
    }
    // Verify the platform actually denies the read; if not, restore and skip.
    let platformHonorsMode = false;
    try {
      fs.readFileSync(unreadable, "utf8");
    } catch {
      platformHonorsMode = true;
    }
    if (!platformHonorsMode) {
      try { fs.chmodSync(unreadable, 0o644); } catch { /* best effort */ }
      return; // platform ignores POSIX mode (e.g. Windows as non-admin) — skip
    }
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    const violations = scanStressIsolation({ dir });
    expect(violations.some((v) => v.file === "modules/locked.js" && v.msg.startsWith("cannot read stress file"))).toBe(true);
    // Restore so afterEach rmSync can clean up.
    try { fs.chmodSync(unreadable, 0o644); } catch { /* best effort */ }
  });

  it("nested directory read failure is preserved even when no regular files are discovered", () => {
    // The empty-directory fallback must NOT discard a more precise nested-
    // read finding. Build a tree where the only scannable nested subdir is
    // unreadable; the result should be the nested violation, not the
    // generic "no scannable stress files" message.
    //
    // Same platform caveat as above: chmod may not deny reads on Windows.
    const nestedDir = path.join(dir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    try {
      fs.chmodSync(nestedDir, 0o000);
    } catch (err) {
      if (err.code !== "EPERM") throw err;
      return;
    }
    // Probe platform behavior.
    let platformHonorsMode = false;
    try {
      fs.readdirSync(nestedDir);
    } catch {
      platformHonorsMode = true;
    }
    if (!platformHonorsMode) {
      try { fs.chmodSync(nestedDir, 0o755); } catch { /* best effort */ }
      return;
    }
    const violations = scanStressIsolation({ dir });
    try { fs.chmodSync(nestedDir, 0o755); } catch { /* best effort */ }
    const msgs = violations.map((v) => v.msg);
    expect(msgs.some((m) => m.startsWith("cannot read") && m.includes("nested"))).toBe(true);
  });

  it("module file with raw mutating fetch is detected (regression for the modules-bypass path)", () => {
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "evil.js", `
      fetch("http://x/api", { method: "POST", body: "{}" });
    `);
    // Need a clean .test.js so the directory isn't empty-fail.
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    const violations = scanStressIsolation({ dir });
    expect(violations.some((v) => v.file === "modules/evil.js" && v.msg.includes("raw mutating"))).toBe(true);
  });

  it("module file with forbidden time tokens is detected (determinism contract)", () => {
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "bad.js", `
      const t = Date.now();
      setTimeout(() => {}, 100);
    `);
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    const violations = scanStressIsolation({ dir });
    const badMsgs = violations.filter((v) => v.file === "modules/bad.js").map((v) => v.msg);
    expect(badMsgs.some((m) => m.includes("Date.now"))).toBe(true);
    expect(badMsgs.some((m) => m.includes("setTimeout"))).toBe(true);
  });

  it("module files are subject to the same legacy-helper ban as test files", () => {
    // The contracted-API ban applies to every scannable file: a modules/ file
    // using apiBurstOperation is just as much a contract bypass as a test
    // file doing so. P2 modules produce scripted outcomes, not real fetches,
    // so they have no legitimate reason to call the legacy helpers.
    fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
    writeFile(path.join(dir, "modules"), "adapter.js", `
      import { apiBurstOperation } from "../helpers.js";
      export function read(path) { return apiBurstOperation(path, { method: "GET" }); }
    `);
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    const violations = scanStressIsolation({ dir });
    expect(violations.some((v) => v.file === "modules/adapter.js" && v.msg.includes("apiContractedOperation"))).toBe(true);
  });

  it("real stress tree: modules/scenario-harness.js is discovered and clean", () => {
    const __filename_real = fileURLToPath(import.meta.url);
    const __dirname_real = path.dirname(__filename_real);
    // tests/unit/stress-isolation-gate.test.js → tests/stress/ (one level up)
    const stressRoot = path.resolve(__dirname_real, "../stress");
    const found = collectStressIsolationFiles(stressRoot).map((c) => c.rel);
    expect(found).toContain("modules/scenario-harness.js");
    // The full scan against the real tree is clean.
    expect(scanStressIsolation({ dir: stressRoot })).toEqual([]);
  });
});

// ─── Dockerfile uniqueness gate ───────────────────────────────────────────

describe("Dockerfile uniqueness gate", () => {
  let dir;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("clean tree with known Dockerfiles passes", () => {
    writeFile(dir, "Dockerfile", "FROM node:20");
    const known = new Set(["Dockerfile"]);
    expect(scanDockerfiles(dir, known)).toEqual([]);
  });

  it("unknown Dockerfile in packages/web is detected", () => {
    fs.mkdirSync(path.join(dir, "packages", "web"), { recursive: true });
    writeFile(path.join(dir, "packages", "web"), "Dockerfile", "FROM node:20");
    const known = new Set(["Dockerfile"]);
    const violations = scanDockerfiles(dir, known);
    expect(violations.some(v => v.file === "packages/web/Dockerfile")).toBe(true);
  });

  it("Dockerfile.dev variant is detected", () => {
    writeFile(dir, "Dockerfile.dev", "FROM node:20");
    const known = new Set(["Dockerfile"]);
    const violations = scanDockerfiles(dir, known);
    expect(violations.some(v => v.file === "Dockerfile.dev")).toBe(true);
  });

  it("Dockerfile.prod variant is detected", () => {
    writeFile(dir, "Dockerfile.prod", "FROM node:20");
    const known = new Set(["Dockerfile"]);
    const violations = scanDockerfiles(dir, known);
    expect(violations.some(v => v.file === "Dockerfile.prod")).toBe(true);
  });

  it("nested unknown Dockerfile is detected", () => {
    fs.mkdirSync(path.join(dir, "deep", "nested"), { recursive: true });
    writeFile(path.join(dir, "deep", "nested"), "Dockerfile.legacy", "FROM node:20");
    const known = new Set();
    const violations = scanDockerfiles(dir, known);
    expect(violations.some(v => v.file === "deep/nested/Dockerfile.legacy")).toBe(true);
  });

  it("lowercase dockerfile.local is detected (case-insensitive)", () => {
    writeFile(dir, "dockerfile.local", "FROM node:20");
    const known = new Set();
    const violations = scanDockerfiles(dir, known);
    expect(violations.some(v => v.file === "dockerfile.local")).toBe(true);
  });

  it(".dockerignore is NOT detected (excluded by pattern)", () => {
    writeFile(dir, ".dockerignore", "node_modules");
    const known = new Set();
    expect(scanDockerfiles(dir, known)).toEqual([]);
  });

  it("node_modules and .git directories are skipped", () => {
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFile(path.join(dir, "node_modules", "pkg"), "Dockerfile", "FROM node:20");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFile(dir + "/.git", "Dockerfile", "FROM node:20");
    const known = new Set();
    expect(scanDockerfiles(dir, known)).toEqual([]);
  });

  it("unreadable directory fails closed", () => {
    const violations = scanDockerfiles("/nonexistent/path");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].msg).toContain("cannot read");
  });
});

// ─── Compose Dockerfile target validation ────────────────────────────────

describe("Compose Dockerfile target validation", () => {
  let dir;
  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeYaml(name, content) {
    fs.writeFileSync(path.join(dir, name), content);
  }

  it("root context + root Dockerfile passes", () => {
    writeYaml("docker-compose.build.yml", `
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
`);
    writeFile(dir, "Dockerfile", "FROM node:20");
    const v = validateComposeDockerfiles(dir, "docker-compose.build.yml");
    expect(v).toEqual([]);
  });

  it("package context + package Dockerfile passes", () => {
    fs.mkdirSync(path.join(dir, "packages", "bot"), { recursive: true });
    writeYaml("docker-compose.build.yml", `
services:
  bot:
    build:
      context: packages/bot
      dockerfile: Dockerfile
`);
    writeFile(path.join(dir, "packages", "bot"), "Dockerfile", "FROM node:20");
    const v = validateComposeDockerfiles(dir, "docker-compose.build.yml");
    expect(v).toEqual([]);
  });

  it("missing Compose target fails", () => {
    writeYaml("docker-compose.build.yml", `
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
`);
    // No Dockerfile created
    const v = validateComposeDockerfiles(dir, "docker-compose.build.yml");
    expect(v.some(x => x.msg.includes("does not exist"))).toBe(true);
  });

  it("deleted allowlisted target fails (verifyKnownDockerfilesExist)", () => {
    const known = new Set(["Dockerfile", "packages/bot/Dockerfile"]);
    // Only create root Dockerfile, not packages/bot/Dockerfile
    writeFile(dir, "Dockerfile", "FROM node:20");
    const v = verifyKnownDockerfilesExist(dir, known);
    expect(v.some(x => x.file === "packages/bot/Dockerfile")).toBe(true);
  });

  it("../ path escaping repository fails", () => {
    writeYaml("docker-compose.build.yml", `
services:
  evil:
    build:
      context: ../../../etc
      dockerfile: Dockerfile
`);
    const v = validateComposeDockerfiles(dir, "docker-compose.build.yml");
    expect(v.some(x => x.msg.includes("escapes the repository"))).toBe(true);
  });

  it("unreadable Compose file fails closed", () => {
    const v = validateComposeDockerfiles(dir, "nonexistent.yml");
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].msg).toContain("cannot read");
  });

  it("current repository topology passes", () => {
    // Run against the real repo (docker-compose.build.yml exists)
    const __filename_real = fileURLToPath(import.meta.url);
    const __dirname_real = path.dirname(__filename_real);
    const repoRoot = path.resolve(__dirname_real, "../../../..");
    const v = validateComposeDockerfiles(repoRoot, "docker-compose.build.yml");
    expect(v).toEqual([]);
  });

  it("current repository known Dockerfiles all exist", () => {
    const __filename_real = fileURLToPath(import.meta.url);
    const __dirname_real = path.dirname(__filename_real);
    const repoRoot = path.resolve(__dirname_real, "../../../..");
    const v = verifyKnownDockerfilesExist(repoRoot);
    expect(v).toEqual([]);
  });
});
