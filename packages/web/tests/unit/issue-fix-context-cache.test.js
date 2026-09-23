// D0-02 — issue-fix GitHub reads must bypass shared GET caching and use the
// runtime's numeric installation-id contract only after safe-range validation.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetConfigForRepo = jest.fn();
const mockGetInstallationClient = jest.fn();
const mockWrapOctokit = jest.fn();

jest.unstable_mockModule("../../src/services/configService.js", () => ({ getConfigForRepo: mockGetConfigForRepo }));
jest.unstable_mockModule("@gitwire/rules", () => ({ isPillarEnabled: jest.fn(() => true) }));
jest.unstable_mockModule("../../src/lib/github.js", () => ({ getInstallationClient: mockGetInstallationClient }));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({ wrapOctokit: mockWrapOctokit }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { initFixContext } = await import("../../src/workers/issueFix/context.js");

beforeEach(() => {
  jest.clearAllMocks();
  mockGetConfigForRepo.mockResolvedValue({ pillars: { issue_fix: { enabled: true } } });
  mockGetInstallationClient.mockResolvedValue({ request: jest.fn() });
  mockWrapOctokit.mockReturnValue({ request: jest.fn() });
});

describe("issue-fix GitHub runtime boundary", () => {
  it("uses a safe numeric installation id and skipCache=true", async () => {
    const ctx = await initFixContext({
      repository: {
        github_id: "99",
        installation_id: "77",
        full_name: "octo/repo",
        owner: "octo",
        name: "repo",
        default_branch: "main",
      },
      issueNumber: 42,
      triggeredBy: "api",
    });

    expect(mockGetInstallationClient).toHaveBeenCalledWith(77);
    expect(mockWrapOctokit).toHaveBeenCalledWith(expect.any(Object), { skipCache: true });
    expect(ctx.installationId).toBe(77);
  });

  it("fails before configuration or GitHub access when installation id is unsafe", async () => {
    await expect(initFixContext({
      repository: {
        github_id: "99",
        installation_id: "9007199254740992",
        full_name: "octo/repo",
        owner: "octo",
        name: "repo",
      },
      issueNumber: 42,
      triggeredBy: "api",
    })).rejects.toThrow("cannot be represented safely");

    expect(mockGetConfigForRepo).not.toHaveBeenCalled();
    expect(mockGetInstallationClient).not.toHaveBeenCalled();
  });
});
