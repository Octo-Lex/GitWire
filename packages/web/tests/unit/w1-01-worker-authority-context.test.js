// W1-01: worker adoption must carry the server-owned principal/resource pair
// forward without copying repository identity from the queue payload.
// W1-04: the same canonical authority is now consumed by enforced worker gates.

import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockAuthorizeControlled = jest.fn();
const mockResolveSystemWorkerContext = jest.fn();
const mockResolveInstallationWorkerContext = jest.fn();
const mockResolveRepositoryResource = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
  authorizeControlled: mockAuthorizeControlled,
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
    mockAuthorizeControlled.mockReset();
    mockResolveSystemWorkerContext.mockReset();
    mockResolveInstallationWorkerContext.mockReset();
    mockResolveRepositoryResource.mockReset();
    mockLoggerWarn.mockReset();

    mockResolveInstallationWorkerContext.mockResolvedValue(principal);
    mockAuthorize.mockResolvedValue(Object.freeze({ allowed: true, code: "allowed" }));
    mockAuthorizeControlled.mockImplementation(async ({ principal: p, permission, resource, mode }) => ({
      decision: Object.freeze({
        allowed: true,
        code: "allowed",
        principalId: p?.principalId ?? null,
        permission,
        resource,
      }),
      persisted: true,
      mode,
      blocked: false,
    }));
  });

  test("carries DB-derived repository identity into the enforced Phase-2 gate", async () => {
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

    const canonicalResource = {
      type: "repository",
      installationId: 7,
      repositoryId: 11,
      organization: "trusted-owner",
      repository: "trusted-repo",
      resourceId: null,
    };

    expect(mockResolveRepositoryResource).toHaveBeenCalledWith(7, 11);
    expect(mockAuthorizeControlled).toHaveBeenCalledWith({
      principal,
      permission: "merge_queue_entry:update",
      resource: canonicalResource,
      mode: "enforced",
    });
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(result.authority).toEqual({
      principal,
      resource: canonicalResource,
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

    expect(mockAuthorizeControlled).toHaveBeenCalledWith({
      principal,
      permission: "merge_queue_entry:update",
      resource: {
        type: "repository",
        installationId: null,
        repositoryId: null,
        organization: null,
        repository: null,
        resourceId: null,
      },
      mode: "enforced",
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
