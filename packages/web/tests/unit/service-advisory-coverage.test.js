// tests/unit/service-advisory-coverage.test.js
// Advisory contract integration through reviewPR: paginated file acquisition,
// coverage-derived integrity, and INCOMPLETE publication when evidence is
// incomplete. Mocks mirror service-ai-review.test.js; the publication-policy
// and coverage modules under test are real.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params) : h;
      // Supersession guard re-reads the PR head before publication; default
      // to an unchanged head (all PRs in this suite run at 'abc123') unless a
      // test overrides the route.
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { head: { sha: 'abc123' } } };
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

// The bundle is mocked to isolate acquisition/coverage; truncation adjustments
// are covered by reviewBundleCoverage.test.js against the real service.
const mockBundle = jest.fn();
await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: mockBundle,
}));

await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report) => {
    const findings = (report.findings || []).map((f) => ({
      category: f.category,
      severity: f.priority === 'P0' ? 'critical' : f.priority === 'P1' ? 'high' : f.priority === 'P2' ? 'medium' : 'low',
      title: f.title,
      description: f.body || '',
      suggestion: '',
      file: f.code_location?.file_path || null,
      line: f.code_location?.line || null,
      confidence: f.confidence,
    }));
    const isCorrect = report.overall_correctness === 'patch is correct';
    let verdict = 'approved';
    if (!isCorrect && findings.some((f) => f.severity === 'critical')) verdict = 'request_changes';
    else if (!isCorrect) verdict = 'needs_discussion';
    return {
      valid: true,
      legacy: {
        findings, verdict,
        confidence: report.overall_confidence >= 0.8 ? 'high' : 'medium',
        summary: report.overall_explanation || '',
      },
      keptFindings: findings, ignoredFindings: [], schemaErrors: [], scopeDroppedCount: 0,
    };
  }),
}));

await jest.unstable_mockModule('../../src/services/reviewHeartbeat.js', () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));

await jest.unstable_mockModule('../../src/services/adversarialReview.js', () => ({
  runAdversarialChallenge: jest.fn(),
  refineFindings: jest.fn(),
}));

await jest.unstable_mockModule('../../src/services/adversarialDefense.js', () => ({
  runDefensePass: jest.fn(),
  refineWithDefense: jest.fn(),
}));

const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };

const CFG = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium',
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  adversarial_review: false,
};

