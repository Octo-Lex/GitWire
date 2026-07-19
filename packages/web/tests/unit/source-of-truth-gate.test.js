// tests/unit/source-of-truth-gate.test.js
//
// Live-gate tests for check-source-of-truth.mjs.
//
// Two layers:
//   1. "Current repo is consistent" — runs the gate against the real
//      checked-out tree. Never mutates repo files.
//   2. Drift detection — mutates a TEMPORARY fixture (mkdtempSync) and
//      asserts the new identity-mismatch / migration codes. No test in this
//      file writes to any checked-out repository file.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { checkSourceOfTruth } from "../../../../scripts/check-source-of-truth.mjs";

const __filename_test = fileURLToPath(import.meta.url);
const __dirname_test = path.dirname(__filename_test);
const MODULE_REPO_ROOT = path.resolve(__dirname_test, "../../../..");
const AGENTS_PATH = path.join(MODULE_REPO_ROOT, "AGENTS.md");

const agentsExists = fs.existsSync(AGENTS_PATH);

// ─── Layer 1: real checked-out tree is consistent ───────────────────────

describe("source-of-truth gate — current repo is consistent", () => {
  it("AGENTS.md is reachable at the resolved path", () => {
    expect(agentsExists).toBe(true);
  });

  it("returns zero violations on the checked-out tree", () => {
    const { violations } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(violations).toEqual([]);
  });

  it("derives the exact service identity list from docker-compose.yml", () => {
    const { derived } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(derived.services).not.toBeNull();
    expect([...derived.services].sort()).toEqual([
      "bot",
      "dashboard",
      "demo",
      "docs",
      "gitwire-app",
      "gitwire-executor-service",
      "landing",
      "postgres",
      "redis",
      "tunnel",
    ]);
  });

  it("derives the exact worker identity list from the index.js workers array", () => {
    const { derived } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(derived.workers).not.toBeNull();
    expect([...derived.workers].sort()).toEqual([
      "startCIEvidenceWorker",
      "startCIHealWorker",
      "startCriticWorker",
      "startDiagnosisWorker",
      "startIssueFixWorker",
      "startMaintainerWorker",
      "startMergeQueueWorker",
      "startPatchWorker",
      "startPhase3Worker",
      "startPhase4Worker",
      "startSyncWorker",
      "startTriageWorker",
      "startVerificationWorker",
      "startWebhookWorker",
    ]);
  });

  it("derives the migration identity set from the migrations directory", () => {
    const { derived } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(derived.migrations).not.toBeNull();
    expect(derived.migrations.first).toBe("001");
    expect(derived.migrations.last).toBe("037");
    expect(derived.migrations.count).toBe(37);
  });

  it("derives the version from root package.json", () => {
    const { derived } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(derived.version).toBe("0.23.1");
  });

  it("each governed document's marker matches derived identities", () => {
    const { markerDataByDoc } = checkSourceOfTruth(MODULE_REPO_ROOT);
    expect(markerDataByDoc.size).toBe(3);
    for (const [doc, data] of markerDataByDoc) {
      expect(data.schemaVersion).toBe(1);
      expect(data.version).toBe("0.23.1");
      expect(data.services.length).toBe(10);
      expect(data.workers.length).toBe(14);
      expect(data.migrations).toEqual({ first: "001", last: "037", count: 37 });
      // also proves the key is the governed-doc relative path
      expect(doc).toMatch(/AGENTS\.md$|infrastructure\.md$|source-of-truth-inventory\.md$/);
    }
  });
});

// ─── Layer 2: drift detection via temporary fixtures ─────────────────────
//
// Every drift case builds a complete throwaway repo in mkdtempSync, mutates
// ONLY that fixture, and asserts the new identity-mismatch / migration
// violation codes. The checked-out tree is never touched.

const VALID_MARKER_BODY = `{
  "schemaVersion": 1,
  "version": "0.23.1",
  "services": ["gitwire-app", "postgres"],
  "workers": ["startWebhookWorker", "startTriageWorker"],
  "migrations": { "first": "001", "last": "037", "count": 37 }
}`;

