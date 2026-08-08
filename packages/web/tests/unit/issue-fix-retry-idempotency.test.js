// tests/unit/issue-fix-retry-idempotency.test.js
// Regression test for the P1: /gitwire fix premature-idempotency-mark defect.
//
// Before this fix, checkAndMark("issue_fix", ...) ran at pipeline entry
// (context.js), before pillar/scope/analysis/generation/validation stages.
// Any pre-submission failure left the marker set, blocking retries.
//
// After this fix, checkAndMark runs in pipeline.js immediately before
// submitFix(), so only the submission path is guarded.
//
// Proves:
//   - Pre-submission failures do NOT write the idempotency marker
//   - A pre-submission failure leaves the issue retryable
//   - checkAndMark runs immediately before submitFix
//   - A duplicate submission is still blocked when the marker is set

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────
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

jest.unstable_mockModule("../../src/workers/issueFix/context.js", () => ({
  initFixContext: mockInitFixContext,
}));
jest.unstable_mockModule("../../src/workers/issueFix/scopeGuard.js", () => ({
  validateScope: mockValidateScope,
}));
jest.unstable_mockModule("../../src/workers/issueFix/analyze.js", () => ({
  analyzeIssue: mockAnalyzeIssue,
}));
jest.unstable_mockModule("../../src/workers/issueFix/generate.js", () => ({
  generateFixes: mockGenerateFixes,
}));
jest.unstable_mockModule("../../src/workers/issueFix/validate.js", () => ({
  validateFixes: mockValidateFixes,
}));
jest.unstable_mockModule("../../src/workers/issueFix/submit.js", () => ({
  submitFix: mockSubmitFix,
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { processFixIssue } = await import("../../src/workers/issueFix/pipeline.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeJobData(overrides = {}) {
  return {
    repo: "org/repo",
    issueNumber: 42,
    installationId: 11111,
    triggeredBy: "maintainer",
    principalId: "p1",
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    repo: "org/repo",
    owner: "org",
    repoName: "repo",
    repoId: 999,
    issueNumber: 42,
    installationId: 11111,
    triggeredBy: "maintainer",
    branchName: "gitwire/fix-42",
    octokit: {},
    repoConfig: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: all stages pass, submitFix succeeds
  mockInitFixContext.mockResolvedValue(makeCtx());
  mockValidateScope.mockResolvedValue({ issue: {}, tree: {} });
  mockAnalyzeIssue.mockResolvedValue({ complexity: "trivial", files: ["main.py"] });
  mockGenerateFixes.mockResolvedValue({ fixes: [], fileContents: [] });
  mockValidateFixes.mockResolvedValue({ fixes: [], fileContents: [], preConfidence: "high", fixAction: { id: "a1" } });
  mockSubmitFix.mockResolvedValue(undefined);
  mockCheckAndMark.mockResolvedValue(true);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Issue-fix idempotency guard placement", () => {
  it("does NOT call checkAndMark when pillar is disabled (pre-submission failure)", async () => {
    mockInitFixContext.mockResolvedValue(null); // simulates disabled pillar

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("does NOT call checkAndMark when scope validation fails", async () => {
    mockValidateScope.mockResolvedValue(null);

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("does NOT call checkAndMark when analysis fails", async () => {
    mockAnalyzeIssue.mockResolvedValue(null);

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("does NOT call checkAndMark when generation fails", async () => {
    mockGenerateFixes.mockResolvedValue(null);

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("does NOT call checkAndMark when validation fails", async () => {
    mockValidateFixes.mockResolvedValue(null);

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).not.toHaveBeenCalled();
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("calls checkAndMark immediately before submitFix when all stages pass", async () => {
    await processFixIssue(makeJobData());

    // checkAndMark must be called with the issue number
    expect(mockCheckAndMark).toHaveBeenCalledTimes(1);
    expect(mockCheckAndMark).toHaveBeenCalledWith("issue_fix", "issue-42");

    // submitFix must also be called (fresh key → proceed)
    expect(mockSubmitFix).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate submission when checkAndMark returns false", async () => {
    mockCheckAndMark.mockResolvedValue(false); // already submitted

    await processFixIssue(makeJobData());

    expect(mockCheckAndMark).toHaveBeenCalledTimes(1);
    // submitFix must NOT be called (duplicate blocked)
    expect(mockSubmitFix).not.toHaveBeenCalled();
  });

  it("checkAndMark runs AFTER all pre-submission stages, not before", async () => {
    const callOrder = [];
    mockInitFixContext.mockImplementation(async () => { callOrder.push("initFixContext"); return makeCtx(); });
    mockValidateScope.mockImplementation(async () => { callOrder.push("validateScope"); return {}; });
    mockAnalyzeIssue.mockImplementation(async () => { callOrder.push("analyzeIssue"); return { complexity: "trivial" }; });
    mockGenerateFixes.mockImplementation(async () => { callOrder.push("generateFixes"); return { fixes: [] }; });
    mockValidateFixes.mockImplementation(async () => { callOrder.push("validateFixes"); return { fixes: [] }; });
    mockCheckAndMark.mockImplementation(async () => { callOrder.push("checkAndMark"); return true; });
    mockSubmitFix.mockImplementation(async () => { callOrder.push("submitFix"); });

    await processFixIssue(makeJobData());

    // checkAndMark must come after validateFixes and before submitFix
    const markIndex = callOrder.indexOf("checkAndMark");
    const submitIndex = callOrder.indexOf("submitFix");
    const validateIndex = callOrder.indexOf("validateFixes");

    expect(markIndex).toBeGreaterThan(validateIndex);
    expect(markIndex).toBeLessThan(submitIndex);
  });
});
