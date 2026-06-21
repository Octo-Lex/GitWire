// tests/unit/triage-pr-guards.test.js
// Regression tests: Verify source code has required guard patterns.
// These are structural tests that scan source files for required code patterns.
// They catch regressions where guards are accidentally removed during refactoring.

import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";

import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

function extractFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1) return "";
  return source.slice(start, end);
}

describe("PR Triage Guard Pipeline (regression)", () => {
  const source = readSource("packages/web/src/workers/triageWorker.js");
  const triagePR = extractFunction(source, "async function triagePR", "// ── Prompt builders");

  it("has idempotency guard (checkAndMark)", () => {
    expect(triagePR).toMatch(/checkAndMark/);
  });

  it("has pillar enabled check (isPillarEnabled)", () => {
    expect(triagePR).toMatch(/isPillarEnabled.*triage/);
  });

  it("has trigger filter (shouldTrigger)", () => {
    expect(triagePR).toMatch(/shouldTrigger/);
  });

  it("has policy waiver check (isWaived)", () => {
    expect(triagePR).toMatch(/isWaived/);
  });

  it("has dry-run support (isDryRun)", () => {
    expect(triagePR).toMatch(/isDryRun/);
  });

  it("has decision logging (logDecision)", () => {
    expect(triagePR).toMatch(/logDecision/);
  });

  it("logs with correct target type (pr, not issue)", () => {
    expect(triagePR).toMatch(/targetType:\s*"pr"/);
    expect(triagePR).not.toMatch(/targetType:\s*"issue"/);
  });

  it("uses action lifecycle (propose/approve/execute/succeed)", () => {
    expect(triagePR).toMatch(/propose/);
    expect(triagePR).toMatch(/approve/);
    expect(triagePR).toMatch(/execute/);
    expect(triagePR).toMatch(/succeed/);
  });
});

describe("Auth: no query-string API key (regression)", () => {
  it("auth.js does not reference req.query.api_key", () => {
    const source = readSource("packages/web/src/middleware/auth.js");
    expect(source).not.toMatch(/req\.query.*api_key/);
    expect(source).not.toMatch(/\?api_key/);
  });

  it("rateLimiter.js does not reference req.query.api_key", () => {
    const source = readSource("packages/web/src/middleware/rateLimiter.js");
    expect(source).not.toMatch(/req\.query.*api_key/);
  });
});

describe("Cookie: environment-aware Secure flag (regression)", () => {
  it("auth route uses NODE_ENV check for Secure flag", () => {
    const source = readSource("packages/web/src/routes/auth.js");
    expect(source).toMatch(/NODE_ENV.*production.*Secure/);
  });
});

describe("Version consistency (regression)", () => {
  it("core VERSION matches root package.json", () => {
    const pkg = JSON.parse(readSource("package.json"));
    const buildInfo = readSource("packages/core/src/buildInfo.js");
    const match = buildInfo.match(/version:\s*"([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match[1]).toBe(pkg.version);
  });

  it("package-lock.json version matches root package.json", () => {
    const pkg = JSON.parse(readSource("package.json"));
    const lock = JSON.parse(readSource("package-lock.json"));
    expect(lock.version).toBe(pkg.version);
  });
});

describe("Docker hardening (regression)", () => {
  it("docker-compose requires DB_PASSWORD (no changeme default)", () => {
    const source = readSource("docker-compose.yml");
    expect(source).not.toMatch(/DB_PASSWORD:-changeme/);
    expect(source).toMatch(/DB_PASSWORD:\?/);
  });

  it("Dockerfile uses strict npm ci (no fallback)", () => {
    const source = readSource("Dockerfile");
    expect(source).not.toMatch(/npm ci.*\|\|.*npm install/);
  });
});
