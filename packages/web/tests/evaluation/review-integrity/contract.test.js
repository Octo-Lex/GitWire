// tests/evaluation/review-integrity/contract.test.js
// V2 review integrity contract suite.
//
// Defines the target behavior of the v2 review integrity implementation.
// Guarded by REVIEW_INTEGRITY_V2=1 so these do not run against the current
// engine. When v2 lands, enabling the flag turns these into the regression
// gate: broken fixtures must never approve, fixed fixtures must be approvable.
//
// These tests are EXPECTED TO FAIL if somebody enables the flag against
// today's engine — that is the point. They define the contract, not the
// current behavior.

import { jest } from "@jest/globals";

const REVIEW_INTEGRITY_V2 = process.env.REVIEW_INTEGRITY_V2 === "1";
const describeOrSkip = REVIEW_INTEGRITY_V2 ? describe : describe.skip;

// Import conditionally to avoid config validation crash when disabled
let getAllFixtures, getBrokenFixtures, getFixedFixtures, buildFixtureOctokit, reviewPR;

if (REVIEW_INTEGRITY_V2) {
  // These will be set up in a beforeAll to allow dynamic imports
}

// ── V2 contract: broken fixtures must NEVER approve ─────────────────────────

describeOrSkip("RI v2 contract — broken fixtures must never approve", () => {
  beforeAll(async () => {
    const reg = await import("./fixtures/registry.js");
    getAllFixtures = reg.getAllFixtures;
    getBrokenFixtures = reg.getBrokenFixtures;
    getFixedFixtures = reg.getFixedFixtures;
    const fix = await import("./fixtureOctokit.js");
    buildFixtureOctokit = fix.buildFixtureOctokit;

    // Mock dependencies for reviewPR
    await jest.unstable_mockModule("../../../config/index.js", () => ({
      config: {
        anthropic: { apiKey: "test-key", baseURL: "http://test" },
        redis: { url: "redis://test" },
        github: { appId: "123", privateKey: "test" },
        server: { baseUrl: "https://gitwire.test" },
      },
    }));
    await jest.unstable_mockModule("../../../src/lib/logger.js", () => ({
      logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
      },
    }));
    const mockDbQuery = jest.fn().mockImplementation((sql) => {
      if (sql.includes("ai_review_config")) return { rows: [{ enabled: true }] };
      if (sql.includes("ai_reviews")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    await jest.unstable_mockModule("../../../src/lib/db.js", () => ({ db: { query: mockDbQuery } }));
    await jest.unstable_mockModule("../../../src/services/auth/authorize.js", () => ({
      authorize: jest.fn().mockResolvedValue({ allowed: true, code: "ok", principalId: "p" }),
    }));
    await jest.unstable_mockModule("../../../src/services/auth/decisionLog.js", () => ({
      logDecision: jest.fn().mockResolvedValue(undefined),
      countRecentDisagreements: jest.fn().mockResolvedValue(0),
    }));
    await jest.unstable_mockModule("../../../src/services/auth/principalResolver.js", () => ({
      getInstallationPrincipal: jest.fn().mockResolvedValue({ id: "p", principal_type: "installation" }),
      getSystemPrincipal: jest.fn().mockResolvedValue(null),
      getPrincipalById: jest.fn().mockResolvedValue(null),
      principalValidityCode: jest.fn(() => "valid"),
    }));
    await jest.unstable_mockModule("../../../src/lib/queue.js", () => ({
      redis: { setex: jest.fn(), get: jest.fn(), del: jest.fn() },
    }));
    await jest.unstable_mockModule("../../../src/lib/github.js", () => ({ getInstallationClient: jest.fn() }));
    await jest.unstable_mockModule("../../../src/lib/githubWrapper.js", () => ({ wrapOctokit: (c) => c }));
    await jest.unstable_mockModule("../../../src/services/auditTrailService.js", () => ({
      Trail: { aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
    }));
    await jest.unstable_mockModule("../../../src/services/pipelineEvents.js", () => ({
      Events: { ciRunCompleted: jest.fn() },
    }));
    await jest.unstable_mockModule("../../../src/services/configService.js", () => ({
      getConfigForRepo: jest.fn().mockResolvedValue({ pillars: { ai_review: { enabled: true } } }),
    }));

    const svc = await import("../../../src/services/aiReviewService.js");
    reviewPR = svc.reviewPR;
  });

  // ── 4 broken fixtures: must never approve ─────────────────────────────────

  it("RI-01 BROKEN: stale status declarations — v2 must NOT approve", async () => {
    const fixtures = getBrokenFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-01");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).not.toBe("approved");
  });

  it("RI-02 BROKEN: gate/contract mismatch — v2 must NOT approve", async () => {
    const fixtures = getBrokenFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-02");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).not.toBe("approved");
  });

  it("RI-03 BROKEN: basePath omitted — v2 must NOT approve", async () => {
    const fixtures = getBrokenFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-03");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).not.toBe("approved");
  });

  it("RI-04 BROKEN: unpaginated marker lookup — v2 must NOT approve", async () => {
    const fixtures = getBrokenFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-04");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).not.toBe("approved");
  });

  // ── 4 fixed fixtures: should be approvable ────────────────────────────────

  it("RI-01 FIXED: synchronized declarations — v2 should approve", async () => {
    const fixtures = getFixedFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-01");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).toBe("approved");
  });

  it("RI-02 FIXED: gate updated — v2 should approve", async () => {
    const fixtures = getFixedFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-02");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).toBe("approved");
  });

  it("RI-03 FIXED: correct basePath — v2 should approve", async () => {
    const fixtures = getFixedFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-03");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).toBe("approved");
  });

  it("RI-04 FIXED: pagination added — v2 should approve", async () => {
    const fixtures = getFixedFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-04");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: { number: 42, head: { sha: f.prMetadata.head }, base: { ref: f.prMetadata.base },
            user: { login: f.prMetadata.author }, title: f.prMetadata.title, body: f.prMetadata.body },
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).toBe("approved");
  });
});
