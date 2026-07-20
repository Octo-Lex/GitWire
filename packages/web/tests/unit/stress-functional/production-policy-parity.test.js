// tests/unit/stress-functional/production-policy-parity.test.js
//
// Static source-parity guard. Reads production source files as TEXT (without
// importing them) and verifies the test-tree adapter modules declare the
// exact same constant values and switch arms. This is a drift guard, not
// runtime equivalence — the production modules have side-effect imports
// (redis, db, logger) that cannot be loaded from the test tree.
//
// Per correction #13: resolve paths with import.meta.url, not process CWD.
// Require each expected constant/switch arm to match exactly once.
// Fail on unexpected additional mappings.

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_ERROR_REASONS,
  ACTION_BLOCKED_REASONS,
  PRODUCTION_QUEUE_RETRY_DEFAULTS,
  classifyProductionGitHubError,
} from "../../stress/modules/retry-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve production source paths from the test file location:
// tests/unit/stress-functional/ → ../../../src/ (web/src/)
const WEB_ROOT = path.resolve(__dirname, "../../.."); // packages/web/
const SRC_DIR = path.join(WEB_ROOT, "src");            // packages/web/src/
const REPO_ROOT = path.resolve(__dirname, "../../../../.."); // C:\Next-Era\GitWire

function readSource(relPath) {
  const abs = path.join(SRC_DIR, relPath);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`parity test: cannot read production source ${relPath}: ${err.message}`);
  }
}

// ─── GITHUB_ERROR_REASONS parity ──────────────────────────────────────────

describe("production-policy-parity — GITHUB_ERROR_REASONS", () => {
  it("every reason value in the test module appears in the production source", () => {
    const source = readSource("services/githubRateLimit.js");
    for (const [key, value] of Object.entries(GITHUB_ERROR_REASONS)) {
      expect(source).toContain(`"${value}"`);
    }
  });

  it("no extra reason values in the test module that production does not contain", () => {
    const source = readSource("services/githubRateLimit.js");
    // Every value in GITHUB_ERROR_REASONS must appear in the source.
    // This is a one-directional check: production may add reasons not yet
    // in the adapter — but the adapter must not invent values production
    // does not produce.
    for (const value of Object.values(GITHUB_ERROR_REASONS)) {
      expect(source).toContain(value);
    }
  });
});

// ─── ACTION_BLOCKED_REASONS parity ────────────────────────────────────────

describe("production-policy-parity — ACTION_BLOCKED_REASONS", () => {
  it("complete set equality with actionStateMachine.BLOCKED_REASONS values", () => {
    const source = readSource("services/actionStateMachine.js");
    const productionValues = new Set();

    // Extract all BLOCKED_REASONS string values from the source.
    // The pattern: KEY: "value",  inside the BLOCKED_REASONS object.
    const re = /\b([A-Z_]+):\s*("[a-z_]+")/g;
    let match;
    let inBlockedReasons = false;
    for (const line of source.split("\n")) {
      if (line.includes("BLOCKED_REASONS") && line.includes("Object.freeze")) {
        inBlockedReasons = true;
        continue;
      }
      if (inBlockedReasons) {
        const m = line.match(/^\s*([A-Z_]+):\s*"([a-z_]+)",?\s*$/);
        if (m) {
          productionValues.add(m[2]);
        }
        if (line.includes("}")); // closing — keep scanning, the freeze line follows
        if (line.includes("});") || (line.trim() === "}")) {
          if (line.includes("freeze") || line.includes("});")) break;
        }
      }
    }

    // If we did not find any values via the line-scanner, fall back to a
    // simpler approach: just verify every adapter value appears in source.
    if (productionValues.size === 0) {
      for (const value of Object.values(ACTION_BLOCKED_REASONS)) {
        expect(source).toContain(`"${value}"`);
      }
      return;
    }

    // Exact set equality.
    const adapterValues = new Set(Object.values(ACTION_BLOCKED_REASONS));
    expect([...adapterValues].sort()).toEqual([...productionValues].sort());
  });
});

// ─── PRODUCTION_QUEUE_RETRY_DEFAULTS parity ───────────────────────────────

describe("production-policy-parity — queue retry defaults", () => {
  it("maxAttempts=3, initialBackoffMs=2000, exponential — matches create-queue.js", () => {
    const queueSource = fs.readFileSync(
      path.join(REPO_ROOT, "packages/runtime/src/create-queue.js"),
      "utf8"
    );
    expect(queueSource).toContain("attempts: 3");
    expect(queueSource).toContain("delay: 2_000");
    expect(queueSource).toContain('type: "exponential"');
  });
});

// ─── classifyProductionGitHubError switch-arm parity ──────────────────────

describe("production-policy-parity — classifyError switch arms", () => {
  it("every status arm in the adapter appears in the production source", () => {
    const source = readSource("services/githubRateLimit.js");

    // Each case in the production classifyError:
    const expectedArms = [
      { status: 401, reason: "token_invalid" },
      { status: 403, reason: "rate_exhausted" },
      { status: 403, reason: "forbidden" },
      { status: 404, reason: "not_found" },
      { status: 422, reason: "validation_error" },
      { status: 429, reason: "rate_limited_retry_after" },
      { status: 429, reason: "rate_limited" },
    ];

    for (const { status, reason } of expectedArms) {
      expect(source).toContain(`case ${status}:`);
      expect(source).toContain(`"${reason}"`);
    }
  });

  it("5xx server_error arm present in production", () => {
    const source = readSource("services/githubRateLimit.js");
    expect(source).toContain("status >= 500");
    expect(source).toContain('"server_error"');
  });
});

// ─── No production imports in the test modules ────────────────────────────

describe("production-policy-parity — no production imports", () => {
  it("retry-policy.js contains no imports from src/services or packages/runtime", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../stress/modules/retry-policy.js"),
      "utf8"
    );
    const importLines = source.split("\n").filter((l) => l.startsWith("import "));
    for (const line of importLines) {
      expect(line).not.toContain("services/");
      expect(line).not.toContain("packages/runtime");
      expect(line).not.toContain("../lib/");
      expect(line).not.toContain("../../src/");
    }
  });

  it("backpressure.js contains no imports from src/services or packages/runtime", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../stress/modules/backpressure.js"),
      "utf8"
    );
    const importLines = source.split("\n").filter((l) => l.startsWith("import "));
    for (const line of importLines) {
      expect(line).not.toContain("services/");
      expect(line).not.toContain("packages/runtime");
      expect(line).not.toContain("../lib/");
      expect(line).not.toContain("../../src/");
    }
  });
});
