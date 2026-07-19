#!/usr/bin/env node
// scripts/check-source-of-truth.mjs
//
// Validates that documentation values match their authoritative implementation
// sources. Prevents source-of-truth drift between AGENTS.md, infrastructure.md,
// and the actual codebase.
//
// Usage: node scripts/check-source-of-truth.mjs
// Exit 0 = consistent, exit 1 = drift detected.

import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { parseSourceTruthMarker } from "./parse-source-truth.mjs";

// Governed documents: each must carry exactly one well-formed
// gitwire:source-of-truth marker block declaring its asserted contract.
// In commit 7 these markers are enforced structurally (parse + schema);
// the legacy regex-extraction block below remains the value-comparison
// mechanism until commit 8 replaces it with implementation-derived truth.
const GOVERNED_DOCS = [
  "AGENTS.md",
  "docs/installation/infrastructure.md",
  "docs/installation/source-of-truth-inventory.md",
];

const REPO_ROOT = process.env.CI
  ? path.resolve(".")
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function countServices() {
  const compose = read("docker-compose.yml");
  const lines = compose.split("\n");
  let inServices = false;
  const services = [];
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (inServices && /^(networks|volumes):\s*$/.test(line)) { inServices = false; continue; }
    if (inServices && /^  [a-z][a-z0-9_-]*:\s*$/.test(line)) {
      services.push(line.trim().replace(":", ""));
    }
  }
  return services.length;
}

function countWorkers() {
  const indexJs = read("packages/web/src/index.js");
  const matches = indexJs.match(/start\w*Worker\(\)/g) || [];
  return matches.length;
}

function countMigrations() {
  const dir = path.join(REPO_ROOT, "packages/web/db/migrations");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql"));
  return files.length;
}

function getVersion() {
  const pkg = JSON.parse(read("package.json"));
  return pkg.version;
}

