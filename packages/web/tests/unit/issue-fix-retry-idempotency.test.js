// tests/unit/issue-fix-retry-idempotency.test.js
// Regression coverage for issue-fix idempotency placement + D0-02 resource scope.

import { jest } from "@jest/globals";

const mockCheckAndMark = jest.fn();
const mockInitFixContext = jest.fn();
const mockValidateScope = jest.fn();
const mockAnalyzeIssue = jest.fn();
const mockGenerateFixes = jest.fn();
const mockValidateFixes = jest.fn();
const mockSubmitFix = jest.fn();

jest.unstable_mockModule("../../src/services/idempotencyService.js", () => ({
  checkAndMark: mockCheckAndMark,
}));
jest.unstable_mockModule("../../src/workers/issueFix/context.js", () => ({ initFixContext: mockInitFixContext }));
jest.unstable_mockModule("../../src/workers/issueFix/scopeGuard.js", () => ({ validateScope: mockValidateScope }));
jest.unstable_mockModule("../../src/workers/issueFix/analyze.js", () => ({ analyzeIssue: mockAnalyzeIssue }));
jest.unstable_mockModule("../../src/workers/issueFix/generate.js", () => ({ generateFixes: mockGenerateFixes }));
jest.unstable_mockModule("../../src/workers/issueFix/validate.js", () => ({ validateFixes: mockValidateFixes }));
jest.unstable_mockModule("../../src/workers/issueFix/submit.js", () => ({ submitFix: mockSubmitFix }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { processFixIssue } = await import("../../src/workers/issueFix/pipeline.js");

function makeJobData(overrides = {}) {
  return { repository: { github_id: "999", full_name: "org/repo" }, issueNumber: 42, principalId: "p1", ...overrides };
}
function makeCtx(overrides = {}) {
  return {
    repo: "org/repo", repoId: "999", issueNumber: 42, branchName: "gitwire/fix-42",
    octokit: {}, repoConfig: {}, ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInitFixContext.mockResolvedValue(makeCtx());
  mockValidateScope.mockResolvedValue({ issue: {}, tree: [], baseSha: "abc1234", defaultBranch: "main" });
  mockAnalyzeIssue.mockResolvedValue({ complexity: "trivial", files: ["main.py"] });
  mockGenerateFixes.mockResolvedValue({ fixes: [], fileContents: [] });
  mockValidateFixes.mockResolvedValue({ fixes: [], fileContents: [], preConfidence: "high", fixAction: { id: "a1" } });
  mockSubmitFix.mockResolvedValue(undefined);
  mockCheckAndMark.mockResolvedValue(true);
});

describe("Issue-fix idempotency guard", () => {
  it("does not mark pre-submission failures", async () => {
    for (const [mock, value] of [
      [mockInitFixContext, null],
      [mockValidateScope, null],
      [mockAnalyzeIssue, null],
      [mockGenerateFixes, null],
      [mockValidateFixes, null],
    ]) {
      jest.clearAllMocks();
      mockInitFixContext.mockResolvedValue(makeCtx());
      mockValidateScope.mockResolvedValue({});
      mockAnalyzeIssue.mockResolvedValue({ complexity: "trivial" });
      mockGenerateFixes.mockResolvedValue({ fixes: [] });
      mockValidateFixes.mockResolvedValue({ fixes: [] });
      mock.mockResolvedValueOnce(value);
      await processFixIssue(makeJobData());
      expect(mockCheckAndMark).not.toHaveBeenCalled();
      expect(mockSubmitFix).not.toHaveBeenCalled();
    }
  });

  it("scopes the submission marker by stable repository id and issue number", async () => {
    await processFixIssue(makeJobData());
    expect(mockCheckAndMark).toHaveBeenCalledWith("issue_fix", "repo-999:issue-42");
    expect(mockSubmitFix).toHaveBeenCalledTimes(1);
  });

  it("does not collide for equal issue numbers in different repositories", async () => {
    mockInitFixContext.mockResolvedValueOnce(makeCtx({ repo: "org/a", repoId: "100" }));
    await processFixIssue(makeJobData());
    mockInitFixContext.mockResolvedValueOnce(makeCtx({ repo: "org/b", repoId: "200" }));
    await processFixIssue(makeJobData());

    expect(mockCheckAndMark.mock.calls.map((c) => c[1])).toEqual([
      "repo-100:issue-42",
      "repo-200:issue-42",
    ]);
  });

  it("blocks duplicate submission when the scoped marker already exists", async () => {
    mockCheckAndMark.mockResolvedValue(false);
    await processFixIssue(makeJobData());
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });
});
