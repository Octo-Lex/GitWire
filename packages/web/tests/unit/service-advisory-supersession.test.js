// tests/unit/service-advisory-supersession.test.js
// Frozen v1.2 WP-3: a review started at SHA A can never publish a
// current-looking conclusion after the PR moves to SHA B. Deterministic race:
// the mocked PR head changes between invocation start and the pre-publication
// guard. Zero review publications, terminal SUPERSEDED, both SHAs recorded.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params, calls) : h;
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        throw new Error('no pull handler in test: ' + route);
      }
      return { data: {} };
    },
    _calls: calls,
  };
}

await jest.unstable_mockModule('../../src/lib/db.js', () => ({
  db: { query: mockQuery },
}));

await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

await jest.unstable_mockModule('../../src/services/auditTrailService.js', () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));

await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));

const mockCreate = jest.fn();
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));

await jest.unstable_mockModule('../../config/index.js', () => ({
  config: {
    server: { env: 'test' },
    anthropic: { apiKey: 'test', baseURL: 'http://test' },
    ai: { model: 'test-model' },
  },
}));

await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({
    bundle: 'bundle-text', changedFiles: ['a.js'], totalChars: 10, coverageAdjustments: [],
  }),
}));

await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report) => ({
    valid: true,
    legacy: {
      findings: [],
      verdict: report.overall_correctness === 'patch is correct' ? 'approved' : 'needs_discussion',
      confidence: 'high',
      summary: '',
    },
    keptFindings: [], ignoredFindings: [], schemaErrors: [], scopeDroppedCount: 0,
  })),
}));

await jest.unstable_mockModule('../../src/services/reviewHeartbeat.js', () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));

await jest.unstable_mockModule('../../src/services/adversarialReview.js', () => ({
  runAdversarialChallenge: jest.fn(), refineFindings: jest.fn(),
}));
await jest.unstable_mockModule('../../src/services/adversarialDefense.js', () => ({
  runDefensePass: jest.fn(), refineWithDefense: jest.fn(),
}));

const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };
const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const CFG = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium',
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  adversarial_review: false,
};

const FILES = [
  { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's1' },
];

function cleanModel() {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({
      findings: [],
      overall_correctness: 'patch is correct',
      overall_explanation: 'Clean.',
      overall_confidence: 0.95,
    }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function pr() {
  return { number: 7, head: { sha: HEAD_A }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCreate.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [CFG] })
    .mockResolvedValueOnce({ rows: [{ id: 100 }] })
    .mockResolvedValue({ rows: [] });
});

describe('exact-head supersession guard', () => {
  test('head moved A→B during review: zero review publications, SUPERSEDED terminal, SHAs recorded', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: FILES },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: HEAD_B } } },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    // Zero state-bearing review publications
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews'))).toHaveLength(0);

    // Terminal state
    expect(r.superseded).toBe(true);
    expect(r.verdict).toBe('superseded');
    expect(r.reviewedHeadSha).toBe(HEAD_A);
    expect(r.currentHeadSha).toBe(HEAD_B);
    expect(r.publication.publicationAllowed).toBe(false);
    expect(r.publication.githubReviewEvent).toBeNull();
    expect(r.publication.integrityState).toBe('SUPERSEDED');

    // The review's own check terminalizes neutral with the supersession reason
    const patches = oct._calls.filter((c) => c.route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/'));
    const last = patches[patches.length - 1];
    expect(last.params.conclusion).toBe('neutral');
    expect(last.params.output.title).toContain('superseded');

    // old/new SHAs persisted in the receipt row
    const supersededUpdate = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes("verdict = 'superseded'")
    );
    expect(supersededUpdate).toBeTruthy();
    expect(supersededUpdate[1][0]).toContain(HEAD_A);
    expect(supersededUpdate[1][0]).toContain(HEAD_B);
  });

  test('head unchanged: review publishes normally', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: FILES },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: HEAD_A } } },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.superseded).toBeUndefined();
    expect(r.publication.publishedOutcome).toBe('APPROVE');
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews'))).toHaveLength(1);
  });

  test('head confirmation failure fails closed: no publication', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: FILES },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': () => { throw new Error('api outage'); },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });
    cleanModel();

    await expect(
      reviewPR({ pr: pr(), repository: REPO, octokit: oct })
    ).rejects.toThrow(/Head confirmation failed/);

    expect(oct._calls.filter((c) => c.route.endsWith('/reviews'))).toHaveLength(0);
    const patches = oct._calls.filter((c) => c.route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/'));
    const last = patches[patches.length - 1];
    expect(last.params.conclusion).toBe('neutral');
  });

  test('PR response with no head SHA also fails closed: no publication', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: FILES },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: {} },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });
    cleanModel();

    await expect(
      reviewPR({ pr: pr(), repository: REPO, octokit: oct })
    ).rejects.toThrow(/no head SHA/);

    expect(oct._calls.filter((c) => c.route.endsWith('/reviews'))).toHaveLength(0);
  });
});
