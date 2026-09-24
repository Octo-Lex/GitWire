// tests/unit/custom-rules-integrity.test.js
// D0-03 defect-sensitive regression coverage for Custom Rules accounting,
// provenance, dry-run, skip semantics, and PR evidence/head fencing.

import { jest } from "@jest/globals";

const mockEvaluateRules = jest.fn();
const mockLoadPlugins = jest.fn(() => ({}));
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

const BLOCKED_REASONS = {
  POLICY_DENIED: "policy_denied",
  EVIDENCE_INCOMPLETE: "evidence_incomplete",
  TARGET_DRIFTED: "target_drifted",
};

jest.unstable_mockModule("@gitwire/rules", () => ({
  evaluateRules: mockEvaluateRules,
}));

jest.unstable_mockModule("@gitwire/rules/plugins", () => ({
  loadPlugins: mockLoadPlugins,
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
  BLOCKED_REASONS,
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
      deletions: 2,
      changed_files: 1,
      draft: false,
    },
  };
}

function prCommentPayload() {
  return {
    action: "created",
    repository: repo(),
    installation: { id: 7 },
    issue: {
      number: 23,
      title: "PR",
      body: "Body",
      user: { login: "alice" },
      labels: [],
      pull_request: { url: "https://api.github.test/pulls/23" },
    },
    comment: {
      body: "please check",
      user: { login: "bob" },
    },
  };
}

function freshPr({ headSha = "head-1", changedFiles = 0 } = {}) {
  return {
    number: 23,
    title: "PR fresh",
    body: "Fresh body",
    user: { login: "alice" },
    labels: [],
    head: { sha: headSha, ref: "feature" },
    additions: 4,
    deletions: 3,
    changed_files: changedFiles,
    draft: false,
  };
}

function installFreshPr({ headSha = "head-1", changedFiles = 0, pages = [[]] } = {}) {
  freshRequest.mockImplementation(async (route, params) => {
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: freshPr({ headSha, changedFiles }) };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
      return { data: pages[(params.page || 1) - 1] || [] };
    }
    throw new Error("Unexpected fresh request: " + route);
  });
}

