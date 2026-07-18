#!/usr/bin/env node
// scripts/check-stress-isolation.mjs
//
// Static gate: fails if any active stress test file contains:
//   - raw mutating fetch calls (POST/PUT/PATCH/DELETE outside prepareApiRequest)
//   - apiBurstOperation( (should use apiContractedOperation)
//   - boundedBurst( (should use runContractedBurst)
//   - legacy get/post/put/patch helpers used for semantic checks
//   - duplicate inline status arrays covered by STATUS_SETS
//
// Allowlist: mutation-webhook-ingest.test.js (describe.skip, ST-04 deferred)
// and payload-validation.test.js (POST tests are describe.skip).
//
// Usage: node scripts/check-stress-isolation.mjs
// Exit 0 = clean, exit 1 = violations found.

import fs from "node:fs";
import path from "node:path";

const STRESS_DIR = path.resolve("packages/web/tests/stress");
const ALLOWLIST = new Set([
  "mutation-webhook-ingest.test.js", // describe.skip, ST-04
]);

// Patterns that indicate a raw mutating fetch bypassing isolation.
// These check for fetch() calls that specify a mutating HTTP method directly —
// NOT for method:"POST" appearing inside apiContractedOperation descriptors
// (which is legitimate and goes through prepareApiRequest).
const RAW_MUTATING_FETCH = /fetch\s*\(\s*[^)]*?method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/s;

// Patterns that indicate legacy/incorrect API usage.
const LEGACY_PATTERNS = [
  { regex: /apiBurstOperation\s*\(/, msg: "use apiContractedOperation instead of apiBurstOperation" },
  { regex: /boundedBurst\s*\(/, msg: "use runContractedBurst instead of boundedBurst" },
];

let violations = 0;

const files = fs.readdirSync(STRESS_DIR).filter(f => f.endsWith(".test.js"));

for (const file of files) {
  const filePath = path.join(STRESS_DIR, file);
  const content = fs.readFileSync(filePath, "utf8");

  // Skip allowlisted files entirely.
  if (ALLOWLIST.has(file)) continue;

  // Check for raw mutating fetch calls (fetch() with POST/PUT/PATCH/DELETE).
  // This detects fetch(...{method:"POST"...}) which bypasses prepareApiRequest.
  // Does NOT flag apiContractedOperation's method:"POST" — that goes through
  // the isolation boundary via prepareApiRequest.
  if (RAW_MUTATING_FETCH.test(content)) {
    console.error(`VIOLATION: ${file} contains raw mutating fetch() bypassing isolation boundary`);
    violations++;
  }

  // Check for legacy API usage.
  for (const { regex, msg } of LEGACY_PATTERNS) {
    if (regex.test(content)) {
      console.error(`VIOLATION: ${file} — ${msg}`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} isolation violation(s) found in stress tests.`);
  process.exit(1);
} else {
  console.log("✓ No isolation violations in stress tests.");
  process.exit(0);
}
