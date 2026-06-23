// Tests for executor report persistence (v0.23.0 Task 6, step 1-2).
//
// storeExecutorReport() persists the raw executor report content into the
// execution_receipts table using the service-provided hash + ref (Shape B
// from the design doc). The ref uses the 'executor-report:' prefix so it's
// distinguishable from GitWire's own receipts ('receipt:').
//
// resolveExecutorReport() resolves an executor_report_ref back to the raw
// content. verifyExecutorReport() resolves + recomputes the hash + compares.
//
// These tests mock db.query so no real Postgres is needed.

import { describe, it, expect, beforeEach } from "@jest/globals";

// Mock the db module before importing the store.
import { jest } from "@jest/globals";
jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: {
    query: jest.fn(async () => ({ rows: [] })),
  },
}));

// The store uses the runtime logger; initialize it before importing.
import { setConfig } from "@gitwire/runtime/compat/_init.js";
setConfig({
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgresql://localhost/gitops_hub",
  GITHUB_APP_ID: "test",
  GITHUB_PRIVATE_KEY: "test",
});

const { storeExecutorReport, resolveExecutorReport, verifyExecutorReportHash } =
  await import("../../src/lib/executionReceiptStore.js");
const { db } = await import("../../src/lib/db.js");

const RAW_REPORT = JSON.stringify({
  report_schema_version: 1,
  executor_service_id: "executor-service",
  overall: "pass",
  aggregate_exit_status: 0,
  executor_report_hash: "sha256:" + "a".repeat(64),
});
const REPORT_HASH = "sha256:" + "a".repeat(64);
const REPORT_REF = `executor-report:${REPORT_HASH}`;

describe("storeExecutorReport — Shape B persistence", () => {
  beforeEach(() => db.query.mockClear());

  it("stores the raw report with the service-provided hash + ref", async () => {
    await storeExecutorReport(RAW_REPORT, REPORT_HASH, REPORT_REF);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO execution_receipts"),
      [REPORT_HASH, REPORT_REF, RAW_REPORT]
    );
    expect(db.query.mock.calls[0][0]).toContain("ON CONFLICT");
  });

  it("returns { ref, hash }", async () => {
    const result = await storeExecutorReport(RAW_REPORT, REPORT_HASH, REPORT_REF);
    expect(result).toEqual({ ref: REPORT_REF, hash: REPORT_HASH });
  });
});

describe("resolveExecutorReport — ref → raw content", () => {
  beforeEach(() => db.query.mockClear());

  it("queries by executor_report_ref and returns content", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ content: RAW_REPORT }] });
    const content = await resolveExecutorReport(REPORT_REF);
    expect(content).toBe(RAW_REPORT);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT content FROM execution_receipts WHERE receipt_ref"),
      [REPORT_REF]
    );
  });

  it("throws when the ref does not resolve (not persisted)", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveExecutorReport("executor-report:sha256:nonexistent")).rejects.toThrow(/not found/);
  });
});

describe("verifyExecutorReportHash — resolve + recompute + compare", () => {
  beforeEach(() => db.query.mockClear());

  it("returns true when the recomputed hash matches the stored hash", async () => {
    // Build a report whose hash excludes the hash/ref fields (matching
    // executorReportHash.js's computeExecutorReportHash contract).
    const reportObj = {
      report_schema_version: 1,
      executor_service_id: "executor-service",
      overall: "pass",
      aggregate_exit_status: 0,
    };
    const crypto = await import("node:crypto");
    const canonical = JSON.stringify(reportObj);
    const hash = "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex");
    const reportWithHash = JSON.stringify({ ...reportObj, executor_report_hash: hash });
    const ref = `executor-report:${hash}`;

    db.query.mockResolvedValueOnce({ rows: [{ content: reportWithHash }] });
    const result = await verifyExecutorReportHash(ref, hash);
    expect(result).toBe(true);
  });

  it("returns false when the recomputed hash does NOT match (tampered report)", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ content: JSON.stringify({ overall: "pass", executor_report_hash: "sha256:fake" }) }],
    });
    const result = await verifyExecutorReportHash("executor-report:sha256:fake", "sha256:fake");
    expect(result).toBe(false);
  });

  it("throws when the ref does not resolve (report not persisted)", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      verifyExecutorReportHash("executor-report:sha256:nonexistent", "sha256:nonexistent")
    ).rejects.toThrow(/not found/);
  });
});