function match(actions, name = "rule-one") {
  mockEvaluateRules.mockReturnValue([{ name, actions }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  let nextId = 1;
  mockPropose.mockImplementation(async () => ({ id: nextId++ }));
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

describe("D0-03 Custom Rules integrity", () => {
  it("propagates the trusted principal and terminalizes set-priority", async () => {
    match([{ action: "set-priority", args: { priority: "high" } }]);

    const result = await evaluateAndExecuteCustomRules(
      "issues",
      issuePayload(),
      { id: 7 },
      "principal-1"
    );

    expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "issue",
      targetNumber: 11,
      evidence: expect.objectContaining({
        principalId: "principal-1",
        surfaceId: "custom_rules:evaluate",
      }),
    }));
    expect(mutationRequest).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      expect.objectContaining({ issue_number: 11, labels: ["priority:high"] })
    );
    expect(mockSucceed).toHaveBeenCalledWith(1, expect.objectContaining({ priority: "high" }));
    expect(result[0].results[0].outcome).toBe("succeeded");
  });

  it("blocks unknown actions before approval, execution, or mutation", async () => {
    match([{ action: "launch-missiles", args: {} }]);

    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 }, "principal-1");

    expect(mockBlock).toHaveBeenCalledWith(
      1,
      "policy_denied",
      expect.objectContaining({ deterministic: true, validation_error: expect.stringContaining("Unknown") })
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSucceed).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(result[0].results[0]).toEqual(expect.objectContaining({ success: false, outcome: "blocked" }));
  });

  it("blocks deterministic invalid arguments before execution", async () => {
    match([{ action: "add-label", args: {} }]);

    await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 }, "principal-1");

    expect(mockBlock).toHaveBeenCalledWith(
      1,
      "policy_denied",
      expect.objectContaining({ validation_error: "add-label requires 'label' arg" })
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
  });

  it("terminalizes skip and stops all remaining Custom Rules processing", async () => {
    mockEvaluateRules.mockReturnValue([
      {
        name: "stop-here",
        actions: [
          { action: "skip", args: {} },
          { action: "add-label", args: { label: "must-not-run" } },
        ],
      },
      {
        name: "later-rule",
        actions: [{ action: "add-label", args: { label: "also-must-not-run" } }],
      },
    ]);

    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 }, "principal-1");

    expect(mockPropose).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockSucceed).toHaveBeenCalledWith(1, { skipped: true });
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].results).toHaveLength(1);
    expect(result[0].results[0].outcome).toBe("skipped");
  });

  it("suppresses GitHub mutations in dry-run and records dry_run decision evidence", async () => {
    mockGetConfigForRepo.mockResolvedValue({
      settings: { dry_run: true },
      custom_rules: { "rule-one": { when: "true", actions: [] } },
    });
    match([{ action: "add-label", args: { label: "bug" } }]);

    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 }, "principal-1");

    expect(mockBlock).toHaveBeenCalledWith(
      1,
      "policy_denied",
      expect.objectContaining({ dry_run: true, mutation_suppressed: true })
    );
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(result[0].results[0].outcome).toBe("dry_run");
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: "dry_run",
      principalId: "principal-1",
    }));
  });

  it("paginates complete PR evidence and binds approve to the reviewed head", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.js` }));
    const page2 = [{ filename: "src/f100.js" }];
    installFreshPr({ headSha: "head-1", changedFiles: 101, pages: [page1, page2] });
    match([{ action: "approve", args: {} }]);

    await evaluateAndExecuteCustomRules("pull_request", prPayload("head-1"), { id: 7 }, "principal-1");

    expect(mockWrapOctokit).toHaveBeenCalledWith(expect.anything(), { skipCache: true });
    expect(freshRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      expect.objectContaining({ per_page: 100, page: 1 })
    );
    expect(freshRequest).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      expect.objectContaining({ per_page: 100, page: 2 })
    );
    expect(mockEvaluateRules.mock.calls[0][0].files).toHaveLength(101);
    expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "pr",
      targetNumber: 23,
      evidence: expect.objectContaining({
        target_snapshot: { head_sha: "head-1" },
        reviewed_head_sha: "head-1",
      }),
    }));
    expect(mutationRequest).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      expect.objectContaining({ pull_number: 23, commit_id: "head-1", event: "APPROVE" })
    );
  });

  it("rejects stale pull_request webhook heads before rule evaluation", async () => {
    installFreshPr({ headSha: "head-2", changedFiles: 0, pages: [[]] });
    match([{ action: "add-label", args: { label: "bug" } }]);

    const result = await evaluateAndExecuteCustomRules("pull_request", prPayload("head-1"), { id: 7 }, "principal-1");

    expect(result).toEqual([]);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "pr",
      targetNumber: 23,
      decision: "blocked",
      commitSha: "head-1",
    }));
  });

  it("fails closed when changed-file evidence count is incomplete", async () => {
    installFreshPr({
      headSha: "head-1",
      changedFiles: 2,
      pages: [[{ filename: "only-one.js" }]],
    });
    match([{ action: "approve", args: {} }]);

    const result = await evaluateAndExecuteCustomRules("pull_request", prPayload("head-1"), { id: 7 }, "principal-1");

    expect(result).toEqual([]);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
    expect(mutationRequest).not.toHaveBeenCalled();
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "blocked" }));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("Incomplete PR file evidence") }),
      expect.stringContaining("failing closed")
    );
  });

  it("represents PR issue_comment targets as PRs in action and decision evidence", async () => {
    installFreshPr({ headSha: "head-1", changedFiles: 0, pages: [[]] });
    match([{ action: "add-comment", args: { body: "hello" } }]);

    await evaluateAndExecuteCustomRules("issue_comment", prCommentPayload(), { id: 7 }, "principal-1");

    expect(mockPropose).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "pr",
      targetNumber: 23,
    }));
    expect(mockLogDecision).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "pr",
      targetNumber: 23,
    }));
  });

  it("logs action-state recording failures instead of swallowing them", async () => {
    match([{ action: "add-label", args: { label: "bug" } }]);
    mutationRequest.mockRejectedValueOnce(new Error("github failed"));
    mockFail.mockRejectedValueOnce(new Error("state store unavailable"));

    const result = await evaluateAndExecuteCustomRules("issues", issuePayload(), { id: 7 }, "principal-1");

    expect(mockFail).toHaveBeenCalledWith(1, "github failed");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "state store unavailable",
        originalError: "github failed",
        actionId: 1,
      }),
      "Failed to record Custom Rules action failure"
    );
    expect(result[0].results[0]).toEqual(expect.objectContaining({
      success: false,
      outcome: "failed",
      error: "github failed",
    }));
  });
});
