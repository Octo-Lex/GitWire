// D0-02 — deterministic issue-fix candidate validation and truthful dry-run evidence.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockIsFixPathBlocked = jest.fn();
const mockIsDryRun = jest.fn();
const mockMeetsConfidence = jest.fn();
const mockGetMinFixConfidence = jest.fn();
const mockScoreFixRisk = jest.fn();
const mockPropose = jest.fn();
const mockApprove = jest.fn();
const mockExecute = jest.fn();
const mockCancel = jest.fn();
const mockUpsert = jest.fn();
const mockComment = jest.fn();

jest.unstable_mockModule("@gitwire/rules", () => ({
  isFixPathBlocked: mockIsFixPathBlocked,
  isDryRun: mockIsDryRun,
  meetsConfidence: mockMeetsConfidence,
  getMinFixConfidence: mockGetMinFixConfidence,
  scoreFixRisk: mockScoreFixRisk,
}));
jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: mockPropose,
  approve: mockApprove,
  execute: mockExecute,
  cancel: mockCancel,
}));
jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: mockUpsert,
  postIssueComment: mockComment,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { validatePatchCandidates, validateFixes } = await import("../../src/workers/issueFix/validate.js");

const originalJs = { path: "src/a.js", content: "const a = 1;\n", sha: "blob-a" };
const originalJson = { path: "config/a.json", content: "{\"ok\":true}\n", sha: "blob-json" };

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFixPathBlocked.mockReturnValue(false);
  mockIsDryRun.mockReturnValue(false);
  mockMeetsConfidence.mockReturnValue(true);
  mockGetMinFixConfidence.mockReturnValue("medium");
  mockScoreFixRisk.mockReturnValue({ score: 5, level: "low", reasons: [] });
  mockPropose.mockResolvedValue({ id: "action-1" });
  mockApprove.mockResolvedValue({});
  mockExecute.mockResolvedValue({});
  mockCancel.mockResolvedValue({});
  mockUpsert.mockResolvedValue({});
  mockComment.mockResolvedValue({});
});

describe("validatePatchCandidates", () => {
  it("accepts a changed exact-head file", () => {
    expect(validatePatchCandidates(
      [{ path: "src/a.js", fixed_content: "const a = 2;\n" }],
      [originalJs],
    )).toEqual({ valid: true, reasons: [] });
  });

  it.each([
    [[{ path: "../secret", fixed_content: "x" }], [originalJs], "invalid repository-relative path"],
    [[{ path: "/etc/passwd", fixed_content: "x" }], [originalJs], "invalid repository-relative path"],
    [[{ path: "src/a.js", fixed_content: 123 }], [originalJs], "fixed_content must be a string"],
    [[{ path: "src/missing.js", fixed_content: "x" }], [originalJs], "No exact-head original content"],
    [[{ path: "src/a.js", fixed_content: originalJs.content }], [originalJs], "identical content"],
    [[
      { path: "src/a.js", fixed_content: "const a = 2;\n" },
      { path: "src/a.js", fixed_content: "const a = 3;\n" },
    ], [originalJs], "duplicate generated path"],
    [[{ path: "config/a.json", fixed_content: "{not-json}" }], [originalJson], "invalid JSON"],
  ])("rejects unsafe/malformed candidate sets", (fixes, originals, expectedReason) => {
    const result = validatePatchCandidates(fixes, originals);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain(expectedReason);
  });

  it("treats every deterministic reason as fatal, even when another file is valid", () => {
    const result = validatePatchCandidates([
      { path: "src/a.js", fixed_content: "const a = 2;\n" },
      { path: "config/a.json", fixed_content: "{not-json}" },
    ], [originalJs, originalJson]);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("invalid JSON");
  });
});

describe("validateFixes evidence semantics", () => {
  const ctx = {
    octokit: {}, owner: "octo", repoName: "repo", repoId: "99", issueNumber: 42,
    branchName: "gitwire/fix-42", repoConfig: { pillars: { issue_fix: {} } },
    repo: "octo/repo", principalId: "principal-1", _scope: { baseSha: "abc1234" },
  };
  const analysis = { complexity: "trivial", explanation: "small fix" };
  const generated = {
    fixes: [{ path: "src/a.js", fixed_content: "const a = 2;\n" }],
    fileContents: [originalJs],
  };

  it("does not call risk scoring when deterministic candidate validation fails", async () => {
    await validateFixes(ctx, analysis, {
      fixes: [{ path: "config/a.json", fixed_content: "{not-json}" }],
      fileContents: [originalJson],
    });
    expect(mockScoreFixRisk).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("records dry_run rather than falsely claiming submitted", async () => {
    mockIsDryRun.mockReturnValue(true);
    await expect(validateFixes(ctx, analysis, generated)).resolves.toBeNull();

    expect(mockCancel).toHaveBeenCalledWith("action-1", "Dry-run mode");
    expect(mockUpsert).toHaveBeenCalledWith(
      "99", 42, "gitwire/fix-42", "dry_run", "trivial", "small fix", null, null,
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