const MARKER_BEGIN = "<!-- gitwire:source-of-truth:begin -->";
const MARKER_END = "<!-- gitwire:source-of-truth:end -->";

function wrapMarker(body) {
  return `${MARKER_BEGIN}\n\`\`\`json\n${body}\n\`\`\`\n${MARKER_END}`;
}

function buildCleanFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sot-gate-"));
  // Minimal tree that satisfies the derivers. Marker values match the
  // fixture's derived identities so the clean baseline passes.
  fs.writeFileSync(
    path.join(dir, "docker-compose.yml"),
    "services:\n  gitwire-app:\n    image: x\n  postgres:\n    image: y\n"
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.23.1" })
  );
  fs.mkdirSync(path.join(dir, "packages/web/src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages/web/src/index.js"),
    "const workers = [\n  startWebhookWorker(),\n  startTriageWorker(),\n];\n"
  );
  fs.mkdirSync(path.join(dir, "packages/web/db/migrations"), { recursive: true });
  // 37 stub migrations, contiguous 001..037, so the marker's count matches.
  for (let i = 1; i <= 37; i++) {
    const n = String(i).padStart(3, "0");
    fs.writeFileSync(path.join(dir, "packages/web/db/migrations", `${n}_f${n}.sql`), "-- stub\n");
  }
  // Governed docs with markers.
  const marker = wrapMarker(VALID_MARKER_BODY);
  fs.writeFileSync(path.join(dir, "AGENTS.md"), `# AGENTS\n\n${marker}\n`);
  fs.mkdirSync(path.join(dir, "docs/installation"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/installation/infrastructure.md"), `# Infra\n\n${marker}\n`);
  fs.writeFileSync(path.join(dir, "docs/installation/source-of-truth-inventory.md"), `# Inv\n\n${marker}\n`);
  return dir;
}

function codes(result) {
  return result.violations.map((v) => v.code).sort();
}

describe("source-of-truth gate — clean fixture passes", () => {
  let dir;
  beforeEach(() => { dir = buildCleanFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("returns zero violations on the clean fixture", () => {
    const result = checkSourceOfTruth(dir);
    expect(result.violations).toEqual([]);
  });
});

describe("source-of-truth gate — identity mismatch detection", () => {
  let dir;
  beforeEach(() => { dir = buildCleanFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function setMarkerBody(docRel, body) {
    const full = path.join(dir, docRel);
    const text = fs.readFileSync(full, "utf8");
    const next = text.replace(
      new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}`),
      wrapMarker(body)
    );
    fs.writeFileSync(full, next);
  }

  it("detects version drift via marker mismatch (IDENTITY_MISMATCH)", () => {
    setMarkerBody("AGENTS.md", VALID_MARKER_BODY.replace('"version": "0.23.1"', '"version": "9.9.9"'));
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toEqual(["IDENTITY_MISMATCH"]);
    const v = result.violations[0];
    expect(v.field).toBe("version");
    expect(v.document).toBe("AGENTS.md");
    expect(v.expected).toBe("0.23.1");
    expect(v.actual).toBe("9.9.9");
  });

  it("detects services drift via marker mismatch (IDENTITY_MISMATCH)", () => {
    // Replace one service name in the marker only — same count, wrong identity.
    setMarkerBody(
      "docs/installation/infrastructure.md",
      VALID_MARKER_BODY.replace('"gitwire-app", "postgres"', '"gitwire-app", "ghost-service"')
    );
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toEqual(["IDENTITY_MISMATCH"]);
    expect(result.violations[0].field).toBe("services");
    expect(result.violations[0].document).toBe("docs/installation/infrastructure.md");
  });

  it("detects workers drift via marker mismatch (IDENTITY_MISMATCH)", () => {
    setMarkerBody(
      "docs/installation/source-of-truth-inventory.md",
      VALID_MARKER_BODY.replace('"startTriageWorker"', '"startGhostWorker"')
    );
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toEqual(["IDENTITY_MISMATCH"]);
    expect(result.violations[0].field).toBe("workers");
    expect(result.violations[0].document).toBe("docs/installation/source-of-truth-inventory.md");
  });

  it("detects migration range drift via marker mismatch (IDENTITY_MISMATCH)", () => {
    // Change first/last/count together to a different internally-consistent
    // range (so schema validation passes) that does NOT match the fixture's
    // derived 001..037.
    setMarkerBody(
      "AGENTS.md",
      VALID_MARKER_BODY.replace(
        '"migrations": { "first": "001", "last": "037", "count": 37 }',
        '"migrations": { "first": "001", "last": "010", "count": 10 }'
      )
    );
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toEqual(["IDENTITY_MISMATCH"]);
    expect(result.violations[0].field).toBe("migrations");
  });

  it("does not cascade: one doc's identity mismatch does not flag other docs", () => {
    // Only mutate AGENTS.md; the other two docs stay clean.
    setMarkerBody("AGENTS.md", VALID_MARKER_BODY.replace('"version": "0.23.1"', '"version": "9.9.9"'));
    const result = checkSourceOfTruth(dir);
    // Exactly ONE violation — not three (one per doc).
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].document).toBe("AGENTS.md");
  });
});

describe("source-of-truth gate — migration derivation failures", () => {
  let dir;
  beforeEach(() => { dir = buildCleanFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("detects a migration sequence gap (MIGRATION_GAP)", () => {
    // Delete file 020 — creates a gap. Marker still says count:37, so the
    // mismatch would also fire, but the derivation failure suppresses
    // dependent identity comparison (cascade prevention).
    fs.rmSync(path.join(dir, "packages/web/db/migrations/020_f020.sql"));
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toContain("MIGRATION_GAP");
    // MIGRATION_GAP suppression: derived.migrations is null, so no
    // IDENTITY_MISMATCH on the migrations field.
    const mismatchFields = result.violations
      .filter((v) => v.code === "IDENTITY_MISMATCH")
      .map((v) => v.field);
    expect(mismatchFields).not.toContain("migrations");
  });

  it("detects a duplicate migration prefix (MIGRATION_DUPLICATE_NUMBER)", () => {
    // Add a second file with prefix 020.
    fs.writeFileSync(path.join(dir, "packages/web/db/migrations/020_dup.sql"), "-- dup\n");
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toContain("MIGRATION_DUPLICATE_NUMBER");
    // Suppressed dependent comparison.
    const mismatchFields = result.violations
      .filter((v) => v.code === "IDENTITY_MISMATCH")
      .map((v) => v.field);
    expect(mismatchFields).not.toContain("migrations");
  });

  it("detects a malformed migration filename (MIGRATION_MALFORMED_NAME)", () => {
    fs.writeFileSync(path.join(dir, "packages/web/db/migrations/foo.sql"), "-- bad\n");
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toContain("MIGRATION_MALFORMED_NAME");
    // A name failure suppresses gap evaluation: do NOT also expect MIGRATION_GAP.
    expect(codes(result)).not.toContain("MIGRATION_GAP");
    // And suppresses dependent identity comparison.
    const mismatchFields = result.violations
      .filter((v) => v.code === "IDENTITY_MISMATCH")
      .map((v) => v.field);
    expect(mismatchFields).not.toContain("migrations");
  });
});

describe("source-of-truth gate — source-read failures are fail-closed", () => {
  it("reports SOURCE_READ_FAILURE when the migrations directory is missing", () => {
    const dir = buildCleanFixture();
    fs.rmSync(path.join(dir, "packages/web/db/migrations"), { recursive: true, force: true });
    const result = checkSourceOfTruth(dir);
    expect(codes(result)).toContain("SOURCE_READ_FAILURE");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports SOURCE_READ_FAILURE when docker-compose.yml is missing", () => {
    const dir = buildCleanFixture();
    fs.rmSync(path.join(dir, "docker-compose.yml"));
    const result = checkSourceOfTruth(dir);
    const srcFails = result.violations.filter((v) => v.code === "SOURCE_READ_FAILURE");
    expect(srcFails.some((v) => v.field === "services")).toBe(true);
    // Suppressed dependent identity comparison.
    const mismatchFields = result.violations
      .filter((v) => v.code === "IDENTITY_MISMATCH")
      .map((v) => v.field);
    expect(mismatchFields).not.toContain("services");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
