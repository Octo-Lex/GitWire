// Tests for executor_report_hash computation (v0.23.0 Task 5, step 1-2).
//
// The hash is content-addressed over the canonical JSON of the report object
// MINUS the executor_report_hash field itself. Mirrors GitWire's execution-
// receipt pattern. Pure function — no I/O.

import { describe, it, expect } from "@jest/globals";
import { computeExecutorReportHash, buildExecutorReportRef } from "../src/executorReportHash.js";

const SAMPLE_REPORT = Object.freeze({
  report_schema_version: 1,
  executor_service_id: "executor-service",
  executor_service_version: "1.0.0",
  executor_service_instance_id: "inst-123",
  deployment_mode: "compose-local",
  container_runtime: "docker",
  runtime_version: "29.5.0",
  validator_image_ref: "registry.example.com/v@sha256:" + "a".repeat(64),
  validator_image_digest: "sha256:" + "a".repeat(64),
  inspected_image_digest: "sha256:" + "a".repeat(64),
  inspection_hash: "sha256:" + "b".repeat(64),
  network_disabled: true,
  non_root: true,
  read_only_rootfs: true,
  resource_limits: { memory_mb: 512, pids_limit: 64 },
  command_results: [{ command: "lint", exit_status: 0, output_hash: "sha256:" + "c".repeat(64), duration_ms: 100 }],
  aggregate_exit_status: 0,
  overall: "pass",
});

describe("computeExecutorReportHash — shape", () => {
  it("returns a sha256: prefixed string", () => {
    const h = computeExecutorReportHash(SAMPLE_REPORT);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("computeExecutorReportHash — determinism", () => {
  it("identical reports produce identical hashes", () => {
    const a = computeExecutorReportHash(SAMPLE_REPORT);
    const b = computeExecutorReportHash(SAMPLE_REPORT);
    expect(a).toBe(b);
  });

  it("excludes the executor_report_hash field from the hash input (can be added without changing the hash)", () => {
    // The hash is computed over the report MINUS executor_report_hash. Adding
    // the field back (with any value) must not change the hash — that's the
    // whole point: the report can self-reference its own hash.
    const withoutHash = computeExecutorReportHash(SAMPLE_REPORT);
    const withHash = computeExecutorReportHash({ ...SAMPLE_REPORT, executor_report_hash: withoutHash });
    expect(withHash).toBe(withoutHash);
  });

  it("excludes the executor_report_ref field from the hash input too", () => {
    // The ref is derived from the hash; including it would be circular.
    const withoutRef = computeExecutorReportHash(SAMPLE_REPORT);
    const withRef = computeExecutorReportHash({ ...SAMPLE_REPORT, executor_report_ref: "executor-report:" + withoutRef });
    expect(withRef).toBe(withoutRef);
  });
});

describe("computeExecutorReportHash — sensitivity", () => {
  it("changes when any load-bearing field changes (overall)", () => {
    const base = computeExecutorReportHash(SAMPLE_REPORT);
    const modified = computeExecutorReportHash({ ...SAMPLE_REPORT, overall: "fail" });
    expect(modified).not.toBe(base);
  });

  it("changes when aggregate_exit_status changes", () => {
    const base = computeExecutorReportHash(SAMPLE_REPORT);
    const modified = computeExecutorReportHash({ ...SAMPLE_REPORT, aggregate_exit_status: 1 });
    expect(modified).not.toBe(base);
  });

  it("changes when inspected_image_digest changes", () => {
    const base = computeExecutorReportHash(SAMPLE_REPORT);
    const modified = computeExecutorReportHash({
      ...SAMPLE_REPORT,
      inspected_image_digest: "sha256:" + "9".repeat(64),
    });
    expect(modified).not.toBe(base);
  });
});

describe("buildExecutorReportRef", () => {
  it("returns 'executor-report:<hash>' from a hash", () => {
    const hash = "sha256:" + "a".repeat(64);
    expect(buildExecutorReportRef(hash)).toBe("executor-report:sha256:" + "a".repeat(64));
  });

  it("is idempotent with computeExecutorReportHash", () => {
    const hash = computeExecutorReportHash(SAMPLE_REPORT);
    const ref = buildExecutorReportRef(hash);
    expect(ref).toBe(`executor-report:${hash}`);
  });
});
