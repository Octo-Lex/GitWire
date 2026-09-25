// D0-04: every declared route resource resolver must be executable from
// trusted state, and resolution failures must not manufacture client-controlled
// resource evidence or block observe-only request handling.

import { jest } from "@jest/globals";

const mockQuery = jest.fn();
const mockAuthorize = jest.fn(async () => ({ allowed: true }));
const mockResolveStoredCIRunIdentifier = jest.fn();
const mockGetTriageJob = jest.fn();
const mockWarn = jest.fn();

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockQuery },
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { warn: mockWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/auth/authorize.js", () => ({
  authorize: mockAuthorize,
}));
jest.unstable_mockModule("../../src/services/ciRunResolver.js", () => ({
  resolveStoredCIRunIdentifier: mockResolveStoredCIRunIdentifier,
}));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  triageQueue: { getJob: mockGetTriageJob },
}));

const {
  resolveResource,
  routeAuthObserver,
  SUPPORTED_ROUTE_RESOURCE_RESOLVERS,
} = await import("../../src/middleware/routeAuthObserver.js");
const { CONSEQUENTIAL_SURFACE_MANIFEST } =
  await import("../../src/services/auth/consequentialSurfaceManifest.js");

const REPOSITORY_ROW = {
  github_id: 9001,
  installation_id: 7001,
  owner: "octo",
  name: "wire",
};
const INSTALLATION_ROW = {
  github_id: 7001,
  account_login: "octo",
};

const expectedRepository = () => ({
  type: "repository",
  installationId: 7001,
  repositoryId: 9001,
  organization: "octo",
  repository: "wire",
});
const expectedInstallation = () => ({
  type: "installation",
  installationId: 7001,
  organization: "octo",
  repository: null,
});

const R = Object.freeze({
  policyScope: "request repo -> policy definition scope",
  rollout: "rollout id -> rollout plan",
  triageJob: "jobId -> retained triage payload repository",
  bodyInstallation: "body installation_id or repo_filter -> installation",
  feedbackRule: "feedback rule id -> installation",
  policy: "policy id -> policy_definitions.installation_id",
  violation: "violation id -> enforcement_violations.repo_id",
  optionalRepo: "optional body.repo -> repository; otherwise fleet",
  action: "action id -> managed_actions -> repository",
  duplicate: "duplicate signal id -> repository",
  flaky: "flaky test id -> flaky_tests.repo_id",
  vulnerability: "vulnerability id -> vulnerability_advisories.repo_id",
});

