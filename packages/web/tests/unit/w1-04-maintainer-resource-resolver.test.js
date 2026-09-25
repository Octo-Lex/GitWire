// W1-04 — maintainer repository binding by full_name remains server-owned.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockWarn = jest.fn();
const mockError = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: mockWarn,
    error: mockError,
    debug: jest.fn(),
  },
}));

const { resolveRepositoryResourceByFullName } =
  await import("../../src/services/auth/resourceResolver.js");

describe("W1-04 maintainer repository resolver", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockWarn.mockReset();
    mockError.mockReset();
  });

  test("uses full_name only as lookup input and returns DB-owned identity", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        github_id: "22",
        installation_id: "7",
        full_name: "current-owner/current-repo",
        owner: "current-owner",
        name: "current-repo",
      }],
    });

    const resource = await resolveRepositoryResourceByFullName(
      7,
      "queued-owner/queued-repo",
    );

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE r.full_name = $1"),
      ["queued-owner/queued-repo", 7],
    );
    expect(resource).toEqual({
      type: "repository",
      installationId: 7,
      repositoryId: 22,
      organization: "current-owner",
      repository: "current-repo",
    });
  });

  test("ambiguous full-name binding fails closed", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { github_id: "22", installation_id: "7", owner: "a", name: "repo" },
        { github_id: "23", installation_id: "7", owner: "a", name: "repo" },
      ],
    });

    await expect(resolveRepositoryResourceByFullName(7, "a/repo")).resolves.toBeNull();
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 7, fullName: "a/repo", count: 2 }),
      "resourceResolver: ambiguous repository full-name mapping",
    );
  });

  test("installation mismatch fails closed", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ github_id: "22", installation_id: "8", owner: "a", name: "repo" }],
    });

    await expect(resolveRepositoryResourceByFullName(7, "a/repo")).resolves.toBeNull();
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 7, actualInstallation: "8" }),
      "resourceResolver: full-name repository belongs to different installation",
    );
  });

  test("invalid lookup input does not query the database", async () => {
    await expect(resolveRepositoryResourceByFullName(null, "a/repo")).resolves.toBeNull();
    await expect(resolveRepositoryResourceByFullName(7, "")).resolves.toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
