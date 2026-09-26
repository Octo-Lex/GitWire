// W1-04 exact-head review regressions.
//
// Pins the final scope-hygiene and fail-closed findings discovered during
// review of PR #301 without broadening the W1-04 runtime set.

import { jest } from "@jest/globals";

const mockAuthorize = jest.fn();
const mockAuthorizeControlled = jest.fn();
const mockResolveSystemWorkerContext = jest.fn();
const mockResolveInstallationWorkerContext = jest.fn();
const mockResolveRepositoryResource = jest.fn();
const mockResolveRepositoryResourceByFullName = jest.fn();
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
  resolveRepositoryResourceByFullName: mockResolveRepositoryResourceByFullName,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { adoptWorker } = await import("../../src/services/auth/workerAdoption.js");

const installationPrincipal = Object.freeze({
  principalId: "installation-principal-7",
  principalType: "installation",
  authenticationMethod: "webhook_hmac",
  installationId: 7,
});
const systemPrincipal = Object.freeze({
  principalId: "system-principal",
  principalType: "system",
  authenticationMethod: "service",
  installationId: null,
});

function deniedOutcome(resource, code = "resource_unknown") {
  return {
    decision: Object.freeze({ allowed: false, code, resource }),
    persisted: true,
    mode: "enforced",
    blocked: true,
  };
}

describe("W1-04 exact-head review regressions", () => {
  beforeEach(() => {
    mockAuthorize.mockReset();
    mockAuthorizeControlled.mockReset();
    mockResolveSystemWorkerContext.mockReset();
    mockResolveInstallationWorkerContext.mockReset();
    mockResolveRepositoryResource.mockReset();
    mockResolveRepositoryResourceByFullName.mockReset();
    mockLoggerWarn.mockReset();

    mockResolveInstallationWorkerContext.mockResolvedValue(installationPrincipal);
    mockResolveSystemWorkerContext.mockResolvedValue(systemPrincipal);
    mockAuthorize.mockResolvedValue(Object.freeze({ allowed: false, code: "permission_missing" }));
    mockAuthorizeControlled.mockImplementation(async ({ resource }) => deniedOutcome(resource));
  });

  test("maintainer-only repoFullName binding cannot alter observe-only repository workers", async () => {
    await adoptWorker({
      workerId: "worker:diagnosis",
      permission: "repair_proposal:read",
      resourceType: "repository",
      installationId: 7,
      jobData: { repoFullName: "owner/repo" },
    });

    expect(mockResolveRepositoryResourceByFullName).not.toHaveBeenCalled();
    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: installationPrincipal,
      permission: "repair_proposal:read",
      resource: { type: "repository", installationId: 7 },
    });
    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
  });

  test("maintainer full-name lookup miss reaches enforced authorization only as an incomplete repository", async () => {
    mockResolveRepositoryResourceByFullName.mockResolvedValue(null);

    await expect(adoptWorker({
      workerId: "worker:maintainer",
      permission: "repository:github:act",
      resourceType: "repository",
      installationId: 7,
      jobData: { installationId: 7, repoFullName: "owner/renamed-repo" },
    })).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      reason: "authorization_denied",
      workerId: "worker:maintainer",
      decisionCode: "resource_unknown",
    });

    expect(mockResolveRepositoryResourceByFullName).toHaveBeenCalledWith(7, "owner/renamed-repo");
    expect(mockAuthorizeControlled).toHaveBeenCalledWith(expect.objectContaining({
      permission: "repository:github:act",
      mode: "enforced",
      resource: {
        type: "repository",
        installationId: null,
        repositoryId: null,
        organization: null,
        repository: null,
        resourceId: null,
      },
    }));
  });

  test("Phase-3 installation jobs with installation id but no repository id fail closed", async () => {
    await expect(adoptWorker({
      workerId: "worker:phase3",
      permission: "installation:read",
      resourceType: "installation",
      jobName: "dependency-scan-repo",
      systemPrincipalName: "system:phase3-worker",
      installationId: 7,
      jobData: { installationId: 7 },
    })).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      reason: "authorization_denied",
      workerId: "worker:phase3",
      decisionCode: "resource_unknown",
    });

    expect(mockResolveRepositoryResource).not.toHaveBeenCalled();
    expect(mockAuthorizeControlled).toHaveBeenCalledWith(expect.objectContaining({
      principal: systemPrincipal,
      permission: "installation:read",
      mode: "enforced",
      resource: {
        type: "installation",
        installationId: null,
        repositoryId: null,
        organization: null,
        repository: null,
        resourceId: null,
      },
    }));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "worker:phase3",
        installationId: 7,
        repositoryId: null,
        jobName: "dependency-scan-repo",
      }),
      "adoptWorker: Phase-3 installation job missing repository/installation binding — resource will fail-closed",
    );
  });
});
