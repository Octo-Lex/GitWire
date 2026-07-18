#!/usr/bin/env node
// scripts/check-stress-isolation.mjs
//
// Static gate: fails if any active stress test file contains prohibited
// constructs. Exported as a pure function for unit testing.
//
// Usage: node scripts/check-stress-isolation.mjs
// Exit 0 = clean, exit 1 = violations found.

import fs from "node:fs";
import path from "node:path";

const STRESS_DIR_DEFAULT = path.resolve("packages/web/tests/stress");

// No default allowlist. Every stress file is scanned. The ST-04 webhook
// file contains only describe.skip with no executable prohibited constructs,
// so it passes the gate naturally without special treatment.

const RAW_MUTATING_FETCH = /fetch\s*\(\s*[^)]*?method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/s;

const LEGACY_PATTERNS = [
  { regex: /apiBurstOperation\s*\(/, msg: "use apiContractedOperation instead of apiBurstOperation" },
  { regex: /boundedBurst\s*\(/, msg: "use runContractedBurst instead of boundedBurst" },
  { regex: /await\s+(get|post|put|patch|del)\s*\(/, msg: "legacy helper used for semantic check — use runContractedOperation instead" },
  { regex: /\[\s*200\s*,\s*\d{3}/, msg: "inline status array — use STATUS_SETS constant instead" },
];

/**
 * Scan stress test files for prohibited constructs.
 * Pure function — takes a directory and allowlist, returns violations.
 * Fails closed: a missing or unreadable directory is a structural violation.
 *
 * @param {Object} opts
 * @param {string} [opts.dir] stress test directory
 * @param {Set<string>} [opts.allowlist] allowlisted filenames
 * @returns {Array<{file: string, msg: string}>} violations
 */
export function scanStressIsolation(opts = {}) {
  const dir = opts.dir || STRESS_DIR_DEFAULT;
  const allowlist = opts.allowlist || new Set();
  const violations = [];

  // Fail closed: if the stress directory cannot be read, that is a structural
  // violation, not a clean result.
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith(".test.js"));
  } catch (err) {
    return [{ file: "(directory)", msg: `cannot read stress directory ${dir}: ${err.message}` }];
  }

  // If the directory exists but contains no test files, that is also suspicious.
  if (files.length === 0) {
    return [{ file: "(directory)", msg: `stress directory ${dir} contains no .test.js files` }];
  }

  for (const file of files) {
    if (allowlist.has(file)) continue;
    const content = fs.readFileSync(path.join(dir, file), "utf8");

    if (RAW_MUTATING_FETCH.test(content)) {
      violations.push({ file, msg: "contains raw mutating fetch() bypassing isolation boundary" });
    }
    for (const { regex, msg } of LEGACY_PATTERNS) {
      if (regex.test(content)) {
        violations.push({ file, msg });
      }
    }
  }
  return violations;
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-stress-isolation.mjs")) {
  const violations = scanStressIsolation();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`VIOLATION: ${v.file} — ${v.msg}`);
    }
    console.error(`\n${violations.length} isolation violation(s) found.`);
    process.exit(1);
  } else {
    console.log("✓ No isolation violations in stress tests.");
    process.exit(0);
  }
}
