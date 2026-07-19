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
import * as yaml from "yaml";

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

// P2: executable modules under tests/stress/modules/ must not introduce real
// wall-clock reads or real timers. Determinism flows only through injected
// createClock() / createSleeper(). The FORBIDDEN_TIME_TOKENS comment block
// inside scenario-harness.js mirrors this list so the rule and rationale stay
// co-located; this regex is the authoritative check.
const FORBIDDEN_TIME_TOKENS = [
  { regex: /\bDate\.now\s*\(/, msg: "forbidden Date.now — inject createClock() instead" },
  { regex: /\bperformance\.now\s*\(/, msg: "forbidden performance.now — inject createClock() instead" },
  { regex: /\bsetTimeout\s*\(/, msg: "forbidden setTimeout — inject createSleeper() instead" },
  { regex: /\bsetInterval\s*\(/, msg: "forbidden setInterval — inject createSleeper() instead" },
];

// File selection rules for the recursive collector (see collectStressIsolationFiles).
// Two file classes are scanned for prohibited constructs:
//   - **/*.test.js       — the established stress test surface (now recursive)
//   - modules/**/*.{js,mjs} — the new P2 executable-module surface
// Non-test, non-module files at the stress root (helpers like burst-runner.js,
// response-contracts.js, stress-helpers.js) are intentionally NOT scanned by
// this function — they are library code consumed by tests, not tests/modules.
const MODULES_DIR_NAME = "modules";

function isScannableStressFile(relPath) {
  if (relPath.endsWith(".test.js")) return true;
  // Any file under a modules/ directory with a .js or .mjs extension. Split
  // on either separator so the predicate works whether the caller passed a
  // forward-slash or platform-native relative path.
  const parts = relPath.split(/[/\\]/);
  const modulesIdx = parts.indexOf(MODULES_DIR_NAME);
  if (modulesIdx !== -1 && (relPath.endsWith(".js") || relPath.endsWith(".mjs"))) {
    return true;
  }
  return false;
}

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
 * Recursively collect scannable stress files under a directory.
 *
 * Returns normalized relative paths (forward slashes) so the same allowlist
 * entry works across POSIX and Windows. Selection rules (see
 * isScannableStressFile):
 *   - any .test.js file (recursively)  — stress test surface
 *   - any .js/.mjs file under a modules/ subdirectory — P2 executable-module surface
 *
 * Directory entries are sorted for deterministic diagnostics. Symbolic links
 * are NOT followed (a symlinked subdirectory could pull in arbitrary tree
 * content; the gate must scan only what is committed).
 *
 * Fails closed: a nested read failure is recorded as a synthetic file entry
 * rather than silently skipped.
 *
 * @param {string} rootDir absolute directory to scan
 * @returns {Array<{rel: string, abs: string, readError?: string}>}
 */
export function collectStressIsolationFiles(rootDir) {
  const out = [];
  const visit = (absDir, prefix, isRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) throw err; // root unreadable is a hard failure, not a nested warning
      out.push({ rel: prefix || "(dir)", abs: absDir, readError: err.message });
      return;
    }
    // Sort by name for deterministic ordering across platforms.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of sorted) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      const normalizedRel = rel.split(path.sep).join("/");
      const abs = path.join(absDir, ent.name);
      // Symlinks: do NOT follow (a symlinked subdirectory could pull in
      // arbitrary uncommitted tree content). But also do NOT silently treat
      // as clean — a symlink whose name matches a scannable pattern
      // (e.g. modules/adapter.js → /elsewhere/evil.js) would disappear from
      // the static-gate surface. Record as a violation entry so the gate
      // fails closed on the symbolic link itself.
      if (ent.isSymbolicLink()) {
        if (isScannableStressFile(normalizedRel)) {
          out.push({ rel: normalizedRel, abs, symlink: true });
        }
        continue;
      }
      if (ent.isDirectory()) {
        visit(abs, rel, false);
      } else if (ent.isFile() && isScannableStressFile(normalizedRel)) {
        out.push({ rel: normalizedRel, abs });
      }
    }
  };
  visit(rootDir, "", true);
  return out;
}

/**
 * Scan stress test files for prohibited constructs.
 * Pure function — takes a directory and allowlist, returns violations.
 * Fails closed: a missing or unreadable directory is a structural violation.
 *
 * Recursive: covers any .test.js under the stress tree AND any .js/.mjs
 * under a modules/ subdirectory.
 * Module files additionally checked against FORBIDDEN_TIME_TOKENS so the
 * deterministic-harness contract is enforced at CI time.
 *
 * @param {Object} opts
 * @param {string} [opts.dir] stress test directory
 * @param {Set<string>} [opts.allowlist] allowlisted relative paths
 * @returns {Array<{file: string, msg: string}>} violations
 */
export function scanStressIsolation(opts = {}) {
  const dir = opts.dir || STRESS_DIR_DEFAULT;
  const allowlist = opts.allowlist || new Set();
  const violations = [];

  let collected;
  try {
    collected = collectStressIsolationFiles(dir);
  } catch (err) {
    return [{ file: "(directory)", msg: `cannot read stress directory ${dir}: ${err.message}` }];
  }

  // Nested directory-read failures and scannable-shape symlinks surface as
  // synthetic entries — report them as violations BEFORE considering the
  // "no scannable files" empty case, so a precise finding is never discarded
  // by the coarser empty-directory fallback.
  let scannableFileCount = 0;
  for (const c of collected) {
    if (c.readError) {
      violations.push({ file: c.rel, msg: `cannot read ${c.rel}: ${c.readError}` });
      continue;
    }
    if (c.symlink) {
      // A symlink whose name matches the scannable-stress-file pattern is a
      // bypass surface: it would be executable at runtime but its target is
      // outside the committed tree the gate scans. Fail closed.
      violations.push({
        file: c.rel,
        msg: "symbolic links are not permitted in the stress isolation surface",
      });
      continue;
    }
    scannableFileCount++;
  }

  if (scannableFileCount === 0 && violations.length === 0) {
    return [{ file: "(directory)", msg: `stress directory ${dir} contains no scannable stress files` }];
  }

  // Per-file content scan. Each read is wrapped so an unreadable file
  // produces a structured violation rather than throwing out of the pure
  // scanner contract.
  for (const c of collected) {
    if (c.readError || c.symlink) continue; // already reported above
    const { rel, abs } = c;
    if (allowlist.has(rel)) continue;
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (err) {
      violations.push({ file: rel, msg: `cannot read stress file ${rel}: ${err.message}` });
      continue;
    }
    const isModule = rel.split(/[/\\]/).includes(MODULES_DIR_NAME);

    if (RAW_MUTATING_FETCH.test(content)) {
      violations.push({ file: rel, msg: "contains raw mutating fetch() bypassing isolation boundary" });
    }
    for (const { regex, msg } of LEGACY_PATTERNS) {
      if (regex.test(content)) {
        violations.push({ file: rel, msg });
      }
    }
    // Determinism contract applies to executable modules (the harness).
    // Stress tests themselves may legitimately use sleep/setTimeout to pace
    // real network traffic, so the forbidden-time check is scoped to modules/.
    if (isModule) {
      for (const { regex, msg } of FORBIDDEN_TIME_TOKENS) {
        if (regex.test(content)) {
          violations.push({ file: rel, msg });
        }
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
  // Compose resolves build.context relative to the directory containing the
  // Compose file, NOT the repository root. A package-local Compose file with
  // `context: .` must resolve against its own directory; resolving against
  // repoRoot would silently accept a root-level Dockerfile (the exact defect
  // class that previously masked the package-local broken consumer).
  const composeDir = path.dirname(composePath);

  let composeContent;
  try {
    composeContent = fs.readFileSync(composePath, "utf8");
  } catch (err) {
    return [{ file: composeRelPath, msg: `cannot read Compose file: ${err.message}` }];
  }

  let compose;
  try {
    compose = yaml.parse(composeContent);
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

    // Resolve context relative to the Compose file's directory (Compose semantics).
    const contextAbs = path.resolve(composeDir, buildCtx);
    const dockerfilePath = path.join(contextAbs, dockerfile);
    const dockerfileRel = path.relative(repoRoot, dockerfilePath);

    // Reject targets escaping the repository (boundary check stays relative
    // to repoRoot — that is the actual repository boundary).
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
