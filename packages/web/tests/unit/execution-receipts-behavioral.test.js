// tests/unit/execution-receipts-behavioral.test.js
// Behavioral tests for execution receipt components.

import { jest } from "@jest/globals";

// ════════════════════════════════════════════════════════════════════════════
// MOCK SETUP
// ════════════════════════════════════════════════════════════════════════════

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

const {
  applyArtifact,
  computeSnapshotHash,
} = await import("../../src/lib/artifactApplier.js");

const {
  resolveCommandTemplate,
  isAllowedCommandId,
  ALLOWED_COMMAND_IDS,
} = await import("../../src/lib/validationCommandTemplates.js");

const {
  buildExecutionReceipt,
  buildValidationPlan,
  computeVerificationFingerprint,
  SANDBOX_IMAGE_DIGEST,
} = await import("../../src/lib/sandboxRunner.js");

const {
  redactOutput,
} = await import("../../src/lib/sandboxExecutor.js");

// ════════════════════════════════════════════════════════════════════════════
// ARTIFICT APPLIER
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — artifact applier", () => {
  const sourceFiles = [
    { path: "src/index.js", content: "line1\nline2\nline3\nline4\nline5" },
    { path: "README.md", content: "# Title\nSome text" },
  ];

  it("applies a simple edit correctly", () => {
    const artifact = {
      base_sha: "abc123",
      files: [
        {
          path: "src/index.js",
          change_type: "fix",
          edits: [
            { line_start: 2, line_end: 3, new_content: "replaced" },
          ],
        },
      ],
    };

    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(true);
    const modifiedFile = result.files.find((f) => f.path === "src/index.js");
    expect(modifiedFile.content).toBe("line1\nreplaced\nline4\nline5");
  });

  it("applies multiple edits to the same file in reverse order", () => {
    const artifact = {
      base_sha: "abc123",
      files: [
        {
          path: "src/index.js",
          edits: [
            { line_start: 1, line_end: 1, new_content: "AAA" },
            { line_start: 4, line_end: 5, new_content: "BBB" },
          ],
        },
      ],
    };

    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(true);
    const modifiedFile = result.files.find((f) => f.path === "src/index.js");
    expect(modifiedFile.content).toBe("AAA\nline2\nline3\nBBB");
  });

  it("fails when source file not found", () => {
    const artifact = {
      base_sha: "abc123",
      files: [
        { path: "src/missing.js", edits: [{ line_start: 1, line_end: 1, new_content: "x" }] },
      ],
    };

    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(false);
    expect(result.failure).toMatch(/source file not found/);
  });

  it("fails when line_end exceeds file length", () => {
    const artifact = {
      base_sha: "abc123",
      files: [
        { path: "src/index.js", edits: [{ line_start: 1, line_end: 100, new_content: "x" }] },
      ],
    };

    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(false);
    expect(result.failure).toMatch(/exceeds file length/);
  });

  it("fails when artifact has no files", () => {
    const result = applyArtifact(sourceFiles, { base_sha: "abc", files: [] });
    expect(result.applied).toBe(false);
  });

  it("fails when edit has no edits array", () => {
    const artifact = {
      base_sha: "abc",
      files: [{ path: "src/index.js", edits: [] }],
    };
    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(false);
  });

  it("preserves unmodified files in the result", () => {
    const artifact = {
      base_sha: "abc",
      files: [{ path: "src/index.js", edits: [{ line_start: 1, line_end: 1, new_content: "new" }] }],
    };

    const result = applyArtifact(sourceFiles, artifact);
    expect(result.applied).toBe(true);
    const readme = result.files.find((f) => f.path === "README.md");
    expect(readme.content).toBe("# Title\nSome text");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SNAPSHOT HASH
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — snapshot hash", () => {
  it("is deterministic for the same file set", () => {
    const files = [{ path: "a.js", content: "x" }, { path: "b.js", content: "y" }];
    const hash1 = computeSnapshotHash(files);
    const hash2 = computeSnapshotHash(files);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:/);
  });

  it("is order-independent (sorts by path)", () => {
    const files1 = [{ path: "a.js", content: "x" }, { path: "b.js", content: "y" }];
    const files2 = [{ path: "b.js", content: "y" }, { path: "a.js", content: "x" }];
    expect(computeSnapshotHash(files1)).toBe(computeSnapshotHash(files2));
  });

  it("changes when content changes", () => {
    const files1 = [{ path: "a.js", content: "x" }];
    const files2 = [{ path: "a.js", content: "y" }];
    expect(computeSnapshotHash(files1)).not.toBe(computeSnapshotHash(files2));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// COMMAND TEMPLATES
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — command templates", () => {
  it("resolves lint to npm run lint argv", () => {
    const argv = resolveCommandTemplate("lint");
    expect(argv).toEqual(["npm", "run", "lint", "--"]);
  });

  it("resolves test to npm test argv", () => {
    const argv = resolveCommandTemplate("test");
    expect(argv).toEqual(["npm", "test", "--"]);
  });

  it("throws for non-allowlisted command", () => {
    expect(() => resolveCommandTemplate("rm -rf /")).toThrow(/not allowlisted/);
  });

  it("isAllowedCommandId returns true for lint", () => {
    expect(isAllowedCommandId("lint")).toBe(true);
  });

  it("isAllowedCommandId returns false for arbitrary command", () => {
    expect(isAllowedCommandId("evil_command")).toBe(false);
  });

  it("ALLOWED_COMMAND_IDS includes lint, test, build, typecheck", () => {
    expect(ALLOWED_COMMAND_IDS.has("lint")).toBe(true);
    expect(ALLOWED_COMMAND_IDS.has("test")).toBe(true);
    expect(ALLOWED_COMMAND_IDS.has("build")).toBe(true);
    expect(ALLOWED_COMMAND_IDS.has("typecheck")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EXECUTION RECEIPT BUILDING
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — receipt building", () => {
  const receiptParams = {
    execution_backend_id: "node-executor",
    executor_version: "1.0.0",
    source_snapshot_hash: "sha256:snap123",
    patch_artifact_hash: "sha256:art456",
    base_sha: "abc123",
    input_bundle_hash: "sha256:bundle789",
    sandbox_image_digest: SANDBOX_IMAGE_DIGEST,
    validation_plan_hash: "sha256:plan000",
    commands_executed: ["lint", "test"],
    per_command_exit_statuses: [0, 0],
    aggregate_exit_status: 0,
    output_refs: ["output:sha256:out1", "output:sha256:out2"],
    output_hashes: ["sha256:out1", "sha256:out2"],
    limits_applied: { cpu_shares: 512, memory_mb: 512 },
    result: "pass",
  };

  it("produces a sha256: prefixed hash", () => {
    const receipt = buildExecutionReceipt(receiptParams);
    expect(receipt.receipt_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces a receipt: prefixed ref", () => {
    const receipt = buildExecutionReceipt(receiptParams);
    expect(receipt.receipt_ref).toMatch(/^receipt:sha256:/);
  });

  it("is deterministic for the same inputs", () => {
    const r1 = buildExecutionReceipt(receiptParams);
    const r2 = buildExecutionReceipt(receiptParams);
    expect(r1.receipt_hash).toBe(r2.receipt_hash);
  });

  it("changes when any binding changes", () => {
    const r1 = buildExecutionReceipt(receiptParams);
    const r2 = buildExecutionReceipt({ ...receiptParams, base_sha: "different" });
    expect(r1.receipt_hash).not.toBe(r2.receipt_hash);
  });

  it("changes when result changes", () => {
    const r1 = buildExecutionReceipt(receiptParams);
    const r2 = buildExecutionReceipt({ ...receiptParams, result: "fail" });
    expect(r1.receipt_hash).not.toBe(r2.receipt_hash);
  });

  it("changes when exit statuses change", () => {
    const r1 = buildExecutionReceipt(receiptParams);
    const r2 = buildExecutionReceipt({ ...receiptParams, per_command_exit_statuses: [0, 1] });
    expect(r1.receipt_hash).not.toBe(r2.receipt_hash);
  });

  it("receipt content is valid JSON with all bindings", () => {
    const receipt = buildExecutionReceipt(receiptParams);
    const parsed = JSON.parse(receipt.receipt_content);
    expect(parsed.execution_backend_id).toBe("node-executor");
    expect(parsed.executor_version).toBe("1.0.0");
    expect(parsed.source_snapshot_hash).toBe("sha256:snap123");
    expect(parsed.patch_artifact_hash).toBe("sha256:art456");
    expect(parsed.base_sha).toBe("abc123");
    expect(parsed.input_bundle_hash).toBe("sha256:bundle789");
    expect(parsed.sandbox_image_digest).toBe(SANDBOX_IMAGE_DIGEST);
    expect(parsed.validation_plan_hash).toBe("sha256:plan000");
    expect(parsed.commands).toEqual(["lint", "test"]);
    expect(parsed.per_command_exit_statuses).toEqual([0, 0]);
    expect(parsed.aggregate_exit_status).toBe(0);
    expect(parsed.output_refs).toHaveLength(2);
    expect(parsed.output_hashes).toHaveLength(2);
    expect(parsed.limits_applied).toBeDefined();
    expect(parsed.result).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// OUTPUT REDACTION
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — output redaction", () => {
  it("redacts GitHub PAT tokens", () => {
    const output = "some output ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA more text";
    const redacted = redactOutput(output);
    expect(redacted).not.toMatch(/ghp_/);
    expect(redacted).toMatch(/\[REDACTED\]/);
  });

  it("redacts GitHub OAuth tokens", () => {
    const output = "token: gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const redacted = redactOutput(output);
    expect(redacted).not.toMatch(/gho_/);
  });

  it("truncates output exceeding max bytes", () => {
    const large = "x".repeat(2048);
    const redacted = redactOutput(large, 1024);
    expect(redacted.length).toBeLessThan(1100); // truncated + message
    expect(redacted).toMatch(/\[output truncated\]/);
  });

  it("handles empty output", () => {
    expect(redactOutput("")).toBe("");
    expect(redactOutput(null)).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// VERIFICATION FINGERPRINT + PLAN (unchanged contract)
// ════════════════════════════════════════════════════════════════════════════

describe("Execution Receipts behavioral — plan and fingerprint", () => {
  it("buildValidationPlan produces sorted commands and hash", () => {
    const plan = buildValidationPlan({ required_validation: ["test", "lint"] });
    expect(plan.commands).toEqual(["lint", "test"]); // sorted
    expect(plan.validation_plan_hash).toMatch(/^sha256:/);
  });

  it("computeVerificationFingerprint is deterministic", () => {
    const fp1 = computeVerificationFingerprint({
      patch_artifact_hash: "sha256:a",
      base_sha: "b",
      input_bundle_hash: "sha256:c",
      sandbox_image_digest: "sha256:d",
      validation_plan_hash: "sha256:e",
    });
    const fp2 = computeVerificationFingerprint({
      patch_artifact_hash: "sha256:a",
      base_sha: "b",
      input_bundle_hash: "sha256:c",
      sandbox_image_digest: "sha256:d",
      validation_plan_hash: "sha256:e",
    });
    expect(fp1).toBe(fp2);
  });
});
