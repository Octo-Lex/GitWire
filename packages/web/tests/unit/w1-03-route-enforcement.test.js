// W1-03: central HTTP authorization is a blocking pre-handler gate.

import { jest } from "@jest/globals";

const mockAuthorizeControlled = jest.fn();
const mockAuthorizeWithPersistence = jest.fn();
const mockAuthorize = jest.fn();
const mockResolveRouteResource = jest.fn();
const mockLogDecision = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorizeControlled: mockAuthorizeControlled,
  authorizeWithPersistence: mockAuthorizeWithPersistence,
  authorize: mockAuthorize,
}));
jest.unstable_mockModule("../../src/services/auth/decisionLog.js", () => ({
  logDecision: mockLogDecision,
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/routeResourceResolver.js", () => ({
  resolveRouteResource: mockResolveRouteResource,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS: Object.freeze([]),
}));
jest.unstable_mockModule("../../src/services/auth/declarations.js", () => ({
  registerAllProtectedSurfaces: jest.fn(),
}));

const surfaces = Object.freeze([
  {
    id: "route:PUT:/api/maintainer/collaborators/:owner/:repo/:login",
    kind: "route",
    permission: "repository:github:act",
    resourceType: "repository",
    resourceResolver: "owner/repo -> repositories",
    authorizationMode: "enforced",
  },
  {
    id: "route:DELETE:/api/waivers/:id",
    kind: "route",
    permission: "repository:update",
    resourceType: "repository",
    resourceResolver: "waiver id -> waivers.repo_id -> repositories",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/enforcement/run",
    kind: "route",
    permission: "repository:github:act",
    resourceType: "fleet",
    resourceResolver: "optional body.repo -> repository; otherwise fleet",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/gates/:owner/:repo/evaluate",
    kind: "route",
    permission: "quality_gate:evaluate",
    resourceType: "repository",
    resourceResolver: "owner/repo -> repositories",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/phase2/queue/:owner/:repo/config",
    kind: "route",
    permission: "merge_queue_entry:update",
    resourceType: "repository",
    resourceResolver: "owner/repo -> repositories",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/phase3/dependencies/vuln/:id/dismiss",
    kind: "route",
    permission: "repository:update",
    resourceType: "repository",
    resourceResolver: "vulnerability id -> vulnerability_advisories.repo_id",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/triage/failures/:jobId/retry",
    kind: "route",
    permission: "repository:update",
    resourceType: "repository",
    resourceResolver: "jobId -> retained triage payload repository",
    authorizationMode: "enforced",
  },
  {
    id: "route:POST:/api/actions/:id/retry",
    kind: "route",
    permission: "repository:update",
    resourceType: "repository",
    resourceResolver: "action id -> managed_actions -> repository",
    authorizationMode: "observe",
  },
]);

jest.unstable_mockModule("../../src/services/auth/protectedSurfaces.js", () => ({
  listProtectedSurfaces: () => surfaces,
}));

const { routeAuthObserver } = await import("../../src/middleware/routeAuthObserver.js");

const principal = Object.freeze({
  principalId: "principal-1",
  principalType: "service",
  authenticationMethod: "api_key",
});
const canonicalRepository = Object.freeze({
  type: "repository",
  installationId: 7,
  repositoryId: 11,
  organization: "trusted-owner",
  repository: "trusted-repo",
});

function makeResponse() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { status, json };
}

function enforcedOutcome({ allowed, code = allowed ? "allowed" : "permission_missing", persisted = true }) {
  const decision = Object.freeze({
    allowed,
    code,
    permission: "repository:update",
    resource: canonicalRepository,
  });
  return Object.freeze({
    decision,
    persisted,
    mode: "enforced",
    blocked: !allowed,
  });
}

