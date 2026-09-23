// D0-02 — deterministic issue-fix candidate/policy validation and truthful dry-run evidence.

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

const {
  validatePatchCandidates,
  validateFixes,
  countLineEdits,
  normalizeFixConfidence,
} = await import("../../src/workers/issueFix/validate.js");

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
    [[{ path: "src/a.js\u0000x", fixed_content: "x" }], [originalJs], "invalid repository-relative path"],
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

describe("line-change/confidence policy normalization", () => {
  it("counts substitutions as one deletion plus one insertion", () => {
    expect(countLineEdits("a\nb\nc", "a\nx\nc", 10)).toBe(2);
    expect(countLineEdits("a\nb", "a\nb\nc", 10)).toBe(1);
  });

  it("bounds work and reports over-limit edits", () => {
    expect(countLineEdits("a\nb\nc", "x\ny\nz", 1)).toBeGreaterThan(1);
  });

  it("normalizes legacy numeric confidence without weakening the gate", () => {
    expect(normalizeFixConfidence(1)).toBe("low");
    expect(normalizeFixConfidence(2)).toBe("medium");
    expect(normalizeFixConfidence(3)).toBe("high");
    expect(normalizeFixConfidence("3")).toBe("high");
    expect(normalizeFixConfidence("garbage")).toBe("medium");
  });
});

describe("validateFixes evidence semantics", () => {
  const baseCtx = {
    octokit: {}, owner: "octo", repoName: "repo", repoId: "99", issueNumber: 42,
    branchName: "gitwire/fix-42", repoConfig: { pillars: { issue_fix: {} } },
    repo: "octo/repo", principalId: "principal-1", requestedByPrincipalId: "requester-1",
    triggeredBy: "api", _scope: { baseSha: "abc1234" },
  };
  const analysis = { complexity: "trivial", explanation: "small fix" };
  const generated = {
    fixes: [{ path: "src/a.js", fixed_content: "const a = 2;\n" }],
    fileContents: [originalJs],
  };

  it("does not call risk scoring when deterministic candidate validation fails", async () => {
    await validateFixes(baseCtx, analysis, {
      fixes: [{ path: "config/a.json", fixed_content: "{not-json}" }],
      fileContents: [originalJson],
    });
    expect(mockScoreFixRisk).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("enforces configured max_line_changes before proposal", async () => {
    await validateFixes({
      ...baseCtx,
      repoConfig: { pillars: { issue_fix: { max_line_changes: 1 } } },
    }, analysis, generated);

    expect(mockPropose).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith(
      "99", 42, "gitwire/fix-42", "rejected", "trivial", "small fix",
      expect.stringContaining("max_line_changes"),
    );
  });

  it("clamps oversized max_file_changes to the safety ceiling instead of reverting to the tiny default", async () => {
    const originals = [1, 2, 3, 4].map((n) => ({
      path: `src/f${n}.js`,
      content: `const v${n} = 1;\n`,
      sha: `blob-${n}`,
    }));
    const fixes = originals.map((file, index) => ({
      path: file.path,
      fixed_content: `const v${index + 1} = 2;\n`,
    }));

    await validateFixes({
      ...baseCtx,
      repoConfig: { pillars: { issue_fix: { max_file_changes: 150 } } },
    }, analysis, { fixes, fileContents: originals });

    expect(mockPropose).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockComment).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.stringContaining("Fix touches 4 files (max: 3)"),
    );
  });

  it("passes normalized high confidence to the rule comparison", async () => {
    mockGetMinFixConfidence.mockReturnValue(3);
    mockMeetsConfidence.mockImplementation((_actual, required) => required === "high");
    await validateFixes(baseCtx, analysis, generated);
    expect(mockMeetsConfidence).toHaveBeenCalledWith("high", "high");
  });

  it("records dry_run rather than falsely claiming submitted", async () => {
    mockIsDryRun.mockReturnValue(true);
    await expect(validateFixes(baseCtx, analysis, generated)).resolves.toBeNull();

    expect(mockCancel).toHaveBeenCalledWith("action-1", "Dry-run mode");
    expect(mockUpsert).toHaveBeenCalledWith(
      "99", 42, "gitwire/fix-42", "dry_run", "trivial", "small fix", null, null,
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
