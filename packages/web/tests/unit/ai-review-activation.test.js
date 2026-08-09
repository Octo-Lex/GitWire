// tests/unit/ai-review-activation.test.js
// Tests for the AI review dual-gate activation fix (PF-B1-01).
//
// The defect: when .gitwire.yml has ai_review.enabled: true but the
// ai_review_config DB row is missing or disabled, reviewPR() returned bare
// null — indistinguishable from other skips. The finalizer then rendered
// the generic "not configured or skipped" message.
//
// The fix: the config-gate skip returns { skipped: true, reason: "not_activated" }
// so the finalizer can render an actionable message. getEffectiveReviewState()
// is the single source of truth for "is AI review effectively runnable."

import { jest } from "@jest/globals";

// ── Mocks ────────────────────────────────────────────────────────────────────
// config/index.js validates env vars and calls process.exit(1) at import time
// when DATABASE_URL / REDIS_URL are missing. Mock it before anything imports it.

const TEST_BASE_URL = "https://gitwire.test.local";

await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    server: { baseUrl: TEST_BASE_URL },
    anthropic: { apiKey: "", baseURL: undefined },
  },
}));

const mockDbQuery = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockDbQuery },
}));

await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock configService so getEffectiveReviewState can resolve Gate 1
const mockGetConfigForRepo = jest.fn();
await jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: mockGetConfigForRepo,
}));

// Mock the Anthropic SDK so we don't need an API key
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })),
}));

const { reviewPR, getEffectiveReviewState } = await import("../../src/services/aiReviewService.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePR(overrides = {}) {
  return {
    number: 1,
    head: { sha: "abc123" },
    base: { ref: "main" },
    user: { login: "human-dev" },
    ...overrides,
  };
}

function makeRepo(overrides = {}) {
  return {
    id: 999,
    owner: { login: "acme" },
    name: "app",
    full_name: "acme/app",
    ...overrides,
  };
}

// Minimal octokit mock — only needs to not crash if reviewPR proceeds past config.
// For config-skip tests it never gets called.
const mockOctokit = { request: jest.fn() };

describe("PF-B1-01: AI review activation gate", function () {

  beforeEach(function () {
    jest.clearAllMocks();
    // Default: no config row (the defect condition)
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockGetConfigForRepo.mockResolvedValue({
      pillars: { ai_review: { enabled: true } },
    });
  });

  // ── reviewPR config-gate skip (tests 1-2) ──────────────────────────────────

  it("returns { skipped, reason: not_activated } when DB row is missing", async function () {
    mockDbQuery.mockResolvedValue({ rows: [] }); // no ai_review_config row

    const result = await reviewPR({ pr: makePR(), repository: makeRepo(), octokit: mockOctokit });

    expect(result).toEqual({
      skipped: true,
      reason: "not_activated",
      activationUrl: TEST_BASE_URL + "/dashboard/intelligence",
    });
  });

  it("returns { skipped, reason: not_activated } when DB row has enabled: false", async function () {
    mockDbQuery.mockResolvedValue({ rows: [{ enabled: false }] });

    const result = await reviewPR({ pr: makePR(), repository: makeRepo(), octokit: mockOctokit });

    expect(result).toEqual({
      skipped: true,
      reason: "not_activated",
      activationUrl: TEST_BASE_URL + "/dashboard/intelligence",
    });
  });

  // ── reviewPR bot-author skip stays bare null (test 3) ──────────────────────

  it("returns bare null for bot-authored PR (not structured skip)", async function () {
    const result = await reviewPR({
      pr: makePR({ user: { login: "gitwire-hq[bot]" } }),
      repository: makeRepo(),
      octokit: mockOctokit,
    });

    expect(result).toBeNull();
  });

  // ── getEffectiveReviewState (tests 4-6) ────────────────────────────────────

  it("effective state: Gate1 enabled + DB absent → not_activated", async function () {
    mockGetConfigForRepo.mockResolvedValue({ pillars: { ai_review: { enabled: true } } });
    mockDbQuery.mockResolvedValue({ rows: [] });

    const state = await getEffectiveReviewState(999, "acme/app");

    expect(state.runnable).toBe(false);
    expect(state.reason).toBe("not_activated");
    expect(state.pillarEnabled).toBe(true);
    expect(state.dbActivated).toBe(false);
    expect(state.activationUrl).toBe(TEST_BASE_URL + "/dashboard/intelligence");
  });

  it("effective state: Gate1 disabled → pillar_disabled", async function () {
    mockGetConfigForRepo.mockResolvedValue({ pillars: { ai_review: { enabled: false } } });
    mockDbQuery.mockResolvedValue({ rows: [{ enabled: true }] });

    const state = await getEffectiveReviewState(999, "acme/app");

    expect(state.runnable).toBe(false);
    expect(state.reason).toBe("pillar_disabled");
    expect(state.pillarEnabled).toBe(false);
    expect(state.dbActivated).toBe(true);
  });

  it("effective state: both gates enabled → runnable", async function () {
    mockGetConfigForRepo.mockResolvedValue({ pillars: { ai_review: { enabled: true } } });
    mockDbQuery.mockResolvedValue({ rows: [{ enabled: true }] });

    const state = await getEffectiveReviewState(999, "acme/app");

    expect(state.runnable).toBe(true);
    expect(state.reason).toBeNull();
    expect(state.pillarEnabled).toBe(true);
    expect(state.dbActivated).toBe(true);
  });
});
