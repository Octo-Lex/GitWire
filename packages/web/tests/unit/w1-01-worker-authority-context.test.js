// W1-01: worker adoption must carry the server-owned principal/resource pair
// forward without copying repository identity from the queue payload.

import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockResolveSystemWorkerContext = jest.fn();
const mockResolveInstallationWorkerContext = jest.fn();
const mockResolveRepositoryResource = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
}));
jest.unstable_mockModule("../../src/services/auth/workerContext.js", () => ({
  resolveSystemWorkerContext: mockResolveSystemWorkerContext,
  resolveInstallationWorkerContext: mockResolveInstallationWorkerContext,
}));
jest.unstable_mockModule("../../src/services/auth/resourceResolver.js", () => ({
  resolveRepositoryResource: mockResolveRepositoryResource,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

const { adoptWorker } = await import("../../src/services/auth/workerAdoption.js");

describe("W1-01 worker authority context", () => {
  const principal = Object.freeze({
    principalId: "installation-principal-7",
    principalType: "installation",
    authenticationMethod: "webhook_hmac",
    installationId: 7,
  });

  beforeEach(() => {
    mockAuthorize.mockReset();
    mockResolveSystemWorkerContext.mockReset();
    mockResolveInstallationWorkerContext.mockReset();
    mockResolveRepositoryResource.mockReset();
    mockLoggerWarn.mockReset();

    mockResolveInstallationWorkerContext.mockResolvedValue(principal);
    mockAuthorize.mockResolvedValue(Object.freeze({ allowed: true, code: "allowed" }));
  });

  test("carries DB-derived repository identity instead of payload names", async () => {
    const trustedResource = {
      type: "repository",
      installationId: 7,
      repositoryId: 11,
      organization: "trusted-owner",
      repository: "trusted-repo",
    };
    mockResolveRepositoryResource.mockResolvedValue(trustedResource);

    const result = await adoptWorker({
      workerId: "worker:phase2",
      permission: "merge_queue_entry:update",
      resourceType: "repository",
      jobData: {
        payload: {
          installation: { id: 7 },
          repository: {
            id: 11,
            owner: { login: "payload-owner" },
            name: "payload-repo",
          },
        },
      },
    });

    expect(mockResolveRepositoryResource).toHaveBeenCalledWith(7, 11);
    expect(mockAuthorize).toHaveBeenCalledWith({
      principal,
      permission: "merge_queue_entry:update",
      resource: trustedResource,
    });
    expect(result.authority).toEqual({
      principal,
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
        resourceId: null,
      },
      surfaceId: "worker:phase2",
    });
    expect(result.resource).toBe(result.authority.resource);
    expect(Object.isFrozen(result.authority)).toBe(true);
    expect(Object.isFrozen(result.resource)).toBe(true);
    expect(result.resource.organization).not.toBe("payload-owner");
    expect(result.resource.repository).not.toBe("payload-repo");
  });

  test("failed trusted binding never promotes payload repository identity", async () => {
    mockResolveRepositoryResource.mockResolvedValue(null);

    const result = await adoptWorker({
      workerId: "worker:phase2",
      permission: "merge_queue_entry:update",
      resourceType: "repository",
      jobData: {
        payload: {
          installation: { id: 7 },
          repository: {
            id: 999,
            owner: { login: "payload-owner" },
            name: "payload-repo",
          },
        },
      },
    });

    expect(mockAuthorize).toHaveBeenCalledWith({
      principal,
      permission: "merge_queue_entry:update",
      resource: { type: "repository" },
    });
    expect(result.authority.resource).toEqual({
      type: "repository",
      installationId: null,
      repositoryId: null,
      organization: null,
      repository: null,
      resourceId: null,
    });
    expect(result.authority.resource).not.toHaveProperty("owner");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "worker:phase2",
        installationId: 7,
        repositoryId: 999,
      }),
      "adoptWorker: trusted repository lookup failed — resource will fail-closed",
    );
  });
});
