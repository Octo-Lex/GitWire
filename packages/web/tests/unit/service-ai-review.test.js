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
// Several modules under test construct their own Anthropic client at module
// load. Record every constructor's options and, per instance, which options
// object served each messages.create call, so a test can prove a specific
// request ran on a client constructed with specific transport options.
const mockCreate = jest.fn();
const anthropicCtorOptions = [];
let lastCreateCtorOptions = null;
let lastCreateRequestOptions = null;
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class {
    constructor(options) {
      anthropicCtorOptions.push(options);
      this.messages = {
        create: (request, requestOptions) => {
          lastCreateCtorOptions = options;
          lastCreateRequestOptions = requestOptions;
          return mockCreate(request);
        },
      };
    }
  },
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
// PC-01 v2.1: mock token accounting — count always fits, classify passthrough
await jest.unstable_mockModule('../../src/services/reviewTokenAccounting.js', () => ({
  countInputTokens: jest.fn().mockResolvedValue(1000),
  classifyProviderRejection: jest.fn((e) => e?.gitwireRejectionClass || 'other'),
  MAX_PRIMARY_INPUT_TOKENS: 958016,
}));

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

const { reviewPR, isRetryableReviewFailure } = await import('../../src/services/aiReviewService.js');
// Same mocked instance reviewPR resolves through (module is mocked above).
const { withHeartbeat } = await import('../../src/services/reviewHeartbeat.js');

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
    // PF-B1-01: config-gate skip returns structured object, not bare null
    expect(r).toEqual({ skipped: true, reason: "not_activated", activationUrl: expect.any(String) });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('skips when config has enabled=false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, enabled: false }] });
    const oct = mockOctokit();
    const r = await reviewPR({ pr: { number: 5 }, repository: REPO, octokit: oct });
    // PF-B1-01: same structured skip for explicit disabled
    expect(r).toEqual({ skipped: true, reason: "not_activated", activationUrl: expect.any(String) });
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
      .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] }))); // all subsequent DB calls (final update, etc.)

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
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'abc123' } } },
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
      .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));

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
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/db.js', status: 'modified', additions: 10, deletions: 2, patch: '@@ -40,5 +40,6 @@\n context\n+sql query' }] },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'def456' } } },
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
      .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));

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

  // ── Effective review-duration resolution (Unit A recovery) ─────────────────
  // The review path resolves its hard timeout from the persisted
  // ai_review_config row (cfg.max_duration_seconds * 1000) and only falls
  // back to DEFAULT_MAX_DURATION_MS when the row omits the column. These
  // cases prove the effective configuration path, not the fallback constant.
  describe('effective review duration (Unit A: 600 s)', () => {
    beforeEach(() => {
      withHeartbeat.mockClear();
    });

    function setupCleanReview(cfgOverrides = {}) {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [], ...cfgOverrides }] })
        .mockResolvedValueOnce({ rows: [{ id: 100 }] })
        .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: "The patch looks clean.",
          overall_confidence: 0.95,
        }) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      return mockOctokit({
        'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/index.js', status: 'modified', additions: 5, deletions: 0, patch: '+hello' }] },
        'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'abc123' } } },
        'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
      });
    }

    test('normally activated repository (persisted 600 s row) reviews with a 600 s timeout', async () => {
      // Row as POST /review/config now creates and migration 044 produces.
      const oct = setupCleanReview({ max_duration_seconds: 600 });
      const r = await reviewPR({
        pr: { number: 21, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: x', user: { login: 'dev' }, body: '' },
        repository: REPO,
        octokit: oct,
      });
      expect(r).toBeTruthy();
      expect(withHeartbeat).toHaveBeenCalledTimes(1);
      const [, hbOpts600] = withHeartbeat.mock.calls[0];
      expect(hbOpts600.label).toBe('claude review');
      expect(hbOpts600.timeoutMs).toBeGreaterThan(595000);
      expect(hbOpts600.timeoutMs).toBeLessThanOrEqual(600000);
    });

    test('config row omitting max_duration_seconds falls back to the 600 s default', async () => {
      const oct = setupCleanReview();
      const r = await reviewPR({
        pr: { number: 22, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: y', user: { login: 'dev' }, body: '' },
        repository: REPO,
        octokit: oct,
      });
      expect(r).toBeTruthy();
      const [, hbOptsDef] = withHeartbeat.mock.calls[0];
      expect(hbOptsDef.label).toBe('claude review');
      expect(hbOptsDef.timeoutMs).toBeGreaterThan(595000);
      expect(hbOptsDef.timeoutMs).toBeLessThanOrEqual(600000);
    });

    test('explicit operator-set duration is honored (resolution is row-driven, not hardcoded)', async () => {
      const oct = setupCleanReview({ max_duration_seconds: 300 });
      await reviewPR({
        pr: { number: 23, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: z', user: { login: 'dev' }, body: '' },
        repository: REPO,
        octokit: oct,
      });
      const [, hbOpts300] = withHeartbeat.mock.calls[0];
      expect(hbOpts300.label).toBe('claude review');
      expect(hbOpts300.timeoutMs).toBeGreaterThan(295000);
      expect(hbOpts300.timeoutMs).toBeLessThanOrEqual(300000);
    });
  });

  // ── RC-01: review output headroom + client transport timeout ────────────────
  // 32,768 replaces the 16,384 ceiling that a production-shaped bundle
  // exhausted (19,746 output tokens demanded, empty output). The client
  // transport timeout is pinned explicitly to the 600,000 ms review deadline
  // so the bound never rides on SDK defaults.
  describe('RC-01: output headroom and client transport', () => {
    function setupHeadroomReview() {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [], max_duration_seconds: 600 }] })
        .mockResolvedValueOnce({ rows: [{ id: 100 }] })
        .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));

      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({
          findings: [],
          overall_correctness: "patch is correct",
          overall_explanation: "The patch looks clean.",
          overall_confidence: 0.95,
        }) }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      return mockOctokit({
        'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/index.js', status: 'modified', additions: 5, deletions: 0, patch: '+hello' }] },
        'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'abc123' } } },
        'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
      });
    }

    test('primary structured review call sends max_tokens 32768', async () => {
      const oct = setupHeadroomReview();
      const r = await reviewPR({
        pr: { number: 31, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: headroom', user: { login: 'dev' }, body: '' },
        repository: REPO,
        octokit: oct,
      });

      expect(r).toBeTruthy();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const request = mockCreate.mock.calls[0][0];
      expect(request.max_tokens).toBe(32768);
      expect(request.max_tokens).not.toBe(16384);
      // Non-regression: the ceiling moves, nothing else about the call does.
      expect(request.model).toBe('claude-sonnet-4-20250514');
      expect('reasoning_effort' in request).toBe(false);
    });

    test('the client serving the review call is constructed with a 600000 ms transport timeout', async () => {
      const oct = setupHeadroomReview();
      const r = await reviewPR({
        pr: { number: 32, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: transport', user: { login: 'dev' }, body: '' },
        repository: REPO,
        octokit: oct,
      });

      expect(r).toBeTruthy();
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // The structured-review request must run on the client whose
      // constructor carried the explicit transport bound.
      expect(lastCreateCtorOptions).toBeTruthy();
      expect(lastCreateCtorOptions.timeout).toBe(600000);
      expect(lastCreateCtorOptions.apiKey).toBe('test');
      expect(lastCreateCtorOptions.baseURL).toBe('http://test');
      expect(anthropicCtorOptions).toContain(lastCreateCtorOptions);
    });
  });
});

