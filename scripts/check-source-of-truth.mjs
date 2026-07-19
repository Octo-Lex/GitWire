#!/usr/bin/env node
// scripts/check-source-of-truth.mjs
//
// Validates that the source-of-truth marker contract in each governed
// document matches the implementation-derived runtime identities.
//
// Two enforcement layers:
//   1. STRUCTURAL — every governed doc carries exactly one well-formed
//      marker whose JSON conforms to SourceTruthContract (schemaVersion 1).
//      Delegated to scripts/parse-source-truth.mjs.
//   2. IDENTITY — each marker value is compared against identities derived
//      independently from the implementation sources (docker-compose.yml,
//      packages/web/src/index.js, packages/web/db/migrations/, package.json).
//
// Cascade prevention: a document that fails structural enforcement does not
// also produce identity-mismatch findings. An implementation source that
// fails derivation emits its SOURCE_READ_FAILURE / MIGRATION_* violation and
// suppresses dependent IDENTITY_MISMATCH findings for that field across all
// documents.
//
// Usage: node scripts/check-source-of-truth.mjs
// Exit 0 = consistent, exit 1 = violations found.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

import { parseSourceTruthMarker } from "./parse-source-truth.mjs";

const REPO_ROOT = process.env.CI
  ? path.resolve(".")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GOVERNED_DOCS = [
  "AGENTS.md",
  "docs/installation/infrastructure.md",
  "docs/installation/source-of-truth-inventory.md",
];

// ── Implementation identity derivation ───────────────────────────────────
//
// Each derive* function is fail-closed: on read/parse failure it returns
// { identities: null, violations: [...] } and the caller suppresses
// dependent identity comparisons. Normalization is limited to ordering —
// duplicates and malformed names surface as violations, never normalized
// away.

/**
 * Derive the service identity list from docker-compose.yml service keys.
 * Uses the installed YAML parser rather than reproducing YAML indentation.
 *
 * @param {string} root
 * @returns {{identities: string[]|null, violations: Violation[]}}
 */
function deriveServices(root) {
  let composeText;
  try {
    composeText = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(docker-compose.yml)", field: "services", message: `cannot read docker-compose.yml: ${err.message}` }] };
  }
  let compose;
  try {
    compose = yaml.parse(composeText);
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(docker-compose.yml)", field: "services", message: `cannot parse docker-compose.yml YAML: ${err.message}` }] };
  }
  if (!compose || typeof compose !== "object" || !compose.services || typeof compose.services !== "object") {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(docker-compose.yml)", field: "services", message: "docker-compose.yml has no services mapping" }] };
  }
  // Object.keys preserves insertion order, which mirrors compose file order.
  // Sorting for comparison happens in the comparison layer, not here.
  return { identities: Object.keys(compose.services), violations: [] };
}

/**
 * Derive the worker identity list from the actual `const workers = [...]`
 * initializer in packages/web/src/index.js. Bounded parse: locates the
 * array, scans until its closing `]`, and rejects any unexpected content.
 *
 * @param {string} root
 * @returns {{identities: string[]|null, violations: Violation[]}}
 */
function deriveWorkers(root) {
  let indexText;
  try {
    indexText = fs.readFileSync(path.join(root, "packages/web/src/index.js"), "utf8");
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: `cannot read index.js: ${err.message}` }] };
  }

  // Locate the bounded array: `const workers = [` ... closing `]`.
  const startMatch = indexText.match(/const\s+workers\s*:\s*string\[\]\s*=\s*\[|const\s+workers\s*=\s*\[/);
  if (!startMatch) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: "no `const workers = [...]` initializer found in index.js" }] };
  }
  const afterBracket = startMatch.index + startMatch[0].length;
  const closeIdx = indexText.indexOf("]", afterBracket);
  if (closeIdx === -1) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: "workers array in index.js has no closing `]`" }] };
  }
  const body = indexText.slice(afterBracket, closeIdx);

  // Each non-empty, non-comment line inside the array must be a call to a
  // start*Worker() function. Anything else is a structural defect.
  const identifiers = [];
  const rawLines = body.split(/\r?\n/);
  const callRe = /^\s*(start\w*Worker)\s*\(\s*\)\s*,?\s*$/;
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    const m = trimmed.match(callRe);
    if (!m) {
      return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: `workers array contains unexpected entry: ${JSON.stringify(trimmed)}` }] };
    }
    identifiers.push(m[1]);
  }

  if (identifiers.length === 0) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: "workers array in index.js is empty" }] };
  }

  // Duplicate detection — surfaced, not normalized away.
  const seen = new Set();
  for (const id of identifiers) {
    if (seen.has(id)) {
      return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/src/index.js)", field: "workers", message: `duplicate worker call ${id} in index.js workers array` }] };
    }
    seen.add(id);
  }

  return { identities: identifiers, violations: [] };
}

