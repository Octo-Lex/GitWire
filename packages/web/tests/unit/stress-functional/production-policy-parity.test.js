// tests/unit/stress-functional/production-policy-parity.test.js
//
// Fail-closed static source-parity guard. Reads production source files as
// TEXT (without importing them — the production modules have side-effect
// imports like redis/db/logger that cannot load in the test tree) and verifies:
//   1. classifyError in githubRateLimit.js contains the exact reason strings
//      in the correct case branches (per-status, not loose substring).
//   2. BLOCKED_REASONS in actionStateMachine.js has EXACT set equality with
//      the adapter's ACTION_BLOCKED_REASONS (no fallback to substring).
//   3. create-queue.js attempts/backoff values match PRODUCTION_QUEUE_RETRY_DEFAULTS.
//   4. The test-tree adapter modules import nothing from production code.
//
// All checks fail closed: extraction failures and missing values cause the
// test to fail — never a permissive fallback to substring containment.

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_ERROR_REASONS,
  ACTION_BLOCKED_REASONS,
  PRODUCTION_QUEUE_RETRY_DEFAULTS,
} from "../../stress/modules/retry-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve production source paths from the test file location:
// tests/unit/stress-functional/ → ../../../src/ (web/src/)
const WEB_ROOT = path.resolve(__dirname, "../../.."); // packages/web/
const SRC_DIR = path.join(WEB_ROOT, "src");            // packages/web/src/
const REPO_ROOT = path.resolve(__dirname, "../../../../.."); // repo root

function readSource(relPath) {
  const abs = path.join(SRC_DIR, relPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`parity test (fail-closed): production source not found: ${relPath} (resolved: ${abs})`);
  }
  return fs.readFileSync(abs, "utf8");
}

// Extract the body of `export function classifyError(...) { ... }` from the
// production githubRateLimit.js source. Fail-closed: throws if the function
// cannot be located or if braces do not balance.
function extractClassifyErrorBody(source) {
  const startMatch = source.match(/export\s+function\s+classifyError\s*\([^)]*\)\s*\{/);
  if (!startMatch) {
    throw new Error("parity test (fail-closed): could not locate 'export function classifyError' in githubRateLimit.js");
  }
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = startIdx;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error("parity test (fail-closed): classifyError braces did not balance");
  }
  return source.slice(startIdx, i - 1);
}

// Extract a single case branch from a switch body. Returns null if the case
// label is not found. Callers must assert non-null (fail-closed).
function extractCaseBranch(funcBody, caseLabel) {
  const caseRegex = new RegExp(`case\\s+${caseLabel}\\s*:`);
  const startMatch = funcBody.match(caseRegex);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = funcBody.slice(startIdx);
  const nextBranch = rest.match(/\b(?:case\s+\d+\s*:|default\s*:)/);
  const endIdx = nextBranch ? nextBranch.index : rest.length;
  return rest.slice(0, endIdx);
}

function extractDefaultBranch(funcBody) {
  const startMatch = funcBody.match(/default\s*:/);
  if (!startMatch) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  return funcBody.slice(startIdx);
}

// Extract all BLOCKED_REASONS values from actionStateMachine.js. Walks the
// Object.freeze({ ... }) block and collects every KEY: "value" pair.
// Fail-closed: throws if the block cannot be located, braces don't balance,
// or zero values are extracted.
function extractBlockedReasonsValues(source) {
  const startMatch = source.match(/BLOCKED_REASONS\s*=\s*Object\.freeze\s*\(\s*\{/);
  if (!startMatch) {
    throw new Error("parity test (fail-closed): could not locate 'BLOCKED_REASONS = Object.freeze({' in actionStateMachine.js");
  }
  const startIdx = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = startIdx;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error("parity test (fail-closed): BLOCKED_REASONS braces did not balance");
  }
  const body = source.slice(startIdx, i - 1);
  const values = new Set();
  const pairRe = /\b([A-Z_]+)\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = pairRe.exec(body)) !== null) {
    values.add(m[2]);
  }
  if (values.size === 0) {
    throw new Error("parity test (fail-closed): extracted 0 BLOCKED_REASONS values — source parse failure");
  }
  return values;
}

// Parse attempts and backoff { type, delay } from create-queue.js.
// Fail-closed: throws if the values cannot be located.
function extractQueueDefaults(source) {
  const attemptsMatch = source.match(/attempts\s*:\s*(\d+)\s*,/);
  if (!attemptsMatch) {
    throw new Error("parity test (fail-closed): could not find 'attempts: <number>' in create-queue.js");
  }
  const backoffMatch = source.match(/backoff\s*:\s*\{\s*type\s*:\s*"([^"]+)"\s*,\s*delay\s*:\s*([\d_]+)\s*\}/);
  if (!backoffMatch) {
    throw new Error("parity test (fail-closed): could not find 'backoff: { type, delay }' in create-queue.js");
  }
  return {
    attempts: parseInt(attemptsMatch[1], 10),
    backoffType: backoffMatch[1],
    delay: parseInt(backoffMatch[2].replace(/_/g, ""), 10),
  };
}

// ─── classifyError exact arm-reason parity (fail-closed) ──────────────────

