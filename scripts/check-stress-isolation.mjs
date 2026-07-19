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
import yaml from "js-yaml";

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

// Check for a secondary app Dockerfile that is not the canonical root Dockerfile.
// The root Dockerfile is the only image source for the production app.
/**
 * Known permitted Dockerfiles. Any file matching the Dockerfile-name pattern
 * not in this set is a violation.
 */
const KNOWN_DOCKERFILES = new Set([
  "Dockerfile",                           // root — canonical app image
  "packages/web-dashboard/Dockerfile",    // dashboard image
  "packages/executor-service/Dockerfile",  // executor image
  "packages/bot/Dockerfile",              // bot image
  "landing/Dockerfile",                   // landing image
  "docs/Dockerfile",                      // docs image
  "packages/demo-dashboard/Dockerfile",   // demo image
  "validator-image/Dockerfile",           // validator image
]);

// Matches: Dockerfile, Dockerfile.dev, Dockerfile.prod, dockerfile, etc.
// Does NOT match: .dockerignore, Dockerfile.dockerignore, Dockerfile.dockerignore.bak
const DOCKERFILE_NAME_RE = /^Dockerfile(?:\.(?!dockerignore).+)?$/i;

/**
 * Scan a repository tree for unknown Dockerfiles. Fails closed on unreadable
 * directories. Exports for unit testing.
 *
 * @param {string} repoRoot repository root to scan
 * @param {Set<string>} [known] known permitted relative paths
 * @returns {Array<{file: string, msg: string}>} violations
 */
export function scanDockerfiles(repoRoot, known = KNOWN_DOCKERFILES) {
  const violations = [];
  const findDockerfiles = (dir, prefix = "") => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      violations.push({ file: prefix || "(root)", msg: `cannot read directory: ${err.message}` });
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".ouroboros" || e.name === ".zcode") continue;
      const rel = prefix + e.name;
      if (e.isFile() && DOCKERFILE_NAME_RE.test(e.name) && !known.has(rel)) {
        violations.push({ file: rel, msg: "unknown Dockerfile — only known service Dockerfiles are permitted" });
      }
      if (e.isDirectory()) {
        findDockerfiles(path.join(dir, e.name), rel + "/");
      }
    }
  };
  findDockerfiles(repoRoot);
  return violations;
}

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

/**
 * Parse a Compose file and validate that every build.dockerfile target exists
 * relative to its build.context. Returns violations for missing targets and
 * targets escaping the repository.
 *
 * @param {string} repoRoot repository root
 * @param {string} composeRelPath relative path to the Compose file
 * @returns {Array<{file: string, msg: string}>} violations
 */
export function validateComposeDockerfiles(repoRoot, composeRelPath = "docker-compose.build.yml") {
  const violations = [];
  const composePath = path.join(repoRoot, composeRelPath);

  let composeContent;
  try {
    composeContent = fs.readFileSync(composePath, "utf8");
  } catch (err) {
    return [{ file: composeRelPath, msg: `cannot read Compose file: ${err.message}` }];
  }

  let compose;
  try {
    compose = yaml.load(composeContent);
  } catch (err) {
    return [{ file: composeRelPath, msg: `cannot parse Compose YAML: ${err.message}` }];
  }

  if (!compose || !compose.services) {
    return [{ file: composeRelPath, msg: "Compose file has no services section" }];
  }

  for (const [svcName, svc] of Object.entries(compose.services)) {
    if (!svc.build) continue;

    const buildCtx = typeof svc.build === "string" ? svc.build : svc.build.context || ".";
    const dockerfile = (typeof svc.build === "object" ? svc.build.dockerfile : null) || "Dockerfile";

    // Resolve context relative to repo root.
    const contextAbs = path.resolve(repoRoot, buildCtx);
    const dockerfilePath = path.join(contextAbs, dockerfile);
    const dockerfileRel = path.relative(repoRoot, dockerfilePath);

    // Reject targets escaping the repository.
    if (dockerfileRel.startsWith("..")) {
      violations.push({
        file: `${composeRelPath}:${svcName}`,
        msg: `Dockerfile target '${dockerfile}' in context '${buildCtx}' escapes the repository`,
      });
      continue;
    }

    // Verify the target exists.
    if (!fs.existsSync(dockerfilePath)) {
      violations.push({
        file: `${composeRelPath}:${svcName}`,
        msg: `Dockerfile target '${dockerfileRel}' does not exist (context: ${buildCtx})`,
      });
    }
  }

  return violations;
}

/**
 * Verify that every default allowlisted Dockerfile actually exists in the repo.
 *
 * @param {string} repoRoot repository root
 * @param {Set<string>} [known] known permitted relative paths
 * @returns {Array<{file: string, msg: string}>} violations
 */
export function verifyKnownDockerfilesExist(repoRoot, known = KNOWN_DOCKERFILES) {
  const violations = [];
  for (const rel of known) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      violations.push({ file: rel, msg: "allowlisted Dockerfile does not exist" });
    }
  }
  return violations;
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("check-stress-isolation.mjs")) {
  const violations = scanStressIsolation();
  const repoRoot = path.resolve(".");
  violations.push(...scanDockerfiles(repoRoot));
  violations.push(...verifyKnownDockerfilesExist(repoRoot));
  violations.push(...validateComposeDockerfiles(repoRoot));
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
