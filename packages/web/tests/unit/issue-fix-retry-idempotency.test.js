// Legacy filename retained for continuity. The submission idempotency guard now
// lives inside submitFix(), after authority/head freshness fences. This suite
// proves that pre-submission failures remain retryable and the pipeline reaches
// submitFix only after all analysis/validation stages pass.

import { jest } from "@jest/globals";

const mockInitFixContext = jest.fn();
const mockValidateScope = jest.fn();
const mockAnalyzeIssue = jest.fn();
const mockGenerateFixes = jest.fn();
const mockValidateFixes = jest.fn();
const mockSubmitFix = jest.fn();

jest.unstable_mockModule("../../src/workers/issueFix/context.js", () => ({ initFixContext: mockInitFixContext }));
jest.unstable_mockModule("../../src/workers/issueFix/scopeGuard.js", () => ({ validateScope: mockValidateScope }));
jest.unstable_mockModule("../../src/workers/issueFix/analyze.js", () => ({ analyzeIssue: mockAnalyzeIssue }));
jest.unstable_mockModule("../../src/workers/issueFix/generate.js", () => ({ generateFixes: mockGenerateFixes }));
jest.unstable_mockModule("../../src/workers/issueFix/validate.js", () => ({ validateFixes: mockValidateFixes }));
jest.unstable_mockModule("../../src/workers/issueFix/submit.js", () => ({ submitFix: mockSubmitFix }));

const { processFixIssue } = await import("../../src/workers/issueFix/pipeline.js");

function makeCtx() {
  return { repo: "org/repo", repoId: "999", issueNumber: 42, branchName: "gitwire/fix-42" };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInitFixContext.mockResolvedValue(makeCtx());
  mockValidateScope.mockResolvedValue({ issue: {}, tree: [], baseSha: "abc1234", defaultBranch: "main" });
  mockAnalyzeIssue.mockResolvedValue({ complexity: "trivial" });
  mockGenerateFixes.mockResolvedValue({ fixes: [], fileContents: [] });
  mockValidateFixes.mockResolvedValue({ fixes: [], fileContents: [], fixAction: { id: "a1" } });
  mockSubmitFix.mockResolvedValue(undefined);
});

describe("Issue-fix retry boundary", () => {
  it.each([
    ["context", mockInitFixContext],
    ["scope", mockValidateScope],
    ["analysis", mockAnalyzeIssue],
    ["generation", mockGenerateFixes],
    ["validation", mockValidateFixes],
  ])("does not submit after a %s-stage stop", async (_name, stage) => {
    stage.mockResolvedValueOnce(null);
    await processFixIssue({});
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("calls submit only after every pre-effect stage succeeds", async () => {
    await processFixIssue({});
    expect(mockSubmitFix).toHaveBeenCalledTimes(1);
    expect(mockSubmitFix).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: "999", issueNumber: 42 }),
      expect.objectContaining({ complexity: "trivial" }),
      expect.objectContaining({ fixAction: { id: "a1" } }),
    );
  });
});