describe("production-policy-parity — classifyError exact arms (fail-closed)", () => {
  const source = readSource("services/githubRateLimit.js");
  const body = extractClassifyErrorBody(source);

  it("classifyError body was successfully extracted (non-empty, contains switch)", () => {
    expect(typeof body).toBe("string");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("switch");
  });

  // Extract all case labels from the switch body as a sorted array.
  function extractCaseLabels(switchBody) {
    const labels = [];
    const re = /\bcase\s+(\d+)\s*:/g;
    let m;
    while ((m = re.exec(switchBody)) !== null) {
      labels.push(parseInt(m[1], 10));
    }
    // Check for 'default:' presence.
    const hasDefault = /\bdefault\s*:/.test(switchBody);
    return { labels: labels.sort((a, b) => a - b), hasDefault };
  }

  it("exact case-label multiset: [401, 403, 404, 422, 429] + default — no extras, no missing", () => {
    const { labels, hasDefault } = extractCaseLabels(body);
    expect(labels).toEqual([401, 403, 404, 422, 429]);
    expect(hasDefault).toBe(true);
  });

  // Extract all quoted reason strings from the entire function body.
  function extractAllReasons(switchBody) {
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(switchBody)) !== null) {
      reasons.add(m[1]);
    }
    return reasons;
  }

  it("union of extracted production reasons exactly equals GITHUB_ERROR_REASONS values", () => {
    const productionReasons = extractAllReasons(body);
    const adapterReasons = new Set(Object.values(GITHUB_ERROR_REASONS));
    // Bidirectional: no adapter reason missing from production, no production
    // reason missing from adapter.
    expect([...adapterReasons].sort()).toEqual([...productionReasons].sort());
  });

  it("401 arm contains exactly 'token_invalid'", () => {
    const arm = extractCaseBranch(body, "401");
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["token_invalid"]);
  });

  it("403 arm contains exactly 'rate_exhausted' and 'forbidden'", () => {
    const arm = extractCaseBranch(body, "403");
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["forbidden", "rate_exhausted"]);
  });

  it("404 arm contains exactly 'not_found'", () => {
    const arm = extractCaseBranch(body, "404");
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["not_found"]);
  });

  it("422 arm contains exactly 'validation_error'", () => {
    const arm = extractCaseBranch(body, "422");
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["validation_error"]);
  });

  it("429 arm contains exactly 'rate_limited_retry_after' and 'rate_limited'", () => {
    const arm = extractCaseBranch(body, "429");
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["rate_limited", "rate_limited_retry_after"]);
  });

  it("default arm contains exactly 'server_error' and 'unknown'", () => {
    const arm = extractDefaultBranch(body);
    expect(arm).not.toBeNull();
    const reasons = new Set();
    const re = /reason\s*:\s*"([a-z_]+)"/g;
    let m;
    while ((m = re.exec(arm)) !== null) reasons.add(m[1]);
    expect([...reasons].sort()).toEqual(["server_error", "unknown"]);
  });
});

// ─── BLOCKED_REASONS exact set equality (fail-closed) ──────────────────────

describe("production-policy-parity — BLOCKED_REASONS exact set (fail-closed)", () => {
  const source = readSource("services/actionStateMachine.js");

  it("adapter set exactly equals production set — no extras, no missing, no substring fallback", () => {
    const productionValues = extractBlockedReasonsValues(source);
    const adapterValues = new Set(Object.values(ACTION_BLOCKED_REASONS));

    // Fail-closed guards: both sets must be non-empty before we compare.
    expect(productionValues.size).toBeGreaterThan(0);
    expect(adapterValues.size).toBeGreaterThan(0);

    // Exact set equality — sorted arrays must match element-for-element.
    const prodSorted = [...productionValues].sort();
    const adapterSorted = [...adapterValues].sort();
    expect(adapterSorted).toEqual(prodSorted);
  });
});

// ─── create-queue.js parsed values match adapter defaults (fail-closed) ────

describe("production-policy-parity — queue retry defaults (fail-closed)", () => {
  const queuePath = path.join(REPO_ROOT, "packages/runtime/src/create-queue.js");
  if (!fs.existsSync(queuePath)) {
    throw new Error(`parity test (fail-closed): create-queue.js not found at ${queuePath}`);
  }
  const queueSource = fs.readFileSync(queuePath, "utf8");

  it("maxAttempts, initialBackoffMs, and backoffType match create-queue.js exactly", () => {
    const parsed = extractQueueDefaults(queueSource);
    expect(parsed.attempts).toBe(PRODUCTION_QUEUE_RETRY_DEFAULTS.maxAttempts);
    expect(parsed.delay).toBe(PRODUCTION_QUEUE_RETRY_DEFAULTS.initialBackoffMs);
    expect(parsed.backoffType).toBe(PRODUCTION_QUEUE_RETRY_DEFAULTS.backoffType);
  });
});

// ─── No production imports in the adapter modules (fail-closed) ────────────

describe("production-policy-parity — no production imports (fail-closed)", () => {
  const FORBIDDEN = ["services/", "packages/runtime", "../lib/", "../../src/", "../../lib/"];

  function importLinesOf(moduleRelPath) {
    const abs = path.resolve(__dirname, moduleRelPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`parity test (fail-closed): adapter module not found: ${moduleRelPath} (resolved: ${abs})`);
    }
    const src = fs.readFileSync(abs, "utf8");
    return src.split("\n").filter((l) => l.startsWith("import "));
  }

  it("retry-policy.js has no production imports", () => {
    const importLines = importLinesOf("../../stress/modules/retry-policy.js");
    for (const line of importLines) {
      for (const forbidden of FORBIDDEN) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it("backpressure.js has no production imports", () => {
    const importLines = importLinesOf("../../stress/modules/backpressure.js");
    for (const line of importLines) {
      for (const forbidden of FORBIDDEN) {
        expect(line).not.toContain(forbidden);
      }
    }
  });
});
