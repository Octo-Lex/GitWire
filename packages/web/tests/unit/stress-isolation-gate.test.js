// tests/unit/stress-isolation-gate.test.js
//
// Negative tests for the stress-isolation static gate.
// Proves each detector fails when its prohibited construct is introduced,
// and that a clean contracted fixture + allowlist behave correctly.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanStressIsolation } from "../../../../scripts/check-stress-isolation.mjs";

// Each test creates a temp directory with synthetic stress files, then scans it.
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stress-gate-test-"));
  return dir;
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

// Clean contracted fixture: uses runContractedBurst + STATUS_SETS, no legacy.
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
    const violations = scanStressIsolation({ dir });
    expect(violations).toEqual([]);
  });

  it("raw POST fetch is detected", () => {
    writeFile(dir, "bad.test.js", `
      fetch("http://x/api", { method: "POST", body: "{}" });
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("raw mutating"))).toBe(true);
  });

  it("apiBurstOperation is detected", () => {
    writeFile(dir, "bad.test.js", `
      apiBurstOperation("/api/repos", { kind: "read" });
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("apiContractedOperation"))).toBe(true);
  });

  it("boundedBurst is detected", () => {
    writeFile(dir, "bad.test.js", `
      boundedBurst(tasks, { maxConcurrent: 2 });
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("runContractedBurst"))).toBe(true);
  });

  it("await get() legacy helper is detected", () => {
    writeFile(dir, "bad.test.js", `
      const res = await get("/api/repos");
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("legacy helper"))).toBe(true);
  });

  it("await post() legacy helper is detected", () => {
    writeFile(dir, "bad.test.js", `
      const res = await post("/api/enforcement/policies", {});
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("legacy helper"))).toBe(true);
  });

  it("inline status array [200, 429] is detected", () => {
    writeFile(dir, "bad.test.js", `
      expectedStatuses: [200, 429],
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations.some(v => v.msg.includes("inline status array"))).toBe(true);
  });

  it("allowlisted files are skipped entirely", () => {
    writeFile(dir, "skipped.test.js", `
      apiBurstOperation("/api/repos");
      boundedBurst([]);
      await get("/x");
      fetch("http://x", { method: "POST" });
      [200, 429]
    `);
    const violations = scanStressIsolation({ dir, allowlist: new Set(["skipped.test.js"]) });
    expect(violations).toEqual([]);
  });

  it("non-.test.js files are ignored", () => {
    writeFile(dir, "helper.js", `
      apiBurstOperation("/api/repos");
    `);
    const violations = scanStressIsolation({ dir });
    expect(violations).toEqual([]);
  });
});
