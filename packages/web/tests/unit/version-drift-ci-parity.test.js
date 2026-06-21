// Local parity test for CI's scripts/check-version-drift.js.
//
// Background: during the v0.22.0 release, CI's check-version-drift.js caught
// dashboard buildInfo.ts drift that this package's local tests missed
// (triage-pr-guards.test.js only checked core/buildInfo.js + package-lock.json).
// Rather than duplicate CI's surface list here (which would drift again),
// this test SPAWNS the CI script and asserts it exits 0. That makes
// check-version-drift.js the single source of truth — local can never fall
// behind CI by construction.
//
// Surfaces this transitively covers (per scripts/check-version-drift.js):
//   - package-lock.json version
//   - all workspace package.json versions
//   - core/src/buildInfo.js fallback
//   - web-dashboard/src/lib/buildInfo.ts fallback
//   - Sidebar.tsx has no stale v0.12.0 literal

import { describe, it, expect } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root: tests/unit/ → ../../../..
const REPO_ROOT = join(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-version-drift.js");

describe("Version drift — CI parity (scripts/check-version-drift.js)", () => {
  it("the CI drift script exits 0 when run locally", () => {
    // Spawn the real CI script exactly as CI does. This is the source of
    // truth: any surface CI checks, this test checks. No duplicated logic.
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });

    // Surface the script's own output on failure so the test message shows
    // exactly which surface drifted (matches CI's diagnostic).
    if (result.status !== 0) {
      const combined = (result.stdout || "") + (result.stderr || "");
      throw new Error(
        `check-version-drift.js exited ${result.status} (expected 0).\n` +
        `Script output:\n${combined}`
      );
    }

    expect(result.status).toBe(0);
  });

  it("the drift script actually exists and ran (produced output)", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 15000,
    });

    // Guard against a false-pass: if the script path is wrong and spawnSync
    // returns no output, we don't want to claim success. The real script
    // always prints at least "Root version: ...".
    const combined = (result.stdout || "") + (result.stderr || "");
    expect(combined.length).toBeGreaterThan(0);
    expect(combined).toMatch(/Root version:/);
  });
});
