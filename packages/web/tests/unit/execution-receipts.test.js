// tests/unit/execution-receipts.test.js
// Source-reading tests for execution receipt store and command templates.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const receiptStore = readSource("packages/web/src/lib/executionReceiptStore.js");
const cmdTemplates = readSource("packages/web/src/lib/validationCommandTemplates.js");
const artifactApplier = readSource("packages/web/src/lib/artifactApplier.js");
const sandboxRunner = readSource("packages/web/src/lib/sandboxRunner.js");
const sandboxExecutor = readSource("packages/web/src/lib/sandboxExecutor.js");
const sourceProvider = readSource("packages/web/src/lib/sourceSnapshotProvider.js");
const migration = readSource("packages/web/db/migrations/034_execution_receipts.sql");

// ════════════════════════════════════════════════════════════════════════════
// MIGRATION
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — migration", () => {
  it("creates execution_receipts table", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS execution_receipts/);
  });

  it("has receipt_hash as primary key", () => {
    expect(migration).toMatch(/receipt_hash\s+TEXT PRIMARY KEY/);
  });

  it("has receipt_ref as UNIQUE", () => {
    expect(migration).toMatch(/receipt_ref\s+TEXT UNIQUE NOT NULL/);
  });

  it("has content NOT NULL", () => {
    expect(migration).toMatch(/content\s+TEXT NOT NULL/);
  });

  it("has created_at timestamp", () => {
    expect(migration).toMatch(/created_at\s+TIMESTAMPTZ/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECEIPT STORE
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — receipt store", () => {
  it("exports computeReceiptHash", () => {
    expect(receiptStore).toMatch(/export function computeReceiptHash/);
  });

  it("exports storeReceipt", () => {
    expect(receiptStore).toMatch(/export async function storeReceipt/);
  });

  it("exports resolveReceipt", () => {
    expect(receiptStore).toMatch(/export async function resolveReceipt/);
  });

  it("exports verifyReceipt", () => {
    expect(receiptStore).toMatch(/export async function verifyReceipt/);
  });

  it("storeReceipt uses ON CONFLICT DO NOTHING (write-once)", () => {
    expect(receiptStore).toMatch(/ON CONFLICT \(receipt_hash\) DO NOTHING/);
  });

  it("verifyReceipt recomputes hash from resolved content", () => {
    expect(receiptStore).toMatch(/computeReceiptHash\(content\)/);
    expect(receiptStore).toMatch(/hash mismatch/);
  });

  it("computeReceiptHash uses sha256 with prefix", () => {
    expect(receiptStore).toMatch(/"sha256:" \+ crypto\.createHash/);
  });

  it("buildReceiptRef creates receipt: prefix", () => {
    expect(receiptStore).toMatch(/receipt:/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COMMAND TEMPLATES
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — command templates", () => {
  it("exports COMMAND_TEMPLATES map", () => {
    expect(cmdTemplates).toMatch(/export const COMMAND_TEMPLATES/);
  });

  it("maps lint to npm run lint", () => {
    expect(cmdTemplates).toMatch(/lint.*npm.*run.*lint/);
  });

  it("maps test to npm test", () => {
    expect(cmdTemplates).toMatch(/test.*npm.*test/);
  });

  it("exports resolveCommandTemplate", () => {
    expect(cmdTemplates).toMatch(/export function resolveCommandTemplate/);
  });

  it("resolveCommandTemplate throws for non-allowlisted", () => {
    expect(cmdTemplates).toMatch(/not allowlisted/);
  });

  it("ALLOWED_COMMAND_IDS derived from COMMAND_TEMPLATES keys", () => {
    expect(cmdTemplates).toMatch(/Object\.keys\(COMMAND_TEMPLATES\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ARTIFICT APPLIER
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — artifact applier", () => {
  it("exports applyArtifact", () => {
    expect(artifactApplier).toMatch(/export function applyArtifact/);
  });

  it("exports computeSnapshotHash", () => {
    expect(artifactApplier).toMatch(/export function computeSnapshotHash/);
  });

  it("fails when source file not found", () => {
    expect(artifactApplier).toMatch(/source file not found/);
  });

  it("fails on invalid edit range", () => {
    expect(artifactApplier).toMatch(/Invalid edit range/);
  });

  it("fails when line_end exceeds file length", () => {
    expect(artifactApplier).toMatch(/exceeds file length/);
  });

  it("applies edits in reverse order to preserve line numbers", () => {
    expect(artifactApplier).toMatch(/b\.line_start - a\.line_start/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX RUNNER — receipt building
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — sandbox runner receipt", () => {
  it("exports buildExecutionReceipt", () => {
    expect(sandboxRunner).toMatch(/export function buildExecutionReceipt/);
  });

  it("exports SANDBOX_IMAGE_DIGEST as node-executor-v1", () => {
    expect(sandboxRunner).toMatch(/sha256:node-executor-v1/);
  });

  it("receipt includes execution_backend_id", () => {
    expect(sandboxRunner).toMatch(/execution_backend_id/);
  });

  it("receipt includes executor_version", () => {
    expect(sandboxRunner).toMatch(/executor_version/);
  });

  it("receipt includes source_snapshot_hash", () => {
    expect(sandboxRunner).toMatch(/source_snapshot_hash/);
  });

  it("receipt includes per_command_exit_statuses", () => {
    expect(sandboxRunner).toMatch(/per_command_exit_statuses/);
  });

  it("receipt includes aggregate_exit_status", () => {
    expect(sandboxRunner).toMatch(/aggregate_exit_status/);
  });

  it("receipt includes limits_applied", () => {
    expect(sandboxRunner).toMatch(/limits_applied/);
  });

  it("receipt hash is content-addressed (no timestamps)", () => {
    const section = sandboxRunner.split("buildExecutionReceipt");
    expect(section[1]).toMatch(/createHash.*sha256/);
    expect(section[1]).toMatch(/NO timestamps/);
  });

  it("runSandboxVerification applies artifact before execution", () => {
    expect(sandboxRunner).toMatch(/applyArtifact/);
  });

  it("runSandboxVerification uses executor registry", () => {
    expect(sandboxRunner).toMatch(/getDefaultBackend|getBackend|executorRegistry/);
  });

  it("runSandboxVerification returns inconclusive on apply failure", () => {
    expect(sandboxRunner).toMatch(/artifact_apply_failed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX EXECUTOR
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — sandbox executor", () => {
  it("exports runSandboxExecution", () => {
    expect(sandboxExecutor).toMatch(/export async function runSandboxExecution/);
  });

  it("exports redactOutput", () => {
    expect(sandboxExecutor).toMatch(/export function redactOutput/);
  });

  it("uses child_process.spawn (no shell)", () => {
    expect(sandboxExecutor).toMatch(/import.*spawn.*child_process/);
  });

  it("resolves commands from templates (no raw shell)", () => {
    expect(sandboxExecutor).toMatch(/resolveCommandTemplate/);
  });

  it("uses minimal env (no secrets/tokens)", () => {
    expect(sandboxExecutor).toMatch(/NODE_ENV.*production/);
  });

  it("enforces wall-clock timeout", () => {
    expect(sandboxExecutor).toMatch(/wall_clock_ms|SIGKILL/);
  });

  it("enforces output byte limit", () => {
    expect(sandboxExecutor).toMatch(/output_bytes|maxOutputBytes/);
  });

  it("cleans up workspace after execution", () => {
    expect(sandboxExecutor).toMatch(/recursive: true.*force: true/);
  });

  it("redacts GitHub tokens from output", () => {
    expect(sandboxExecutor).toMatch(/ghp_|github_pat/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE SNAPSHOT PROVIDER
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — source snapshot provider", () => {
  it("exports acquireSourceSnapshot", () => {
    expect(sourceProvider).toMatch(/export async function acquireSourceSnapshot/);
  });

  it("requires octokit client", () => {
    expect(sourceProvider).toMatch(/octokit client is required/);
  });

  it("requires baseSha (pinned, not floating)", () => {
    expect(sourceProvider).toMatch(/baseSha is required/);
  });

  it("fetches git trees at base_sha", () => {
    expect(sourceProvider).toMatch(/git\/trees/);
  });

  it("fetches blob contents", () => {
    expect(sourceProvider).toMatch(/git\/blobs/);
  });

  it("computes snapshot hash from file contents", () => {
    expect(sourceProvider).toMatch(/computeSnapshotHash/);
  });

  it("rejects truncated trees", () => {
    expect(sourceProvider).toMatch(/truncated/);
  });

  it("does NOT silently skip blobs (fail-closed)", () => {
    expect(sourceProvider).not.toMatch(/Skipping large blob/);
    expect(sourceProvider).not.toMatch(/Failed to fetch blob.*skipping/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECORD VERIFICATION RESULT — receipt integration
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — recordVerificationResult integration", () => {
  it("requires receipt ref and hash for pass results", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/execution_receipt_ref and execution_receipt_hash are required/);
  });

  it("uses shared verifyExecutionReceiptAgainstLockedProposal", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/verifyExecutionReceiptAgainstLockedProposal/);
  });

  it("persists receipt ref and hash in validation_result", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordVerificationResult");
    expect(section[1]).toMatch(/execution_receipt_ref: verificationInput\.execution_receipt_ref/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// RECORD CRITIC REVIEW — receipt-backed approval
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — recordCriticReview receipt-backed approval", () => {
  it("uses shared verifyExecutionReceiptAgainstLockedProposal helper", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/verifyExecutionReceiptAgainstLockedProposal/);
  });

  it("requires receipt ref/hash from validation_result for approve", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/validation_result has no execution_receipt_ref/);
  });

  it("approve can target review_ready (not unconditionally failed)", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    const section = repairService.split("export async function recordCriticReview");
    expect(section[1]).toMatch(/review_ready/);
    expect(section[1]).not.toMatch(/no receipt backend available/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SHARED RECEIPT VERIFIER — pass-capable backends and source snapshot
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — shared verifier hardening", () => {
  it("ALLOWED_PASS_EXECUTION_BACKENDS is empty", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    expect(repairService).toMatch(/ALLOWED_PASS_EXECUTION_BACKENDS/);
    // Must be empty — node-executor cannot authorize pass
    const section = repairService.split("ALLOWED_PASS_EXECUTION_BACKENDS");
    expect(section[1]).toMatch(/empty until.*backend lands/i);
  });

  it("rejects node-executor pass receipts", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    expect(repairService).toMatch(/not authorized to produce passing results/);
  });

  it("verifies source_snapshot_hash against durable source snapshot store", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    expect(repairService).toMatch(/source_snapshot_hash/);
    expect(repairService).toMatch(/verifySourceSnapshot/);
  });

  it("requires source_snapshot_hash on receipt", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    expect(repairService).toMatch(/must contain source_snapshot_hash/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE SNAPSHOT STORE
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — source snapshot store", () => {
  const snapshotStore = readSource("packages/web/src/lib/sourceSnapshotStore.js");
  const migration = readSource("packages/web/db/migrations/035_source_snapshots.sql");

  it("migration creates source_snapshots table", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS source_snapshots/);
  });

  it("migration has repo_full_name and base_sha", () => {
    expect(migration).toMatch(/repo_full_name/);
    expect(migration).toMatch(/base_sha/);
  });

  it("migration uses composite PK (snapshot_hash, repo_full_name, base_sha)", () => {
    expect(migration).toMatch(/PRIMARY KEY \(snapshot_hash, repo_full_name, base_sha\)/);
  });

  it("migration documents cross-repo collision prevention", () => {
    expect(migration).toMatch(/cross-repo collision/);
  });

  it("exports storeSourceSnapshot", () => {
    expect(snapshotStore).toMatch(/export async function storeSourceSnapshot/);
  });

  it("exports resolveSourceSnapshot", () => {
    expect(snapshotStore).toMatch(/export async function resolveSourceSnapshot/);
  });

  it("exports verifySourceSnapshot", () => {
    expect(snapshotStore).toMatch(/export async function verifySourceSnapshot/);
  });

  it("exports buildFileManifest", () => {
    expect(snapshotStore).toMatch(/export function buildFileManifest/);
  });

  it("storeSourceSnapshot uses composite ON CONFLICT", () => {
    expect(snapshotStore).toMatch(/ON CONFLICT \(snapshot_hash, repo_full_name, base_sha\) DO NOTHING/);
  });

  it("resolveSourceSnapshot queries by composite key", () => {
    expect(snapshotStore).toMatch(/WHERE snapshot_hash = \$1 AND repo_full_name = \$2 AND base_sha = \$3/);
  });

  it("verifySourceSnapshot uses composite resolution", () => {
    expect(snapshotStore).toMatch(/resolveSourceSnapshot\(snapshotHash, expectedRepoFullName, expectedBaseSha\)/);
  });

  it("sourceSnapshotProvider stores durable snapshot", () => {
    const sourceProvider = readSource("packages/web/src/lib/sourceSnapshotProvider.js");
    expect(sourceProvider).toMatch(/storeSourceSnapshot/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OUTPUT REFS — non-authoritative metadata documentation
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts — output refs are non-authoritative", () => {
  it("documents output refs as non-authoritative", () => {
    const repairService = readSource("packages/web/src/services/repairProposalService.js");
    expect(repairService).toMatch(/NON-AUTHORITATIVE receipt metadata/);
    expect(repairService).toMatch(/not part of the proof chain/);
  });
});
