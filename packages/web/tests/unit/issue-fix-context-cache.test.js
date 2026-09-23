// D0-02 — issue-fix GitHub reads must bypass shared GET caching and use the
// runtime's numeric installation-id contract only after safe-range validation.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetConfigForRepo = jest.fn();
const mockGetInstallationClient = jest.fn();
const mockWrapOctokit = jest.fn();
const mockIsDryRun = jest.fn();

jest.unstable_mockModule("../../src/services/configService.js", () => ({ getConfigForRepo: mockGetConfigForRepo }));
jest.unstable_mockModule("@gitwire/rules", () => ({
  isPillarEnabled: jest.fn(() => true),
  isDryRun: mockIsDryRun,
}));
jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: mockGetInstallationClient }));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: mockWrapOctokit }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { initFixContext } = await import("../../src/workers/issueFix/context.js");

const repository = {
  github_id: "99",
  installation_id: "77",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
  default_branch: "main",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfigForRepo.mockResolvedValue({ pillars: { issue_fix: { enabled: true } }, settings: { dry_run: false } });
  mockGetInstallationClient.mockResolvedValue({ request: jest.fn() });
  mockWrapOctokit.mockReturnValue({ request: jest.fn() });
  mockIsDryRun.mockReturnValue(false);
});

describe("issue-fix GitHub runtime boundary", () => {
  it("uses a safe numeric installation id and skipCache=true", async () => {
    const ctx = await initFixContext({
      repository,
      issueNumber: 42,
      triggeredBy: "api",
    });

    expect(mockGetInstallationClient).toHaveBeenCalledWith(77);
    expect(mockWrapOctokit).toHaveBeenCalledWith(expect.any(Object), { skipCache: true });
    expect(ctx.installationId).toBe(77);
    expect(ctx.dryRun).toBe(false);
  });

  it("fails before configuration or GitHub access when installation id is unsafe", async () => {
    await expect(initFixContext({
      repository: {
        ...repository,
        installation_id: "9007199254740992",
      },
      issueNumber: 42,
      triggeredBy: "api",
    })).rejects.toThrow("cannot be represented safely");

    expect(mockGetConfigForRepo).not.toHaveBeenCalled();
    expect(mockGetInstallationClient).not.toHaveBeenCalled();
  });

  it("mechanically blocks every non-read GitHub request in dry-run while allowing evidence reads", async () => {
    const rawRequest = jest.fn().mockResolvedValue({ data: { ok: true } });
    mockWrapOctokit.mockReturnValue({ request: rawRequest });
    mockIsDryRun.mockReturnValue(true);

    const ctx = await initFixContext({
      repository,
      issueNumber: 42,
      triggeredBy: "api",
    });

    await expect(ctx.octokit.request("GET /repos/{owner}/{repo}", { owner: "octo", repo: "repo" }))
      .resolves.toEqual({ data: { ok: true } });
    await expect(ctx.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: "octo", repo: "repo", issue_number: 42, body: "would mutate",
    })).resolves.toEqual({ data: { dry_run: true } });
    await expect(ctx.octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {}))
      .resolves.toEqual({ data: { dry_run: true } });

    expect(ctx.dryRun).toBe(true);
    expect(rawRequest).toHaveBeenCalledTimes(1);
    expect(rawRequest).toHaveBeenCalledWith("GET /repos/{owner}/{repo}", { owner: "octo", repo: "repo" });
  });
});