/**
 * Derive the migration identity set from packages/web/db/migrations/.
 * Strict 6-step pipeline:
 *   1. read directory
 *   2. validate every filename against ^\d{3}_.+\.sql$
 *   3. extract numeric prefixes
 *   4. detect duplicate prefixes
 *   5. numerically sort prefixes
 *   6. enforce contiguous 001..N sequence
 *
 * A malformed-name failure suppresses MIGRATION_GAP (the sequence cannot be
 * evaluated unambiguously when names are non-conforming). A duplicate-prefix
 * failure likewise suppresses gap evaluation.
 *
 * @param {string} root
 * @returns {{identities: {first:string,last:string,count:number,list:string[]}|null, violations: Violation[]}}
 */
function deriveMigrations(root) {
  const dir = path.join(root, "packages/web/db/migrations");
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/db/migrations)", field: "migrations", message: `cannot read migrations directory: ${err.message}` }] };
  }

  // Step 2: inspect EVERY entry. Fail on non-files (subdirectories, symlinks)
  // and on any filename that does not match the canonical migration pattern.
  // This closes a fail-open path where README.md, foo.txt, subdirectories, or
  // .sql.bak files were silently ignored by a premature .sql filter.
  const nameRe = /^\d{3}_.+\.sql$/;
  const nonFiles = dirents.filter((d) => !d.isFile());
  if (nonFiles.length > 0) {
    return { identities: null, violations: [{ code: "MIGRATION_MALFORMED_NAME", document: "(packages/web/db/migrations)", field: "migrations", message: `migrations directory contains non-file entries: ${nonFiles.map((d) => d.name).join(", ")}` }] };
  }
  const filenames = dirents.map((d) => d.name);
  const malformed = filenames.filter((f) => !nameRe.test(f));
  if (malformed.length > 0) {
    return { identities: null, violations: [{ code: "MIGRATION_MALFORMED_NAME", document: "(packages/web/db/migrations)", field: "migrations", message: `malformed migration filename(s): ${malformed.join(", ")}` }] };
  }
  if (filenames.length === 0) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(packages/web/db/migrations)", field: "migrations", message: "migrations directory contains no migration files" }] };
  }

  // Step 3-4: extract numeric prefixes and detect duplicates.
  const prefixes = filenames.map((f) => f.slice(0, 3));
  const prefixCounts = new Map();
  for (const p of prefixes) {
    prefixCounts.set(p, (prefixCounts.get(p) || 0) + 1);
  }
  const dups = [...prefixCounts.entries()].filter(([, c]) => c > 1).map(([p]) => p);
  if (dups.length > 0) {
    return { identities: null, violations: [{ code: "MIGRATION_DUPLICATE_NUMBER", document: "(packages/web/db/migrations)", field: "migrations", message: `duplicate migration prefix(es): ${dups.join(", ")}` }] };
  }

  // Step 5-6: numeric sort and enforce contiguous 001..N.
  const sorted = [...new Set(prefixes)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  let gap = null;
  for (let i = 0; i < sorted.length; i++) {
    const expected = String(i + 1).padStart(3, "0");
    if (sorted[i] !== expected) {
      gap = { found: sorted[i], expected };
      break;
    }
  }
  if (gap) {
    return { identities: null, violations: [{ code: "MIGRATION_GAP", document: "(packages/web/db/migrations)", field: "migrations", message: `migration sequence gap: expected ${gap.expected}, found ${gap.found}` }] };
  }

  return {
    identities: {
      first: sorted[0],
      last: sorted[sorted.length - 1],
      count: sorted.length,
      list: sorted,
    },
    violations: [],
  };
}

/**
 * Derive the package version from the root package.json.
 *
 * @param {string} root
 * @returns {{identities: string|null, violations: Violation[]}}
 */
function deriveVersion(root) {
  let pkgText;
  try {
    pkgText = fs.readFileSync(path.join(root, "package.json"), "utf8");
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(package.json)", field: "version", message: `cannot read package.json: ${err.message}` }] };
  }
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (err) {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(package.json)", field: "version", message: `cannot parse package.json: ${err.message}` }] };
  }
  if (typeof pkg.version !== "string") {
    return { identities: null, violations: [{ code: "SOURCE_READ_FAILURE", document: "(package.json)", field: "version", message: "package.json has no string 'version' field" }] };
  }
  return { identities: pkg.version, violations: [] };
}

// ── Identity comparison ──────────────────────────────────────────────────

/**
 * Compare two identity arrays for set equality after stable sorting.
 * Ordering is normalized; duplicates were already rejected upstream.
 *
 * @param {string[]} markerVal
 * @param {string[]} derivedVal
 * @returns {boolean}
 */
