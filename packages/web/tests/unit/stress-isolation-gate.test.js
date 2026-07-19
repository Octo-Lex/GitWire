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
import { scanStressIsolation, scanDockerfiles } from "../../../../scripts/check-stress-isolation.mjs";

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

  it("directory with no .test.js files fails closed", () => {
    writeFile(dir, "helper.js", `const x = 1;`);
    const violations = scanStressIsolation({ dir });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].msg).toContain("no .test.js files");
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

  it("non-.test.js files are ignored", () => {
    writeFile(dir, "helper.js", `apiBurstOperation("/api/repos");`);
    // Need at least one .test.js file for the directory to be valid
    writeFile(dir, "clean.test.js", CLEAN_FILE);
    expect(scanStressIsolation({ dir })).toEqual([]);
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
