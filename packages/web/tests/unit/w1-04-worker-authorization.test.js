// W1-04 — exact worker/scheduler authorization cutover.
//
// These tests prove the bounded enforced set, durable-decision fail-closed
// behavior, maintainer repository rebinding, Phase-3 fleet handling, and that
// non-W1-04 runtime surfaces remain observe-only.

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

const {
  adoptWorker,
  isW104EnforcedSurface,
  W1_04_ENFORCED_SURFACE_IDS,
  WorkerAuthorizationError,
} = await import("../../src/services/auth/workerAdoption.js");

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

function controlledOutcome({ allowed = true, persisted = true, code = "allowed", resource = null } = {}) {
  return {
    decision: Object.freeze({ allowed, code, resource }),
    persisted,
    mode: "enforced",
    blocked: !allowed,
  };
}

describe("W1-04 worker authorization cutover", () => {
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
    mockAuthorizeControlled.mockImplementation(async ({ resource }) =>
      controlledOutcome({ resource })
    );
  });

  test("freezes the exact W1-04 enforced runtime set", () => {
    expect(W1_04_ENFORCED_SURFACE_IDS).toEqual([
      "worker:issueFix",
      "worker:phase2",
      "worker:maintainer",
      "worker:phase3",
      "scheduled:reconciliation",
    ]);
    for (const surfaceId of W1_04_ENFORCED_SURFACE_IDS) {
      expect(isW104EnforcedSurface(surfaceId)).toBe(true);
    }
    expect(isW104EnforcedSurface("worker:triage")).toBe(false);
    expect(isW104EnforcedSurface("worker:ciHeal")).toBe(false);
    expect(isW104EnforcedSurface("scheduled:phase3")).toBe(false);
  });

  test("non-W1-04 workers preserve observe-only denial behavior", async () => {
    const result = await adoptWorker({
      workerId: "worker:triage",
      permission: "issue:update",
      resourceType: "installation",
      installationId: 7,
      jobData: {},
    });

    expect(result.decision).toEqual({ allowed: false, code: "permission_missing" });
    expect(result.authorizationOutcome).toBeNull();
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
  });

  test("enforced allow requires a persisted controlled decision", async () => {
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
      installationId: 7,
      jobData: { payload: { repository: { id: 11 } } },
    });

    expect(mockAuthorizeControlled).toHaveBeenCalledWith({
      principal: installationPrincipal,
      permission: "merge_queue_entry:update",
      resource: expect.objectContaining({
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
      }),
      mode: "enforced",
    });
    expect(result.authorizationOutcome.persisted).toBe(true);
    expect(result.authorizationOutcome.blocked).toBe(false);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  test("enforced denial throws before the worker can continue", async () => {
    mockResolveRepositoryResource.mockResolvedValue({
      type: "repository",
      installationId: 7,
      repositoryId: 11,
      organization: "trusted-owner",
      repository: "trusted-repo",
    });
    mockAuthorizeControlled.mockResolvedValue(
      controlledOutcome({ allowed: false, persisted: true, code: "permission_missing" }),
    );

    await expect(adoptWorker({
      workerId: "worker:phase2",
      permission: "merge_queue_entry:update",
      resourceType: "repository",
      installationId: 7,
      jobData: { payload: { repository: { id: 11 } } },
    })).rejects.toMatchObject({
      name: "WorkerAuthorizationError",
      reason: "authorization_denied",
      workerId: "worker:phase2",
      decisionCode: "permission_missing",
    });
  });

  test("missing enforced decision evidence fails closed even on allow", async () => {
    mockResolveRepositoryResource.mockResolvedValue({
      type: "repository",
      installationId: 7,
      repositoryId: 11,
      organization: "trusted-owner",
      repository: "trusted-repo",
    });
    mockAuthorizeControlled.mockResolvedValue(
      controlledOutcome({ allowed: true, persisted: false }),
    );

    await expect(adoptWorker({
      workerId: "worker:issueFix",
      permission: "pull_request:create",
      resourceType: "repository",
      installationId: 7,
      systemPrincipalName: "system:issue-fix-worker",
      jobData: { repositoryId: 11 },
    })).rejects.toBeInstanceOf(WorkerAuthorizationError);

    await expect(adoptWorker({
      workerId: "worker:issueFix",
      permission: "pull_request:create",
      resourceType: "repository",
      installationId: 7,
      systemPrincipalName: "system:issue-fix-worker",
      jobData: { repositoryId: 11 },
    })).rejects.toMatchObject({ reason: "authorization_evidence_unavailable" });
  });

  test("maintainer full-name lookup is rebound to DB-owned repository identity", async () => {
    mockResolveRepositoryResourceByFullName.mockResolvedValue({
      type: "repository",
      installationId: 7,
      repositoryId: 22,
      organization: "db-owner",
      repository: "db-repo",
    });

    const result = await adoptWorker({
      workerId: "worker:maintainer",
      permission: "repository:github:act",
      resourceType: "repository",
      installationId: 7,
      jobData: {
        installationId: 7,
        repoFullName: "lookup-owner/lookup-repo",
      },
    });

    expect(mockResolveRepositoryResourceByFullName).toHaveBeenCalledWith(
      7,
      "lookup-owner/lookup-repo",
    );
    expect(result.resource).toMatchObject({
      installationId: 7,
      repositoryId: 22,
      organization: "db-owner",
      repository: "db-repo",
    });
    expect(mockAuthorizeControlled).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ repositoryId: 22 }),
      mode: "enforced",
    }));
  });

  test("Phase-3 empty scheduled jobs use fleet authority, not an unknown installation", async () => {
    const result = await adoptWorker({
      workerId: "worker:phase3",
      permission: "installation:read",
      resourceType: "installation",
      systemPrincipalName: "system:phase3-worker",
      jobData: {},
    });

    expect(result.resource).toEqual({
      type: "fleet",
      installationId: null,
      repositoryId: null,
      organization: null,
      repository: null,
      resourceId: null,
    });
    expect(mockAuthorizeControlled).toHaveBeenCalledWith(expect.objectContaining({
      principal: systemPrincipal,
      resource: result.resource,
      mode: "enforced",
    }));
  });

  test("Phase-3 nonempty jobs without installation remain fail-closed installation scope", async () => {
    const result = await adoptWorker({
      workerId: "worker:phase3",
      permission: "installation:read",
      resourceType: "installation",
      systemPrincipalName: "system:phase3-worker",
      jobData: { repoId: 99 },
    });

    expect(result.resource).toEqual({
      type: "installation",
      installationId: null,
      repositoryId: null,
      organization: null,
      repository: null,
      resourceId: null,
    });
  });

  test("scheduled reconciliation is centrally enforced at fleet scope", async () => {
    await adoptWorker({
      workerId: "scheduled:reconciliation",
      permission: "installation:read",
      resourceType: "fleet",
      systemPrincipalName: "system:reconciliation-worker",
      jobData: {},
    });

    expect(mockAuthorizeControlled).toHaveBeenCalledWith(expect.objectContaining({
      principal: systemPrincipal,
      resource: expect.objectContaining({ type: "fleet" }),
      mode: "enforced",
    }));
  });
});
