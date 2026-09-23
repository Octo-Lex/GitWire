// D0-02 — issue-fix GitHub reads must bypass shared GET caching.

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

describe("issue-fix GitHub cache boundary", () => {
  it("constructs the entire issue-fix client with skipCache=true", async () => {
    await initFixContext({
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

    expect(mockGetInstallationClient).toHaveBeenCalledWith("77");
    expect(mockWrapOctokit).toHaveBeenCalledWith(expect.any(Object), { skipCache: true });
  });
});
