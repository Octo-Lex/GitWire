// packages/core/tests/validate-release-manifest.test.js
//
// Tests for scripts/validate-release-manifest.js
// Covers valid manifests, wrong SHA, wrong run ID, missing services,
// tag-only references, :latest, malformed digests, reference/digest
// mismatch, and unapproved GHCR repositories.

import { describe, it, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VALIDATOR = path.resolve(__dirname, "../../../scripts/validate-release-manifest.js");
const VALID_SHA = "abc123def456789";
const VALID_RUN_ID = "9876543210";
const VALID_DIGEST = "sha256:" + "a".repeat(64);

function makeValidManifest() {
  return {
    schema_version: 1,
    git_sha: VALID_SHA,
    version: "0.23.1",
    built_at: "2026-07-16T00:00:00Z",
    workflow_run_id: VALID_RUN_ID,
    images: {
      app: { reference: `ghcr.io/octo-lex/gitwire-app@${VALID_DIGEST}`, digest: VALID_DIGEST },
      executor: { reference: `ghcr.io/octo-lex/gitwire-executor-service@${VALID_DIGEST}`, digest: VALID_DIGEST },
      dashboard: { reference: `ghcr.io/octo-lex/gitwire-dashboard@${VALID_DIGEST}`, digest: VALID_DIGEST },
    },
  };
}

function runValidator(manifest) {
  const tmpFile = path.join(os.tmpdir(), `manifest-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(manifest));
  try {
    const stdout = execFileSync("node", [VALIDATOR, tmpFile, VALID_SHA, VALID_RUN_ID], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "" };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

describe("validate-release-manifest", () => {
  it("accepts a valid manifest", () => {
    const result = runValidator(makeValidManifest());
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("validation passed");
  });

  it("rejects wrong SHA", () => {
    const m = makeValidManifest();
    m.git_sha = "wrongsha";
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("git_sha");
  });

  it("rejects wrong workflow run ID", () => {
    const m = makeValidManifest();
    m.workflow_run_id = "wrongrun";
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("workflow_run_id");
  });

  it("rejects missing executor service", () => {
    const m = makeValidManifest();
    delete m.images.executor;
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("images.executor is missing");
  });

  it("rejects tag-only reference (no digest)", () => {
    const m = makeValidManifest();
    m.images.app.reference = "ghcr.io/octo-lex/gitwire-app:sha-abc";
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("not digest-qualified");
  });

  it("rejects :latest tag", () => {
    const m = makeValidManifest();
    m.images.dashboard.reference = `ghcr.io/octo-lex/gitwire-dashboard:latest@${VALID_DIGEST}`;
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(":latest");
  });

  it("rejects malformed digest (wrong length)", () => {
    const m = makeValidManifest();
    m.images.app.digest = "sha256:short";
    m.images.app.reference = `ghcr.io/octo-lex/gitwire-app@sha256:short`;
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not match sha256:");
  });

  it("rejects reference/digest mismatch", () => {
    const m = makeValidManifest();
    const otherDigest = "sha256:" + "b".repeat(64);
    m.images.app.reference = `ghcr.io/octo-lex/gitwire-app@${otherDigest}`;
    // digest field still has the original 'a' digest
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("reference digest");
  });

  it("rejects unapproved GHCR repository", () => {
    const m = makeValidManifest();
    m.images.app.reference = `ghcr.io/evil-corp/gitwire-app@${VALID_DIGEST}`;
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("does not match approved");
  });

  it("rejects schema_version mismatch", () => {
    const m = makeValidManifest();
    m.schema_version = 2;
    const result = runValidator(m);
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("schema_version");
  });
});