function cleanReport() {
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

function pr(n = 5) {
  return { number: n, head: { sha: 'abc123' }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' };
}

function defaultBundle() {
  mockBundle.mockResolvedValue({
    bundle: 'bundle-text',
    changedFiles: ['src/a.js'],
    totalChars: 100,
    coverageAdjustments: [],
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCreate.mockReset();
  mockBundle.mockReset();
  defaultBundle();
  mockQuery
    .mockResolvedValueOnce({ rows: [CFG] })
    .mockResolvedValueOnce({ rows: [{ id: 100 }] })
    .mockResolvedValue({ rows: [] });
});

describe('advisory coverage — pagination and accounting', () => {
  test('all changed-file pages are fetched and every file accounted (>100 files)', async () => {
    const page1 = [], page2 = [];
    for (let i = 0; i < 100; i++) page1.push({ filename: 'f' + i + '.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's' + i });
    for (let i = 100; i < 150; i++) page2.push({ filename: 'f' + i + '.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's' + i });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': (params) =>
        params.page === 1 ? { data: page1 } : { data: page2 },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.coverage.totalChangedFiles).toBe(150);
    expect(r.coverage.accountedFiles).toBe(150);
    expect(r.coverage.approvalEvidenceComplete).toBe(false); // 30-file budget → 120 partial
    expect(r.coverage.limitsExceeded).toContain('max_files_to_review');

    // both pages requested
    const fileCalls = oct._calls.filter((c) => c.route.endsWith('/files'));
    expect(fileCalls.length).toBe(2);
    expect(fileCalls[1].params.page).toBe(2);
  });

  test('single page stops paginating (fewer than 100 files)', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's1' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.coverage.totalChangedFiles).toBe(1);
    expect(r.coverage.approvalEvidenceComplete).toBe(true);
    expect(r.publication.publishedOutcome).toBe('APPROVE');
    expect(oct._calls.filter((c) => c.route.endsWith('/files')).length).toBe(1);
  });
});

describe('advisory coverage — INCOMPLETE publication', () => {
  test('clean model approve with file-budget overflow publishes INCOMPLETE, never a clean approve', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) files.push({ filename: 'f' + i + '.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's' + i });
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...CFG, max_files_to_review: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockResolvedValue({ rows: [] });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: files },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.publication.judgment).toBe('APPROVE');
    expect(r.publication.publishedOutcome).toBe('INCOMPLETE');
    expect(r.publication.githubReviewEvent).toBe('COMMENT');
    expect(r.blocked).toBe(false);

    const reviewPost = oct._calls.find((c) => c.route.endsWith('/reviews'));
    expect(reviewPost.params.event).toBe('COMMENT');
    expect(reviewPost.params.body).toContain('INCOMPLETE');
    expect(reviewPost.params.body).toContain('no clean approval was issued');

    const checkPatch = oct._calls.filter((c) => c.route.includes('/check-runs/') && c.route.startsWith('PATCH'));
    const final = checkPatch[checkPatch.length - 1];
    expect(final.params.conclusion).toBe('success');
    expect(final.params.output.summary).toContain('Evidence incomplete');
  });

  test('binary-only evidence gap publishes INCOMPLETE even with an otherwise clean approve', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's1' },
        { filename: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: null, sha: 's2' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.publication.publishedOutcome).toBe('INCOMPLETE');
    expect(r.coverage.files.find((f) => f.path === 'logo.png').coverage).toBe('unavailable');
  });

  test('bundle truncation adjustments flow into integrity', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's1' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    mockBundle.mockResolvedValue({
      bundle: 'bundle-text',
      changedFiles: ['a.js'],
      totalChars: 100,
      coverageAdjustments: [{ path: 'a.js', coverage: 'partial', reason: 'bundle_truncated' }],
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.coverage.approvalEvidenceComplete).toBe(false);
    expect(r.publication.publishedOutcome).toBe('INCOMPLETE');
  });

  test('removed file reaches the review bundle (no silent drop)', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'auth.js', status: 'removed', additions: 0, deletions: 40, patch: '-checkAuth()', sha: 's1' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    cleanReport();
    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(mockBundle).toHaveBeenCalled();
    const bundleArg = mockBundle.mock.calls[0][0];
    expect(bundleArg.files.map((f) => f.filename)).toEqual(['auth.js']);
    expect(r.coverage.files[0]).toMatchObject({ path: 'auth.js', status: 'removed', coverage: 'full' });
    expect(r.publication.publishedOutcome).toBe('APPROVE');
  });

  test('all files ignore-excluded keeps the legacy no-reviewable-files success exit', async () => {    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...CFG, ignore_patterns: ['**'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockResolvedValue({ rows: [] });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '+x', sha: 's1' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });
    expect(r).toBeNull();
    const checkPatch = oct._calls.filter((c) => c.route.includes('/check-runs/') && c.route.startsWith('PATCH'));
    expect(checkPatch[checkPatch.length - 1].params.conclusion).toBe('success');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('advisory evidence — blocking eligibility is separate from visibility', () => {
  test('request_changes with an out-of-patch material finding: published, visible, NOT blocking', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'src/app.js', status: 'modified', additions: 2, deletions: 1,
          patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new\n context' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    // P0 finding whose line (800) is NOT inside the acquired patch
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        findings: [{
          title: 'claimed defect', body: 'claims a line the patch never showed',
          priority: 'P0', confidence: 0.9, category: 'security',
          code_location: { file_path: 'src/app.js', line: 800 },
        }],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'defect',
        overall_confidence: 0.9,
      }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    // Visible: the finding is published (REQUEST_CHANGES survives)
    expect(r.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    const reviewPost = oct._calls.find((c) => c.route.endsWith('/reviews'));
    expect(reviewPost.params.body).toContain('claimed defect');
    expect(reviewPost.params.body).toContain('unverified');

    // But NOT blocking: evidence invalid despite the configured blocking policy
    expect(r.evidence.materialEvidenceValid).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.publication.authorityState).toBe('ADVISORY');

    const checkPatch = oct._calls.filter((c) => c.route.includes('/check-runs/') && c.route.startsWith('PATCH'));
    expect(checkPatch[checkPatch.length - 1].params.conclusion).toBe('success');
  });

  test('request_changes with in-patch evidence still blocks under configured policy', async () => {
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [
        { filename: 'src/app.js', status: 'modified', additions: 2, deletions: 1,
          patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new\n context' },
      ] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        findings: [{
          title: 'real defect', body: 'on a represented line',
          priority: 'P0', confidence: 0.9, category: 'security',
          code_location: { file_path: 'src/app.js', line: 2 },
        }],
        overall_correctness: 'patch is incorrect',
        overall_explanation: 'defect',
        overall_confidence: 0.9,
      }) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.evidence.materialEvidenceValid).toBe(true);
    expect(r.blocked).toBe(true);
    expect(r.publication.authorityState).toBe('POLICY_BLOCKED');
    const checkPatch = oct._calls.filter((c) => c.route.includes('/check-runs/') && c.route.startsWith('PATCH'));
    expect(checkPatch[checkPatch.length - 1].params.conclusion).toBe('failure');
  });
});
