// tests/unit/service-ai-review.test.js
// Tests for the bundle-driven AI review service (v2).
//
// Mocks: db, logger, auditTrailService, pipelineEvents, anthropic SDK,
//         reviewBundleService (buildReviewBundle), reviewHeartbeat (withHeartbeat)

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params) : h;
      return { data: {} };
    },
    _calls: calls,
  };
}

// Mock DB
await jest.unstable_mockModule('../../src/lib/db.js', () => ({
  db: { query: mockQuery },
}));

// Mock logger
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

// Mock audit trail
await jest.unstable_mockModule('../../src/services/auditTrailService.js', () => ({
  Trail: {
    appendEntry: jest.fn(),
    aiDecision: jest.fn(),
    reviewGateBlock: jest.fn(),
  },
}));

// Mock pipeline events
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));

// Mock Anthropic SDK
const mockCreate = jest.fn();
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));

// Mock config
await jest.unstable_mockModule('../../config/index.js', () => ({
  config: {
    server: { env: 'test' },
    anthropic: { apiKey: 'test', baseURL: 'http://test' },
    ai: { model: 'test-model' },
  },
}));

// Mock reviewBundleService — returns a minimal bundle
await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({
    bundle: "## PR Metadata\nTest PR\n## Changes\n```diff\n+hello\n```",
    changedFiles: ["src/index.js"],
    totalChars: 100,
  }),
}));

// Mock reviewValidator — passes through everything
await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report, changedFiles) => {
    // Simulate the real validator: convert to legacy format
    const findings = (report.findings || []).map(function (f) {
      return {
        category: f.category,
        severity: f.priority === "P0" ? "critical" : f.priority === "P1" ? "high" : f.priority === "P2" ? "medium" : "low",
        title: f.title,
        description: f.body || "",
        suggestion: "",
        file: f.code_location?.file_path || null,
        line: f.code_location?.line || null,
        confidence: f.confidence,
      };
    });
    const isCorrect = report.overall_correctness === "patch is correct";
    let verdict = "approved";
    if (!isCorrect && findings.some(function (f) { return f.severity === "critical"; })) {
      verdict = "request_changes";
    } else if (!isCorrect) {
      verdict = "needs_discussion";
    }
    return {
      valid: true,
      legacy: {
        findings,
        verdict,
        confidence: report.overall_confidence >= 0.8 ? "high" : report.overall_confidence >= 0.5 ? "medium" : "low",
        summary: report.overall_explanation || "",
        overallCorrectness: report.overall_correctness,
        overallConfidence: report.overall_confidence,
      },
      keptFindings: findings,
      ignoredFindings: [],
      schemaErrors: [],
      scopeDroppedCount: 0,
    };
  }),
}));

// Mock reviewHeartbeat — just run the function directly
await jest.unstable_mockModule('../../src/services/reviewHeartbeat.js', () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));

const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r', default_branch: 'main' };

describe('aiReviewService (bundle-driven v2)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreate.mockReset();
  });

  test('skips when no config found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const oct = mockOctokit();
    const r = await reviewPR({ pr: { number: 5 }, repository: REPO, octokit: oct });
    expect(r).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('skips when config has enabled=false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, enabled: false }] });
    const oct = mockOctokit();
    const r = await reviewPR({ pr: { number: 5 }, repository: REPO, octokit: oct });
    expect(r).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('reviews PR: clean report (no findings)', async () => {
    // 1. loadReviewConfig → enabled
    // 2. INSERT INTO ai_reviews → reviewRow
    // 3-5. buildReviewBundle DB queries (mocked away by module mock)
    // 6. AI call → clean report
    // 7. UPDATE ai_reviews (final persist)
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockResolvedValue({ rows: [] }); // all subsequent DB calls (final update, etc.)

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "The patch looks clean.",
        overall_confidence: 0.95,
      }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/index.js', status: 'modified', additions: 5, deletions: 0, patch: '+hello' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    const r = await reviewPR({
      pr: { number: 5, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: add x', user: { login: 'dev' }, body: '' },
      repository: REPO,
      octokit: oct,
    });

    expect(r).toBeTruthy();
    expect(r.verdict).toBe('approved');
    expect(r.findings).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('reviews PR: report with P0 finding blocks PR', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 101 }] })
      .mockResolvedValue({ rows: [] });

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        findings: [{
          title: "SQL injection vulnerability",
          body: "User input concatenated into SQL query without parameterization.",
          priority: "P0",
          confidence: 0.95,
          category: "security",
          code_location: { file_path: "src/db.js", line: 42 },
        }],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Critical SQL injection found.",
        overall_confidence: 0.9,
      }) }],
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 11 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/db.js', status: 'modified', additions: 10, deletions: 2, patch: '+sql query' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 201 } },
    });

    const r = await reviewPR({
      pr: { number: 6, head: { sha: 'def456' }, base: { ref: 'main' }, title: 'feat: add query', user: { login: 'dev' }, body: '' },
      repository: REPO,
      octokit: oct,
    });

    expect(r).toBeTruthy();
    expect(r.verdict).toBe('request_changes');
    expect(r.findings.length).toBe(1);
    expect(r.findings[0].severity).toBe('critical');
    expect(r.blocked).toBe(true);
  });

  test('reviews PR: handles JSON extraction failure gracefully', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 102 }] })
      .mockResolvedValue({ rows: [] });

    // Return non-JSON text
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: "I reviewed the code and it looks fine to me. No issues found." }],
      usage: { input_tokens: 100, output_tokens: 30 },
    });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 12 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/x.js', status: 'modified', additions: 3, deletions: 0, patch: '+x' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });

    const r = await reviewPR({
      pr: { number: 7, head: { sha: 'ghi789' }, base: { ref: 'main' }, title: 'fix: typo', user: { login: 'dev' }, body: '' },
      repository: REPO,
      octokit: oct,
    });

    // Should return null since JSON extraction failed
    expect(r).toBeNull();
  });

  test('reviews PR: no reviewable files returns null', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: ['**'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 103 }] });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 13 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/x.js', status: 'modified', additions: 3, deletions: 0, patch: '+x' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });

    const r = await reviewPR({
      pr: { number: 8, head: { sha: 'jkl012' }, base: { ref: 'main' }, title: 'chore: deps', user: { login: 'dev' }, body: '' },
      repository: REPO,
      octokit: oct,
    });

    expect(r).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