// ── PC-01 v2.1: model-context admission ──────────────────────────────────────
// Exact token accounting gates the primary request: if the PR fits the
// 958,016-input-token envelope it is sent whole; overflow allocates
// deterministically in file order and marks the omitted files
// bundle_truncated. A count failure never falls back to an estimate.
const { countInputTokens } = await import('../../src/services/reviewTokenAccounting.js');
const { buildReviewBundle } = await import('../../src/services/reviewBundleService.js');

describe('PC-01 v2.1: model-context admission', () => {
  beforeEach(() => {
    countInputTokens.mockReset();
    countInputTokens.mockResolvedValue(1000);
    buildReviewBundle.mockClear();
    mockQuery.mockReset();
    mockCreate.mockReset();
  });

  function setupAdmissionReview(files) {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium', max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockImplementation((sql) => (String(sql).includes("publication_claimed_at = NOW()") ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "The patch looks clean.",
        overall_confidence: 0.95,
      }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const data = files.map((f) => ({ filename: f, status: 'modified', additions: 5, deletions: 0, patch: '+patch-for-' + f }));
    return mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'abc123' } } },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });
  }

  // Bundle-parts override mirroring the real builder's structural contract
  // (sections + deterministic reassemble), for overflow-path tests.
  function admissionParts(paths) {
    const sections = paths.map((p) => ({ path: p, text: '#### ' + p + '\n```diff\n+patch-for-' + p + '\n```' }));
    const meta = '## PR Metadata\nTest\n## Changes\n\n### File Summary\n' + paths.map((p) => '  modified ' + p).join('\n') + '\n\n### Diffs';
    const context = '\n## Repository Context\n\n## Active Configuration\nAI Review enabled: yes';
    const assemble = (n, note) => meta + '\n' + sections.slice(0, n).map((s) => s.text).join('\n') + (note ? '\n' + note : '') + context;
    const reassemble = (n) => {
      const clamped = Math.max(0, Math.min(n, sections.length));
      const omitted = sections.length - clamped;
      const adj = sections.slice(clamped).map((s) => ({ path: s.path, coverage: 'partial', reason: 'bundle_truncated' }));
      const note = omitted > 0 ? '(review input token budget reached — ' + omitted + ' remaining changed-file diff' + (omitted !== 1 ? 's' : '') + ' omitted)' : null;
      return { bundle: assemble(clamped, note), coverageAdjustments: adj };
    };
    return {
      bundle: assemble(sections.length), changedFiles: paths, totalChars: 100,
      coverageAdjustments: [], fileSections: sections, reassemble,
    };
  }

  test('the counted request is byte-identical to the sent request (fits path)', async () => {
    const oct = setupAdmissionReview(['src/a.js']);
    const r = await reviewPR({
      pr: { number: 41, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 'feat: a', user: { login: 'dev' }, body: '' },
      repository: REPO, octokit: oct,
    });
    expect(r).toBeTruthy();
    expect(countInputTokens).toHaveBeenCalledTimes(1);
    const counted = countInputTokens.mock.calls[0][0];
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.system).toBe(counted.system);
    expect(sent.messages[0].content).toBe(counted.userPrompt);
    expect(counted.model).toBe('claude-sonnet-4-20250514');
  });

  test('exactly 958,016 input tokens fits — whole PR, single count', async () => {
    countInputTokens.mockResolvedValueOnce(958016);
    const oct = setupAdmissionReview(['src/a.js']);
    const r = await reviewPR({ pr: { number: 42, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });
    expect(r).toBeTruthy();
    expect(countInputTokens).toHaveBeenCalledTimes(1);
    expect(r.coverage.approvalEvidenceComplete).toBe(true);
  });

  test('958,017 allocates deterministically: crossing + later files bundle_truncated', async () => {
    buildReviewBundle.mockResolvedValueOnce(admissionParts(['f0.js', 'f1.js', 'f2.js']));
    countInputTokens
      .mockResolvedValueOnce(958017)  // complete request — one token over the ceiling
      .mockResolvedValueOnce(1000)    // zero-evidence skeleton
      .mockResolvedValueOnce(400000)  // f0 — admitted
      .mockResolvedValueOnce(400000)  // f1 — admitted (157,016 remain)
      .mockResolvedValueOnce(400000)  // f2 — crossing: exceeds remaining
      .mockResolvedValueOnce(800500); // rebuilt final — verified under the ceiling
    const oct = setupAdmissionReview(['f0.js', 'f1.js', 'f2.js']);
    const r = await reviewPR({ pr: { number: 43, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });

    expect(r).toBeTruthy();
    // six counts: complete, skeleton, three section counts, final verification
    expect(countInputTokens).toHaveBeenCalledTimes(6);
    // the sent request is the REBUILT one: f0/f1 evidence present, f2's patch absent
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.messages[0].content).toContain('+patch-for-f0.js');
    expect(sent.messages[0].content).toContain('+patch-for-f1.js');
    expect(sent.messages[0].content).not.toContain('+patch-for-f2.js');
    expect(sent.messages[0].content).toContain('review input token budget reached');
    // coverage truthfully reports only f2 as incomplete
    const f2 = r.coverage.files.find((f) => f.path === 'f2.js');
    expect(f2.coverage).toBe('partial');
    expect(f2.reason).toBe('bundle_truncated');
    expect(r.coverage.approvalEvidenceComplete).toBe(false);
  });

  test('count failure fails the review visibly and never sends inference', async () => {
    const countErr = new Error('Token count failed (transport): boom');
    countErr.gitwireErrorCode = 'E_TOKEN_COUNT_FAILED';
    countErr.gitwireRejectionClass = 'transport';
    countInputTokens.mockRejectedValueOnce(countErr);
    const oct = setupAdmissionReview(['src/a.js']);
    await expect(reviewPR({
      pr: { number: 44, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' },
      repository: REPO, octokit: oct,
    })).rejects.toMatchObject({ gitwireErrorCode: 'E_TOKEN_COUNT_FAILED' });
    expect(mockCreate).not.toHaveBeenCalled();
    // the persisted error receipt names the retryable class so a repeated
    // BullMQ attempt can decide to re-run (worker retry lifecycle)
    const updateCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('terminal_reason = $2'));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1][1]).toBe('token_count_failed');
  });

  test('post-allocation enforcement failure refuses inference', async () => {
    // Both sections fit the per-section estimate, but the authoritative
    // final re-count exceeds the ceiling: the request must never be sent.
    buildReviewBundle.mockResolvedValueOnce(admissionParts(['f0.js', 'f1.js']));
    countInputTokens
      .mockResolvedValueOnce(958017)  // over ceiling
      .mockResolvedValueOnce(1000)    // skeleton
      .mockResolvedValueOnce(400000)  // f0 — admitted
      .mockResolvedValueOnce(400000)  // f1 — admitted
      .mockResolvedValueOnce(999999); // rebuilt final — still over: refuse
    const oct = setupAdmissionReview(['f0.js', 'f1.js']);
    await expect(reviewPR({
      pr: { number: 45, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' },
      repository: REPO, octokit: oct,
    })).rejects.toMatchObject({ gitwireErrorCode: 'E_INPUT_BUDGET_EXCEEDED' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(countInputTokens).toHaveBeenCalledTimes(5);
  });

  test('complete request over the counter limit (Infinity) still reaches allocation', async () => {
    buildReviewBundle.mockResolvedValueOnce(admissionParts(['f0.js', 'f1.js']));
    countInputTokens
      .mockResolvedValueOnce(Infinity)   // counter rejects the whole PR: definitely over
      .mockResolvedValueOnce(1000)       // zero-evidence skeleton
      .mockResolvedValueOnce(400000)     // f0 — admitted (557,016 remain)
      .mockResolvedValueOnce(600000)     // f1 — crossing: exceeds remaining
      .mockResolvedValueOnce(400500);    // rebuilt final — verified under the ceiling
    const oct = setupAdmissionReview(['f0.js', 'f1.js']);
    const r = await reviewPR({ pr: { number: 46, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });

    expect(r).toBeTruthy();
    expect(countInputTokens).toHaveBeenCalledTimes(5);
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.messages[0].content).toContain('+patch-for-f0.js');
    expect(sent.messages[0].content).not.toContain('+patch-for-f1.js');
    const f1 = r.coverage.files.find((f) => f.path === 'f1.js');
    expect(f1.coverage).toBe('partial');
    expect(f1.reason).toBe('bundle_truncated');
  });

  test('a single section over the counter limit is the crossing file', async () => {
    buildReviewBundle.mockResolvedValueOnce(admissionParts(['f0.js', 'f1.js', 'f2.js']));
    countInputTokens
      .mockResolvedValueOnce(Infinity)  // whole PR over the counter limit
      .mockResolvedValueOnce(1000)      // skeleton
      .mockResolvedValueOnce(500)       // f0 — admitted
      .mockResolvedValueOnce(Infinity)  // f1 — the counter cannot even count it: crossing
      .mockResolvedValueOnce(1600);     // rebuilt final — verified
    const oct = setupAdmissionReview(['f0.js', 'f1.js', 'f2.js']);
    const r = await reviewPR({ pr: { number: 47, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });

    expect(r).toBeTruthy();
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.messages[0].content).toContain('+patch-for-f0.js');
    expect(sent.messages[0].content).not.toContain('+patch-for-f1.js');
    expect(sent.messages[0].content).not.toContain('+patch-for-f2.js');
    for (const p of ['f1.js', 'f2.js']) {
      const rec = r.coverage.files.find((f) => f.path === p);
      expect(rec.coverage).toBe('partial');
      expect(rec.reason).toBe('bundle_truncated');
    }
  });

  test('admission and inference share one deadline — inference receives only the remainder', async () => {
    const oct = setupAdmissionReview(['src/a.js']);
    const t0 = Date.now();
    const r = await reviewPR({ pr: { number: 48, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });
    expect(r).toBeTruthy();
    const counted = countInputTokens.mock.calls[0][0];
    expect(counted.deadline).toBeGreaterThan(t0 + 595000);
    // deadline = now + maxDuration is captured after t0, so allow capture slack
    expect(counted.deadline).toBeLessThanOrEqual(t0 + 605000);
    expect(lastCreateRequestOptions).toBeTruthy();
    expect(lastCreateRequestOptions.timeout).toBeGreaterThan(0);
    expect(lastCreateRequestOptions.timeout).toBeLessThanOrEqual(600000);
    expect(lastCreateRequestOptions.maxRetries).toBe(0);
    const [, hbOpts] = withHeartbeat.mock.calls[0];
    expect(hbOpts.timeoutMs).toBeGreaterThan(0);
    expect(hbOpts.timeoutMs).toBeLessThanOrEqual(600000);
  });

  test('deadline expiration during token counting prevents inference (shared-deadline gate)', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, max_duration_seconds: 0.05, ignore_patterns: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockImplementation((sql) => (String(sql).includes('publication_claimed_at = NOW()') ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
    countInputTokens.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 80));   // outlives the 50 ms deadline
      return 1000;
    });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, patch: '+a' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });
    await expect(reviewPR({
      pr: { number: 49, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' },
      repository: REPO, octokit: oct,
    })).rejects.toMatchObject({ gitwireErrorCode: 'E_REVIEW_DEADLINE_EXCEEDED', gitwireRejectionClass: 'timeout' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('count-failure rejection class decides the persisted terminal reason', async () => {
    const cases = [
      ['timeout', 'token_count_failed'],
      ['transport', 'token_count_failed'],
      ['rate_limit', 'token_count_failed'],
      ['auth_entitlement', 'token_count_permanent'],
      ['quota', 'token_count_permanent'],
      ['other', 'token_count_permanent'],
    ];
    for (const [rejectionClass, expectedReason] of cases) {
      mockQuery.mockReset();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, check_security: true, check_architecture: true, ignore_patterns: [] }] })
        .mockResolvedValueOnce({ rows: [{ id: 100 }] })
        .mockImplementation((sql) => (String(sql).includes('publication_claimed_at = NOW()') ? { rows: [{ id: 100 }] } : Promise.resolve({ rows: [] })));
      const countErr = new Error('Token count failed (' + rejectionClass + '): simulated');
      countErr.gitwireErrorCode = 'E_TOKEN_COUNT_FAILED';
      countErr.gitwireRejectionClass = rejectionClass;
      countInputTokens.mockReset();
      countInputTokens.mockRejectedValueOnce(countErr);
      const oct = mockOctokit({
        'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, patch: '+a' }] },
        'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      });
      await expect(reviewPR({
        pr: { number: 50, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' },
        repository: REPO, octokit: oct,
      })).rejects.toMatchObject({ gitwireErrorCode: 'E_TOKEN_COUNT_FAILED' });
      const updateCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('terminal_reason = $2'));
      expect(updateCall).toBeTruthy();
      expect([rejectionClass, updateCall[1][1]]).toEqual([rejectionClass, expectedReason]);
    }
  });

  test('isRetryableReviewFailure re-enters reviewPR only for token_count_failed', async () => {
    const reasons = [
      ['token_count_failed', true],
      ['token_count_permanent', false],
      ['input_budget_exceeded', false],
      ['deadline_exceeded', false],
      ['error', false],
    ];
    for (const [reason, expected] of reasons) {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [{ terminal_reason: reason }] });
      await expect(isRetryableReviewFailure(1, 2, 'abc'))
        .resolves.toBe(expected);
    }
    // no persisted row at all — fail closed onto the marker semantics
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(isRetryableReviewFailure(1, 2, 'abc')).resolves.toBe(false);
  });
});