function extractDocNumber(docPath, marker) {
  try {
    const content = read(docPath);
  const re = new RegExp(marker + "[^\\d]*(\\d+)", "i");
    const m = content.match(re);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function extractDocVersion(docPath) {
  try {
    const content = read(docPath);
    const m = content.match(/version[:\s]*\*?(\d+\.\d+\.\d+)\*?/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function checkSourceOfTruth(rootPath) {
  const root = rootPath || REPO_ROOT;

  function readRoot(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
  }

  function countServicesRoot() {
    const compose = readRoot("docker-compose.yml");
    const lines = compose.split("\n");
    let inServices = false;
    const services = [];
    for (const line of lines) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (inServices && /^(networks|volumes):\s*$/.test(line)) { inServices = false; continue; }
      if (inServices && /^  [a-z][a-z0-9_-]*:\s*$/.test(line)) {
        services.push(line.trim().replace(":", ""));
      }
    }
    return services.length;
  }

  function countWorkersRoot() {
    const indexJs = readRoot("packages/web/src/index.js");
    const matches = indexJs.match(/start\w*Worker\(\)/g) || [];
    return matches.length;
  }

  function countMigrationsRoot() {
    const dir = path.join(root, "packages/web/db/migrations");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql"));
    return files.length;
  }

  function getVersionRoot() {
    const pkg = JSON.parse(readRoot("package.json"));
    return pkg.version;
  }

  const violations = [];
  const structuralViolations = [];

  // ── Structural enforcement of the marker contract ──────────────────────
  // Every governed document must carry exactly one well-formed marker whose
  // JSON conforms to SourceTruthContract (schemaVersion 1). A document that
  // fails parsing or schema validation does NOT contribute value-drift
  // violations below — its structural defect is the root cause and is
  // reported once. (Identity comparison against implementation-derived truth
  // arrives in commit 8; until then the regex block handles value drift.)
  const docsFailedStructurally = new Set();
  for (const docRel of GOVERNED_DOCS) {
    let docText;
    try {
      docText = readRoot(docRel);
    } catch (err) {
      structuralViolations.push({ code: "SOURCE_READ_FAILURE", document: docRel, field: "file", message: `cannot read ${docRel}: ${err.message}` });
      docsFailedStructurally.add(docRel);
      continue;
    }
    const { violations: docViolations } = parseSourceTruthMarker(docText, { document: docRel });
    if (docViolations.length > 0) {
      structuralViolations.push(...docViolations);
      docsFailedStructurally.add(docRel);
    }
  }

  const actualServices = countServicesRoot();
  const actualWorkers = countWorkersRoot();
  const actualMigrations = countMigrationsRoot();
  const actualVersion = getVersionRoot();

  // Check AGENTS.md — value drift via legacy regex path (commit 7).
  // Skip if the marker failed structurally; the structural violation is
  // the root cause and value-drift findings would be secondary noise.
  if (!docsFailedStructurally.has("AGENTS.md")) {
    const agentsContent = readRoot("AGENTS.md");
    const agentsWorkersMatch = agentsContent.match(/(\d+)\s+BullMQ\s+worker/);
    const agentsWorkers = agentsWorkersMatch ? parseInt(agentsWorkersMatch[1], 10) : null;
    const agentsMigrationsMatch = agentsContent.match(/(\d+)\s+SQL\s+migrations/);
    const agentsMigrations = agentsMigrationsMatch ? parseInt(agentsMigrationsMatch[1], 10) : null;
    const agentsVersionMatch = agentsContent.match(/version[:\s]*\**(\d+\.\d+\.\d+)\**/i);
    const agentsVersion = agentsVersionMatch ? agentsVersionMatch[1] : null;

    if (agentsWorkers !== null && agentsWorkers !== actualWorkers) {
      violations.push({ doc: "AGENTS.md", field: "worker count", docValue: agentsWorkers, actual: actualWorkers });
    }
    if (agentsMigrations !== null && agentsMigrations !== actualMigrations) {
      violations.push({ doc: "AGENTS.md", field: "migration count", docValue: agentsMigrations, actual: actualMigrations });
    }
    if (agentsVersion && agentsVersion !== actualVersion) {
      violations.push({ doc: "AGENTS.md", field: "version", docValue: agentsVersion, actual: actualVersion });
    }
  }

  // Check infrastructure.md — value drift via legacy regex path (commit 7).
  if (!docsFailedStructurally.has("docs/installation/infrastructure.md")) {
    const infraContent = readRoot("docs/installation/infrastructure.md");
    const infraServicesMatch = infraContent.match(/(\d+)\s+services/);
    const infraServices = infraServicesMatch ? parseInt(infraServicesMatch[1], 10) : null;
    const infraWorkersMatch = infraContent.match(/(\d+)\s+BullMQ\s+worker/);
    const infraWorkers = infraWorkersMatch ? parseInt(infraWorkersMatch[1], 10) : null;

    if (infraServices !== null && infraServices !== actualServices) {
      violations.push({ doc: "infrastructure.md", field: "service count", docValue: infraServices, actual: actualServices });
    }
    if (infraWorkers !== null && infraWorkers !== actualWorkers) {
      violations.push({ doc: "infrastructure.md", field: "worker count", docValue: infraWorkers, actual: actualWorkers });
    }
  }

  return {
    violations,
    structuralViolations,
    actual: { services: actualServices, workers: actualWorkers, migrations: actualMigrations, version: actualVersion },
  };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-source-of-truth.mjs")) {
  const { violations, structuralViolations } = checkSourceOfTruth();
  let failed = false;

  if (structuralViolations.length > 0) {
    failed = true;
    for (const v of structuralViolations) {
      console.error(`STRUCTURAL: ${v.code} ${v.document}${v.field ? ` (${v.field})` : ""}: ${v.message}`);
    }
    console.error(`\n${structuralViolations.length} structural marker violation(s) found.`);
  }

  if (violations.length > 0) {
    failed = true;
    for (const v of violations) {
      console.error(`DRIFT: ${v.doc} says ${v.field}=${v.docValue}, actual=${v.actual}`);
    }
    console.error(`\n${violations.length} source-of-truth drift(s) found.`);
  }

  if (failed) {
    process.exit(1);
  } else {
    console.log("✓ No source-of-truth drift detected.");
    process.exit(0);
  }
}
