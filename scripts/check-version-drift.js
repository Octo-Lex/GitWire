#!/usr/bin/env node
/**
 * scripts/check-version-drift.js
 *
 * Verifies that all version surfaces agree. Exits non-zero on drift.
 *
 * Checks:
 *   1. root package.json version == package-lock.json version
 *   2. all workspace package.json versions == root version
 *   3. packages/core/src/buildInfo.js fallback version == root version
 *   4. packages/web-dashboard/src/lib/buildInfo.ts fallback version == root version
 *   5. no "GitWire v0.12.0" hardcoded literals remain
 *
 * Cheap, dependency-free, runs before npm install in CI.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let errors = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    errors++;
  }
}

// ── 1. Root package.json ────────────────────────────────────────────────────
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const rootVersion = rootPkg.version;
console.log(`Root version: ${rootVersion}\n`);

// ── 2. package-lock.json ────────────────────────────────────────────────────
const lockRaw = readFileSync(join(ROOT, "package-lock.json"), "utf-8");
const lock = JSON.parse(lockRaw);
check("package-lock.json version matches root", lock.version === rootVersion,
  `lockfile has "${lock.version}"`);

// ── 3. Workspace packages ───────────────────────────────────────────────────
const pkgsDir = join(ROOT, "packages");
for (const dir of readdirSync(pkgsDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const pkgPath = join(pkgsDir, dir.name, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    check(`packages/${dir.name}/package.json`, pkg.version === rootVersion,
      `has "${pkg.version}"`);
  } catch {
    // No package.json — skip (some dirs are stubs)
  }
}

// ── 4. Core buildInfo.js fallback version ───────────────────────────────────
const coreBuildInfo = readFileSync(join(ROOT, "packages", "core", "src", "buildInfo.js"), "utf-8");
const coreVersionMatch = coreBuildInfo.match(/version:\s*"([^"]+)"/);
check("core/src/buildInfo.js fallback version", coreVersionMatch?.[1] === rootVersion,
  coreVersionMatch ? `has "${coreVersionMatch[1]}"` : "version not found");

// ── 5. Dashboard buildInfo.ts fallback version ──────────────────────────────
const dashBuildInfo = readFileSync(join(ROOT, "packages", "web-dashboard", "src", "lib", "buildInfo.ts"), "utf-8");
const dashVersionMatch = dashBuildInfo.match(/NEXT_PUBLIC_GITWIRE_VERSION\s*\|\|\s*"([^"]+)"/);
check("web-dashboard/lib/buildInfo.ts fallback version", dashVersionMatch?.[1] === rootVersion,
  dashVersionMatch ? `has "${dashVersionMatch[1]}"` : "fallback version not found");

// ── 6. No stale hardcoded version literals ──────────────────────────────────
const stalePattern = /GitWire\s+v0\.12\.0/;
const sidebarContent = readFileSync(join(ROOT, "packages", "web-dashboard", "src", "components", "Sidebar.tsx"), "utf-8");
check("Sidebar.tsx has no hardcoded v0.12.0", !stalePattern.test(sidebarContent),
  "hardcoded version literal found");

// ── Result ──────────────────────────────────────────────────────────────────
console.log("");
if (errors > 0) {
  console.error(`✗ ${errors} version drift error(s) found.`);
  process.exit(1);
} else {
  console.log("✓ All version surfaces agree.");
}