describe("D0-04 declared resolver execution", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockAuthorize.mockClear();
    mockResolveStoredCIRunIdentifier.mockReset();
    mockGetTriageJob.mockReset();
    mockWarn.mockClear();
  });

  test("every consequential route resolver is executable by the observer", () => {
    const declaredResolvers = [...new Set(
      CONSEQUENTIAL_SURFACE_MANIFEST
        .filter((surface) => surface.kind === "route")
        .map((surface) => surface.resourceResolver),
    )].sort();

    expect([...SUPPORTED_ROUTE_RESOURCE_RESOLVERS].sort()).toEqual(declaredResolvers);
  });

  test("unknown resolver strings fail loudly inside the observer boundary", async () => {
    await expect(
      resolveResource("repository", { id: "1" }, "typo -> nowhere"),
    ).rejects.toThrow("Unsupported route resource resolver");
  });

  test("body installation_id is verified from active installation state and wins over repo_filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [INSTALLATION_ROW] });

    await expect(
      resolveResource(
        "installation",
        {},
        R.bodyInstallation,
        { installation_id: 7001, repo_filter: "other/repo" },
      ),
    ).resolves.toEqual(expectedInstallation());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM installations i"),
      [7001],
    );
  });

  test("repo_filter derives installation scope from the authoritative repository row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource(
        "installation",
        {},
        R.bodyInstallation,
        { repo_filter: "octo/wire" },
      ),
    ).resolves.toEqual({
      type: "installation",
      installationId: 7001,
      organization: "octo",
      repository: "wire",
    });
  });

  test.each([
    [R.feedbackRule, "feedback_rules"],
    [R.policy, "policy_definitions"],
  ])("%s resolves the owning installation", async (resolver, tableFragment) => {
    mockQuery.mockResolvedValueOnce({ rows: [INSTALLATION_ROW] });

    await expect(
      resolveResource("installation", { id: "17" }, resolver),
    ).resolves.toEqual(expectedInstallation());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining(tableFragment),
      ["17"],
    );
  });

  test.each([
    [R.violation, "enforcement_violations"],
    [R.duplicate, "duplicate_signals"],
    [R.flaky, "flaky_tests"],
    [R.vulnerability, "vulnerability_advisories"],
  ])("%s resolves the owning repository", async (resolver, tableFragment) => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource("repository", { id: "23" }, resolver),
    ).resolves.toEqual(expectedRepository());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining(tableFragment),
      ["23"],
    );
  });

  test("triage job resolution verifies retained job repository and installation ids against current state", async () => {
    mockGetTriageJob.mockResolvedValueOnce({
      queueName: "triage",
      data: {
        payload: {
          repository: { id: 9001 },
          installation: { id: 7001 },
        },
      },
    });
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });

    await expect(
      resolveResource("repository", { jobId: "job-7" }, R.triageJob),
    ).resolves.toEqual(expectedRepository());

    expect(mockGetTriageJob).toHaveBeenCalledWith("job-7");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("r.github_id = $1"),
      [9001, 7001],
    );
  });

  test("policy-definition and rollout resolvers bind authoritative repository scope", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    await expect(
      resolveResource("policy_definition", {}, R.policyScope, { repo: "octo/wire" }),
    ).resolves.toEqual({
      type: "policy_definition",
      installationId: 7001,
      repositoryId: 9001,
      organization: "octo",
      repository: "wire",
    });

    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    await expect(
      resolveResource("policy_rollout_plan", { id: "31" }, R.rollout),
    ).resolves.toEqual({
      type: "policy_rollout_plan",
      resourceId: "31",
      installationId: 7001,
      repositoryId: 9001,
      organization: "octo",
      repository: "wire",
    });
  });

  test("optional repo resolver returns repository scope only after trusted lookup", async () => {
    await expect(
      resolveResource("fleet", {}, R.optionalRepo, {}),
    ).resolves.toEqual({ type: "fleet" });

    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    await expect(
      resolveResource("fleet", {}, R.optionalRepo, { repo: "octo/wire" }),
    ).resolves.toEqual(expectedRepository());

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      resolveResource("fleet", {}, R.optionalRepo, { repo: "attacker/anything" }),
    ).resolves.toEqual({
      type: "repository",
      organization: null,
      repository: null,
    });
  });

  test("failed action lookup cannot borrow an unrelated req.body.repo", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(
      resolveResource(
        "repository",
        { id: "999999" },
        R.action,
        { repo: "attacker/anything" },
      ),
    ).resolves.toEqual({
      type: "repository",
      organization: null,
      repository: null,
    });
  });

  test("constrained route params expose the canonical id to repository resolution", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPOSITORY_ROW] });
    const req = {
      path: "/api/duplicates/42/confirm",
      method: "POST",
      body: {},
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
      _wave2Observed: false,
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM duplicate_signals x"),
      ["42"],
    );
    expect(mockAuthorize).toHaveBeenCalledWith({
      principal: req.auth,
      permission: "repository:github:act",
      resource: expectedRepository(),
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("resolver database failure stays non-fatal in observe-only middleware", async () => {
    mockQuery.mockRejectedValueOnce(new Error("database unavailable"));
    const req = {
      path: "/api/duplicates/43/dismiss",
      method: "POST",
      body: {},
      auth: { principalId: "principal-1", authenticationMethod: "api_key" },
      _wave2Observed: false,
    };
    const next = jest.fn();

    await routeAuthObserver(req, {}, next);

    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ path: req.path }),
      expect.stringContaining("non-fatal"),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
