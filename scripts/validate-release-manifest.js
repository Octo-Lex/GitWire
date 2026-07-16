#!/usr/bin/env node
// scripts/validate-release-manifest.js
//
// Validates a release-manifest.json against the expected schema and
// CI identity. Exits 0 on success, 1 on any validation failure.
//
// Usage:
//   node scripts/validate-release-manifest.js <manifest.json> <expected_sha> <expected_run_id>
//
// Checks:
//   - schema_version === 1
//   - git_sha === expected_sha
//   - workflow_run_id === expected_run_id
//   - All three services exist (app, executor, dashboard)
//   - Every reference is digest-qualified (contains @sha256:)
//   - Every digest matches sha256:[a-f0-9]{64}
//   - No reference contains :latest
//   - The reference digest equals the separate digest field

import fs from "node:fs";
import path from "node:path";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

// Approved GHCR repositories for GitWire release images.
// A digest-qualified reference to any other repository must be rejected.
const APPROVED_REPOS = Object.freeze({
  app: "ghcr.io/octo-lex/gitwire-app",
  executor: "ghcr.io/octo-lex/gitwire-executor-service",
  dashboard: "ghcr.io/octo-lex/gitwire-dashboard",
});

function fail(msg) {
  console.error(`::error::release-manifest validation failed: ${msg}`);
  process.exit(1);
}

function main() {
  const [manifestPath, expectedSha, expectedRunId] = process.argv.slice(2);

  if (!manifestPath || !expectedSha || !expectedRunId) {
    fail("usage: validate-release-manifest.js <manifest.json> <expected_sha> <expected_run_id>");
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    fail(`cannot read or parse manifest: ${err.message}`);
  }

  // schema_version
  if (manifest.schema_version !== 1) {
    fail(`schema_version is ${manifest.schema_version}, expected 1`);
  }

  // git_sha
  if (manifest.git_sha !== expectedSha) {
    fail(`git_sha is '${manifest.git_sha}', expected '${expectedSha}'`);
  }

  // workflow_run_id
  if (String(manifest.workflow_run_id) !== String(expectedRunId)) {
    fail(`workflow_run_id is '${manifest.workflow_run_id}', expected '${expectedRunId}'`);
  }

  // images object
  if (!manifest.images || typeof manifest.images !== "object") {
    fail("manifest.images is missing or not an object");
  }

  const requiredServices = ["app", "executor", "dashboard"];
  for (const svc of requiredServices) {
    const img = manifest.images[svc];
    if (!img) {
      fail(`images.${svc} is missing`);
    }

    // reference must be digest-qualified
    if (!img.reference || !img.reference.includes("@sha256:")) {
      fail(`images.${svc}.reference '${img.reference}' is not digest-qualified`);
    }

    // reference must use the approved GHCR repository for this service
    const expectedRepo = APPROVED_REPOS[svc];
    const refRepo = img.reference.split("@")[0];
    if (refRepo !== expectedRepo) {
      fail(`images.${svc}.reference repository '${refRepo}' does not match approved '${expectedRepo}'`);
    }

    // no :latest
    if (img.reference.includes(":latest")) {
      fail(`images.${svc}.reference contains ':latest'`);
    }

    // digest format
    if (!img.digest || !DIGEST_RE.test(img.digest)) {
      fail(`images.${svc}.digest '${img.digest}' does not match sha256:[a-f0-9]{64}`);
    }

    // reference digest must equal the digest field
    const refDigest = img.reference.split("@")[1];
    if (refDigest !== img.digest) {
      fail(`images.${svc}: reference digest '${refDigest}' != digest field '${img.digest}'`);
    }
  }

  console.log("✓ release-manifest validation passed");
  console.log(`  git_sha: ${manifest.git_sha.slice(0, 12)}...`);
  console.log(`  app: ${manifest.images.app.digest.slice(0, 20)}...`);
  console.log(`  executor: ${manifest.images.executor.digest.slice(0, 20)}...`);
  console.log(`  dashboard: ${manifest.images.dashboard.digest.slice(0, 20)}...`);
}

main();
