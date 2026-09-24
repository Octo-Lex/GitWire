// tests/unit/custom-rules-p2-regressions.test.js
// D0-03 follow-up coverage for exact-head evidence coherence and decision precedence.

import { jest } from "@jest/globals";

const mockEvaluateRules = jest.fn();
const mockGetConfigForRepo = jest.fn();
const mockGetPluginsForRepo = jest.fn(async () => []);
const mockGetInstallationClient = jest.fn(async () => ({}));
const mockWrapOctokit = jest.fn();
const mockLogDecision = jest.fn(async () => ({}));
const mockPropose = jest.fn();
const mockApprove = jest.fn(async () => ({}));
const mockExecute = jest.fn(async () => ({}));
const mockSucceed = jest.fn(async () => ({}));
const mockFail = jest.fn(async () => ({}));
const mockBlock = jest.fn(async () => ({}));
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("@gitwire/rules", () => ({
  evaluateRules: mockEvaluateRules,
}));

jest.unstable_mockModule("@gitwire/rules/plugins", () => ({
  loadPlugins: jest.fn(() => ({})),
}));

jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
  getPluginsForRepo: mockGetPluginsForRepo,
}));

jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: mockGetInstallationClient,
}));

jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: mockWrapOctokit,
}));

jest.unstable_mockModule("../../src/services/decisionLogService.js", () => ({
  logDecision: mockLogDecision,
}));

jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: mockPropose,
  approve: mockApprove,
  execute: mockExecute,
  succeed: mockSucceed,
  fail: mockFail,
  block: mockBlock,
  BLOCKED_REASONS: {
    POLICY_DENIED: "policy_denied",
    EVIDENCE_INCOMPLETE: "evidence_incomplete",
    TARGET_DRIFTED: "target_drifted",
  },
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: mockLogger,
}));

const { evaluateAndExecuteCustomRules } = await import("../../src/services/customRulesService.js");

const mutationRequest = jest.fn();
const freshRequest = jest.fn();
const mutationOctokit = { request: mutationRequest };
const freshOctokit = { request: freshRequest };

function repo() {
  return {
    id: 99,
    full_name: "acme/widgets",
    name: "widgets",
    owner: { login: "acme" },
  };
}

function prPayload(headSha = "head-1") {
  return {
    action: "synchronize",
    repository: repo(),
    installation: { id: 7 },
    pull_request: {
      number: 23,
      title: "PR",
      body: "Body",
      user: { login: "alice" },
      labels: [],
      head: { sha: headSha, ref: "feature" },
      additions: 1,
      deletions: 0,
      changed_files: 1,
      draft: false,
    },
  };
}

function issuePayload() {
  return {
    action: "opened",
    repository: repo(),
    installation: { id: 7 },
    issue: {
      number: 11,
      title: "Issue",
      body: "Body",
      user: { login: "alice" },
      labels: [],
    },
  };
}

function freshPr(headSha = "head-1", changedFiles = 1) {
  return {
    number: 23,
    title: "PR fresh",
    body: "Fresh body",
    user: { login: "alice" },
    labels: [],
    head: { sha: headSha, ref: "feature" },
    additions: 1,
    deletions: 0,
    changed_files: changedFiles,
    draft: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPropose.mockResolvedValue({ id: 1 });
  mockGetConfigForRepo.mockResolvedValue({
    settings: { dry_run: false },
    custom_rules: { "rule-one": { when: "true", actions: [] } },
  });
  mockGetPluginsForRepo.mockResolvedValue([]);
  mockGetInstallationClient.mockResolvedValue({});
  mockWrapOctokit.mockImplementation((_client, opts) => opts?.skipCache ? freshOctokit : mutationOctokit);
  mutationRequest.mockResolvedValue({ data: {} });
  freshRequest.mockReset();
  mockEvaluateRules.mockReset();
  mockLogDecision.mockResolvedValue({});
  mockApprove.mockResolvedValue({});
  mockExecute.mockResolvedValue({});
  mockSucceed.mockResolvedValue({});
  mockFail.mockResolvedValue({});
  mockBlock.mockResolvedValue({});
});

describe("D0-03 P2 regressions", () => {
  it("fails closed when the PR head changes during changed-file pagination", async () => {
    let metadataReads = 0;
    freshRequest.mockImplementation(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        metadataReads += 1;
        return { data: freshPr(metadataReads === 1 ? "head-1" : "head-2", 1) };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: [{ filename: "src/a.js" }] };
      }
      throw new Error("unexpected route");
    });
    mockEvaluateRules.mockReturnValue([
      { name: "rule-one", actions: [{ action: "add-label", args: { label: "bug" } }] },
    ]);

    const result = await evaluateAndExecuteCustomRules(
      "pull_request",
      prPayload("head-1"),
      { id: 7 },
      "principal-1"
    );

    expect(result).toEqual([]);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "blocked",
      commitSha: "head-1",
    }));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "PR changed during evidence collection" }),
      expect.stringContaining("failing closed")
    );
  });

  it("blocks a PR mutation when the head drifts after evaluation", async () => {
    let metadataReads = 0;
    freshRequest.mockImplementation(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        metadataReads += 1;
        return { data: freshPr(metadataReads < 3 ? "head-1" : "head-2", 1) };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: [{ filename: "src/a.js" }] };
      }
      throw new Error("unexpected route");
    });
    mockEvaluateRules.mockReturnValue([
      { name: "rule-one", actions: [{ action: "add-label", args: { label: "bug" } }] },
    ]);

    const result = await evaluateAndExecuteCustomRules(
      "pull_request",
      prPayload("head-1"),
      { id: 7 },
      "principal-1"
    );

    expect(result[0].results[0]).toEqual(expect.objectContaining({
      success: false,
      outcome: "blocked",
    }));
    expect(mockBlock).toHaveBeenCalledWith(
      1,
      "target_drifted",
      {
        expected_head_sha: "head-1",
        current_head_sha: "head-2",
      }
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "blocked",
      commitSha: "head-1",
    }));
  });

  it("keeps invalid actions blocked in the rule decision while dry-run is enabled", async () => {
    mockGetConfigForRepo.mockResolvedValue({
      settings: { dry_run: true },
      custom_rules: { "rule-one": { when: "true", actions: [] } },
    });
    mockEvaluateRules.mockReturnValue([
      { name: "rule-one", actions: [{ action: "unknown-action", args: {} }] },
    ]);

    const result = await evaluateAndExecuteCustomRules(
      "issues",
      issuePayload(),
      { id: 7 },
      "principal-1"
    );

    expect(result[0].results[0]).toEqual(expect.objectContaining({
      success: false,
      outcome: "blocked",
    }));
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "blocked",
      reason: expect.stringContaining("actions were blocked"),
    }));
    expect(mockLogDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      decision: "dry_run",
    }));
  });
});
