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
      if (sql.includes("ai_review_config")) return { rows: [{
        enabled: true,
        review_integrity_v2: "live",
        check_logic: true, check_security: true, check_architecture: true,
        check_cost_leaks: true, check_tests: true, check_docs: false,
        block_on_verdict: ["request_changes"], min_confidence_to_block: "medium",
        max_files_to_review: 30, max_lines_to_review: 2000,
        ignore_patterns: ["*.lock", "package-lock.json"],
        engine: "claude", model: "claude-sonnet-4-20250514",
        max_duration_seconds: 300, bundle_max_chars: 180000,
        require_file_scope: true,
      }] };
      if (sql.includes("INSERT INTO ai_reviews")) return { rows: [{ id: 1 }] };
      if (sql.includes("UPDATE ai_reviews")) return { rows: [] };
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

    // Mock the Anthropic SDK so the suite is hermetic.
    // Returns different formats based on whether tools are present:
    // - No tools: primary review format (findings, overall_correctness)
    // - With tools: verifier format (status, coverageSatisfied)
    const mockAnthropicCreate = jest.fn().mockImplementation((params) => {
      if (params && params.tools && params.tools.length > 0) {
        return Promise.resolve({
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "verified",
              findings: [],
              unresolvedContextNeeds: [],
              coverageSatisfied: true,
            }),
          }],
          usage: { input_tokens: 2000, output_tokens: 200 },
          stop_reason: "end_turn",
        });
      }
      return Promise.resolve({
        content: [{
          type: "text",
          text: JSON.stringify({
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "The changes look clean and correct.",
            overall_confidence: 0.9,
          }),
        }],
        usage: { input_tokens: 5000, output_tokens: 200 },
        stop_reason: "end_turn",
      });
    });
    await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
      default: class { messages = { create: mockAnthropicCreate }; },
    }));
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

  // Helper to build PR object with all fields the v2 cutover needs
  function makeV2PR(f) {
    return {
      number: 42,
      head: { sha: f.prMetadata.head },
      base: { ref: f.prMetadata.base, sha: f.prMetadata.base },
      user: { login: f.prMetadata.author },
      title: f.prMetadata.title,
      body: f.prMetadata.body,
      changed_files: f.changedFiles.length,
    };
  }

  // ── 4 broken fixtures: must never approve ─────────────────────────────────

  it("RI-01 BROKEN: stale status declarations — v2 must NOT approve", async () => {
    const fixtures = getBrokenFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-01");
    const octokit = buildFixtureOctokit(f);
    const result = await reviewPR({
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
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
      pr: makeV2PR(f),
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });
    expect(result).not.toBeNull();
    expect(result.verdict).toBe("approved");
  });

  // ── Fail-closed regression: legacy would approve + v2 failure ⇒ never APPROVE ─

  it("v2 cutover failure forces COMMENT — never falls back to legacy APPROVE", async () => {
    const fixtures = getFixedFixtures();
    const f = fixtures.find(fx => fx.caseId === "RI-01");
    const octokit = buildFixtureOctokit(f);

    // Sabotage ONLY the contents endpoint — v2 buildReviewEvidence calls it
    // to fetch base/head content, but legacy fetchDiff does NOT.
    // This lets the legacy review complete (producing "approved") while
    // causing the v2 cutover to fail.
    const origRequest = octokit.request;
    octokit.request = function(route, params) {
      if (route.includes("GET") && route.includes("/contents/")) {
        return Promise.reject(new Error("Simulated contents API failure"));
      }
      return origRequest.call(octokit, route, params);
    };

    const result = await reviewPR({
      pr: makeV2PR(f),
      repository: { id: 999, owner: { login: "org" }, name: "repo", full_name: "org/repo" },
      octokit,
      commentFindings: false,
    });

    // Legacy review would produce "approved", but v2 cutover fails.
    // Fail-closed: must force COMMENT, never APPROVE.
    expect(result).not.toBeNull();
    expect(result.verdict).not.toBe("approved");
    expect(result.verdict).toBe("needs_discussion");
  });
});