function identityArraysEqual(markerVal, derivedVal) {
  if (markerVal.length !== derivedVal.length) return false;
  const a = [...markerVal].sort();
  const b = [...derivedVal].sort();
  return a.every((v, i) => v === b[i]);
}

/**
 * Compare the marker contract for one document against derived identities.
 * Only emits IDENTITY_MISMATCH when the derived identity is available.
 *
 * @param {object} opts
 * @param {string} opts.document
 * @param {object} opts.markerData parsed marker contract (already validated)
 * @param {{services:string[]|null, workers:string[]|null, migrations:{first,last,count,list}|null, version:string|null}} opts.derived
 * @returns {Violation[]}
 */
function compareIdentities({ document, markerData, derived }) {
  const violations = [];

  if (derived.services && !identityArraysEqual(markerData.services, derived.services)) {
    violations.push({
      code: "IDENTITY_MISMATCH",
      document,
      field: "services",
      expected: [...derived.services].sort(),
      actual: [...markerData.services].sort(),
      message: `services mismatch`,
    });
  }
  if (derived.workers && !identityArraysEqual(markerData.workers, derived.workers)) {
    violations.push({
      code: "IDENTITY_MISMATCH",
      document,
      field: "workers",
      expected: [...derived.workers].sort(),
      actual: [...markerData.workers].sort(),
      message: `workers mismatch`,
    });
  }
  if (derived.migrations) {
    const dm = derived.migrations;
    if (
      markerData.migrations.first !== dm.first ||
      markerData.migrations.last !== dm.last ||
      markerData.migrations.count !== dm.count
    ) {
      violations.push({
        code: "IDENTITY_MISMATCH",
        document,
        field: "migrations",
        expected: { first: dm.first, last: dm.last, count: dm.count },
        actual: { ...markerData.migrations },
        message: `migrations mismatch`,
      });
    }
  }
  if (derived.version && markerData.version !== derived.version) {
    violations.push({
      code: "IDENTITY_MISMATCH",
      document,
      field: "version",
      expected: derived.version,
      actual: markerData.version,
      message: `version mismatch`,
    });
  }

  return violations;
}

// ── Top-level gate ───────────────────────────────────────────────────────

export function checkSourceOfTruth(rootPath) {
  const root = rootPath || REPO_ROOT;

  function readRoot(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
  }

  const violations = [];

  // ── Layer 1: structural marker enforcement ─────────────────────────────
  const markerDataByDoc = new Map();
  for (const docRel of GOVERNED_DOCS) {
    let docText;
    try {
      docText = readRoot(docRel);
    } catch (err) {
      violations.push({ code: "SOURCE_READ_FAILURE", document: docRel, field: "file", message: `cannot read ${docRel}: ${err.message}` });
      continue;
    }
    const { data, violations: docViolations } = parseSourceTruthMarker(docText, { document: docRel });
    if (docViolations.length > 0) {
      violations.push(...docViolations);
      // Cascade prevention: a structurally-broken document does NOT also
      // contribute identity-mismatch findings. Skip it for layer 2.
      continue;
    }
    markerDataByDoc.set(docRel, data);
  }

  // ── Derive implementation identities ───────────────────────────────────
  // Each derived failure is recorded once and suppresses the dependent
  // comparison field for ALL documents (the source is shared).
  const svc = deriveServices(root);
  violations.push(...svc.violations);
  const wkr = deriveWorkers(root);
  violations.push(...wkr.violations);
  const mig = deriveMigrations(root);
  violations.push(...mig.violations);
  const ver = deriveVersion(root);
  violations.push(...ver.violations);

  const derived = {
    services: svc.identities,
    workers: wkr.identities,
    migrations: mig.identities,
    version: ver.identities,
  };

  // ── Layer 2: identity comparison ───────────────────────────────────────
  for (const [docRel, markerData] of markerDataByDoc) {
    violations.push(...compareIdentities({ document: docRel, markerData, derived }));
  }

  return {
    violations,
    derived,
    markerDataByDoc,
  };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-source-of-truth.mjs")) {
  const { violations } = checkSourceOfTruth();
  if (violations.length > 0) {
    for (const v of violations) {
      const where = v.document ? ` ${v.document}` : "";
      const field = v.field ? ` (${v.field})` : "";
      const detail = v.expected !== undefined ? ` expected=${JSON.stringify(v.expected)} actual=${JSON.stringify(v.actual)}` : `: ${v.message}`;
      console.error(`${v.code}${where}${field}${detail}`);
    }
    console.error(`\n${violations.length} source-of-truth violation(s) found.`);
    process.exit(1);
  } else {
    console.log("✓ No source-of-truth drift detected.");
    process.exit(0);
  }
}