describe("W1-03 central route enforcement", () => {
  beforeEach(() => {
    mockAuthorizeControlled.mockReset();
    mockAuthorizeWithPersistence.mockReset();
    mockAuthorize.mockReset();
    mockResolveRouteResource.mockReset();
    mockLogDecision.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockResolveRouteResource.mockResolvedValue(canonicalRepository);
  });

  test("allowed central request binds canonical authority, persists enforced evidence, caches decision, and continues once", async () => {
    const decision = Object.freeze({
      allowed: true,
      code: "allowed",
      permission: "repository:github:act",
      resource: canonicalRepository,
    });
    mockAuthorizeControlled.mockResolvedValue(Object.freeze({
      decision,
      persisted: true,
      mode: "enforced",
      blocked: false,
    }));
    const req = {
      path: "/api/maintainer/collaborators/attacker/spoof/alice",
      method: "PUT",
      auth: principal,
      body: { owner: "body-attacker", repo: "body-spoof", installation_id: 999 },
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockResolveRouteResource).toHaveBeenCalledWith(
      "repository",
      { owner: "attacker", repo: "spoof", login: "alice" },
      "owner/repo -> repositories",
      req.body,
    );
    expect(mockAuthorizeControlled).toHaveBeenCalledWith({
      principal,
      permission: "repository:github:act",
      resource: canonicalRepository,
      mode: "enforced",
    });
    expect(req.authority).toMatchObject({
      principal,
      surfaceId: "route:PUT:/api/maintainer/collaborators/:owner/:repo/:login",
      resource: {
        type: "repository",
        installationId: 7,
        repositoryId: 11,
        organization: "trusted-owner",
        repository: "trusted-repo",
      },
    });
    expect(req._wave2Observed).toBe(true);
    expect(req._wave2DeclarationObserved).toBe(true);
    expect(req._wave2DeclarationDecision).toBe(decision);
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("persisted policy denial returns repository-standard 403 and never reaches the handler", async () => {
    mockAuthorizeControlled.mockResolvedValue(enforcedOutcome({ allowed: false }));
    const req = {
      path: "/api/waivers/waiver-7",
      method: "DELETE",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Forbidden", code: "permission_missing" });
    expect(next).not.toHaveBeenCalled();
  });

  test("an allowed decision without durable enforced evidence fails closed", async () => {
    mockAuthorizeControlled.mockResolvedValue(enforcedOutcome({ allowed: true, persisted: false }));
    const req = {
      path: "/api/gates/octo/wire/evaluate",
      method: "POST",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Authorization unavailable" });
    expect(req._wave2DeclarationObserved).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  test("resource-resolution failure fails closed before authorization and handler execution", async () => {
    mockResolveRouteResource.mockRejectedValue(new Error("resolver unavailable"));
    const req = {
      path: "/api/phase2/queue/octo/wire/config",
      method: "POST",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "Authorization unavailable" });
    expect(next).not.toHaveBeenCalled();
  });

  test("authorization-control failure fails closed before handler execution", async () => {
    mockAuthorizeControlled.mockRejectedValue(new Error("authorization unavailable"));
    const req = {
      path: "/api/enforcement/run",
      method: "POST",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  test("observe-only route remains nonblocking when observation fails", async () => {
    mockResolveRouteResource.mockRejectedValue(new Error("observe resolver unavailable"));
    const req = {
      path: "/api/actions/action-7/retry",
      method: "POST",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("handler-owned triage route delegates without duplicate central authorization", async () => {
    const req = {
      path: "/api/triage/failures/job-42/retry",
      method: "POST",
      auth: principal,
      body: { reason: "retry" },
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockResolveRouteResource).not.toHaveBeenCalled();
    expect(mockAuthorizeControlled).not.toHaveBeenCalled();
    expect(mockAuthorizeWithPersistence).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("central matching preserves Express case-insensitive and trailing-slash semantics", async () => {
    const decision = Object.freeze({
      allowed: true,
      code: "allowed",
      permission: "repository:github:act",
      resource: canonicalRepository,
    });
    mockAuthorizeControlled.mockResolvedValue(Object.freeze({
      decision,
      persisted: true,
      mode: "enforced",
      blocked: false,
    }));
    const req = {
      path: "/API/MAINTAINER/COLLABORATORS/OCTO/WIRE/ALICE/",
      method: "PUT",
      auth: principal,
      body: {},
    };
    const res = makeResponse();
    const next = jest.fn();

    await routeAuthObserver(req, res, next);

    expect(mockResolveRouteResource).toHaveBeenCalledWith(
      "repository",
      { owner: "OCTO", repo: "WIRE", login: "ALICE" },
      "owner/repo -> repositories",
      {},
    );
    expect(mockAuthorizeControlled).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["Maintainer", "PUT", "/api/maintainer/collaborators/octo/wire/alice"],
    ["Waivers", "DELETE", "/api/waivers/waiver-7"],
    ["Enforcement", "POST", "/api/enforcement/run"],
    ["Gates", "POST", "/api/gates/octo/wire/evaluate"],
    ["Phase 2", "POST", "/api/phase2/queue/octo/wire/config"],
    ["Phase 3", "POST", "/api/phase3/dependencies/vuln/vuln-7/dismiss"],
  ])("%s denial cannot cross the middleware boundary into downstream effects", async (_family, method, path) => {
    mockAuthorizeControlled.mockImplementation(async ({ permission, resource }) => Object.freeze({
      decision: Object.freeze({
        allowed: false,
        code: "permission_missing",
        permission,
        resource,
      }),
      persisted: true,
      mode: "enforced",
      blocked: true,
    }));
    const req = { path, method, auth: principal, body: {} };
    const res = makeResponse();
    const downstreamEffect = jest.fn();

    await routeAuthObserver(req, res, downstreamEffect);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(downstreamEffect).not.toHaveBeenCalled();
  });
});
