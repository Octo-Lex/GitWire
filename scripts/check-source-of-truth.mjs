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

  const actualServices = countServicesRoot();
  const actualWorkers = countWorkersRoot();
  const actualMigrations = countMigrationsRoot();
  const actualVersion = getVersionRoot();

  // Check AGENTS.md
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

  // Check infrastructure.md
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

  return { violations, actual: { services: actualServices, workers: actualWorkers, migrations: actualMigrations, version: actualVersion } };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-source-of-truth.mjs")) {
  const { violations } = checkSourceOfTruth();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`DRIFT: ${v.doc} says ${v.field}=${v.docValue}, actual=${v.actual}`);
    }
    console.error(`\n${violations.length} source-of-truth drift(s) found.`);
    process.exit(1);
  } else {
    console.log("✓ No source-of-truth drift detected.");
    process.exit(0);
  }
}
