// tests/unit/service-advisory-publication.test.js
// Frozen v1.2 WP-5: durable receipt + recoverably exactly-once publication.
//
// The ambiguous window under test: the GitHub review POST succeeded, then the
// process died before github_review_id was persisted (publication_state still
// 'submitting'). Recovery runs BEFORE any model work or repost, by searching
// the PR's reviews for the exact deterministic marker.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params) : h;
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

await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({
    bundle: 'b', changedFiles: ['a.js'], totalChars: 1, coverageAdjustments: [],
  }),
}));

await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report) => ({
    valid: true,
    legacy: {
      findings: [],
      verdict: report.overall_correctness === 'patch is correct' ? 'approved' : 'needs_discussion',
      confidence: 'high', summary: '',
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

const { reviewPR, buildPublicationMarker } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };
const HEAD = 'abc123';
const MARKER = 'gitwire-pub:100:1:5:' + HEAD;

const CFG = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium',
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  adversarial_review: false,
};

const FILES = [
  { filename: 'a.js', status: 'modified', additions: 5, deletions: 0, patch: '@@ -1,2 +1,2 @@\n ctx\n+a', sha: 's1' },
];

function pr() {
  return { number: 5, head: { sha: HEAD }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' };
}

function cleanModel() {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({
      findings: [], overall_correctness: 'patch is correct',
      overall_explanation: 'Clean.', overall_confidence: 0.95,
    }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function baseOct(extra = {}) {
  return mockOctokit({
    'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: FILES },
    'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    ...extra,
  });
}

function freshDb(insertRow = { id: 100 }) {
  mockQuery.mockReset();
  mockCreate.mockReset();
  mockQuery
    .mockResolvedValueOnce({ rows: [CFG] })
    .mockResolvedValueOnce({ rows: [insertRow] })
    // Default: the atomic publication claim wins, and a stale-claim release
    // succeeds. Individual tests override via the Once queue.
    .mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes("publication_claimed_at = NOW()")) return Promise.resolve({ rows: [{ id: 100 }] });
      if (s.includes("INTERVAL '10 minutes'")) return Promise.resolve({ rows: [{ id: 100 }] });
      return Promise.resolve({ rows: [] });
    });
}

describe('buildPublicationMarker', () => {
  test('deterministic for stable review identity', () => {
    expect(buildPublicationMarker(100, 1, 5, HEAD)).toBe(MARKER);
    expect(buildPublicationMarker(100, 1, 5, HEAD)).toBe(buildPublicationMarker(100, 1, 5, HEAD));
    expect(buildPublicationMarker(101, 1, 5, HEAD)).not.toBe(MARKER);
  });
});

describe('exactly-once publication — happy path', () => {
  test('receipt persisted before POST; marker embedded in body; state reaches published', async () => {
    freshDb();
    const oct = baseOct();
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    // Receipt and claim land atomically BEFORE the GitHub POST
    const claimCall = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes("publication_claimed_at = NOW()")
    );
    expect(claimCall).toBeTruthy();
    expect(claimCall[0]).toContain("AND (publication_state IS NULL OR publication_state = 'computed')");

    // Marker embedded invisibly in the published body
    const postIdx = oct._calls.findIndex((c) => c.route.endsWith('/reviews'));
    const post = oct._calls[postIdx];
    expect(post.params.body).toContain('<!-- ' + MARKER + ' -->');

    // Final persist terminalizes published
    const finalUpdate = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes("terminal_reason = CASE WHEN $9::bigint IS NOT NULL THEN 'completed'")
    );
    expect(finalUpdate).toBeTruthy();

    expect(r.publication.publishedOutcome).toBe('APPROVE');
  });
});

describe('exactly-once publication — crash recovery', () => {
  function crashedRow() {
    return {
      id: 100, publication_state: 'submitting', github_review_id: null,
      verdict: 'request_changes', published_outcome: 'REQUEST_CHANGES',
      judgment: 'REQUEST_CHANGES', integrity_state: 'COMPLETE', policy_blocked: true,
    };
  }

  test('crash after POST before persist: exactly one marker match adopts the review — no repost, no model', async () => {
    freshDb(crashedRow());
    const oct = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: [
        { id: 555, body: 'older review, no marker' },
        { id: 556, body: 'review body\n<!-- ' + MARKER + ' -->\nfooter' },
      ] },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.recovered).toBe(true);
    expect(r.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(r.blocked).toBe(true);

    // Exactly one logical publication across both attempts: no POST, no model
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();

    // Adoption persisted
    const adopt = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes("terminal_reason = 'recovered_after_crash'")
    );
    expect(adopt).toBeTruthy();
    expect(adopt[1]).toEqual([556, 100]);
  });

  test('zero marker matches: the POST never landed — one fresh POST is allowed', async () => {
    freshDb(crashedRow());
    const oct = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: [
        { id: 555, body: 'older review, no marker' },
      ] },
    });
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.recovered).toBeUndefined();
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('multiple marker matches: terminal ambiguous failure, no repost', async () => {
    freshDb(crashedRow());
    const oct = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: [
        { id: 556, body: '<!-- ' + MARKER + ' -->' },
        { id: 557, body: '<!-- ' + MARKER + ' -->' },
      ] },
    });

    await expect(
      reviewPR({ pr: pr(), repository: REPO, octokit: oct })
    ).rejects.toMatchObject({ gitwireErrorCode: 'E_AMBIGUOUS_PUBLICATION' });

    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
    const failUpdate = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes("terminal_reason = 'ambiguous_publication'")
    );
    expect(failUpdate).toBeTruthy();
    const patches = oct._calls.filter((c) => c.route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/'));
    expect(patches.at(-1).params.conclusion).toBe('failure');
  });

  test('recovery lookup failure: fail closed, no repost', async () => {
    freshDb(crashedRow());
    const oct = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': () => { throw new Error('list reviews 502'); },
    });

    await expect(
      reviewPR({ pr: pr(), repository: REPO, octokit: oct })
    ).rejects.toMatchObject({ gitwireErrorCode: 'E_PUBLICATION_LOOKUP' });

    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('already-published row returns its stored outcome without recompute', async () => {
    freshDb({
      id: 100, publication_state: 'published', github_review_id: 777,
      verdict: 'approved', published_outcome: 'APPROVE',
      judgment: 'APPROVE', integrity_state: 'COMPLETE', policy_blocked: false,
    });
    const oct = baseOct();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.recovered).toBe(true);
    expect(r.verdict).toBe('approved');
    expect(r.publication.publishedOutcome).toBe('APPROVE');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
  });
});

describe('exactly-once publication — concurrent ownership (criterion 13)', () => {
  test('claim lost to a live submitting owner: suppress, never a second POST', async () => {
    freshDb();
    // claim (3rd db call) returns no row; loser re-read (4th) sees a live owner
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                                          // claim loses
      .mockResolvedValueOnce({ rows: [{ publication_state: 'submitting' }] });      // loser re-read

    const oct = baseOct();
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.suppressedPublication).toBe(true);
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
    const suppress = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes("terminal_reason = 'publication_suppressed_concurrent'")
    );
    expect(suppress).toBeTruthy();
    const patches = oct._calls.filter((c) => c.route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/'));
    expect(patches.at(-1).params.conclusion).toBe('neutral');
  });

  test('claim lost to a published row: adopt the stored publication', async () => {
    freshDb();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        publication_state: 'published', github_review_id: 556,
        verdict: 'request_changes', published_outcome: 'REQUEST_CHANGES',
        judgment: 'REQUEST_CHANGES', integrity_state: 'COMPLETE', policy_blocked: true,
      }] });

    const oct = baseOct();
    cleanModel();

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.recovered).toBe(true);
    expect(r.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(r.blocked).toBe(true);
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
  });

  test('claim lost to an unknown state: fail closed', async () => {
    freshDb();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ publication_state: 'nonsense' }] });

    const oct = baseOct();
    cleanModel();

    await expect(
      reviewPR({ pr: pr(), repository: REPO, octokit: oct })
    ).rejects.toMatchObject({ gitwireErrorCode: 'E_PUBLICATION_STATE' });

    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
  });

  test('live owner between claim and POST cannot be released by a 0-match search', async () => {
    // Crashed-style submitting row whose claim is RECENT: the marker search
    // finds nothing (the owner has not POSTed yet), but the stale-release
    // guard refuses — no second concurrent publication.
    freshDb({ id: 100, publication_state: 'submitting', github_review_id: null });
    // 3rd db call is the stale-release UPDATE; make it lose the guard
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const oct = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: [
        { id: 555, body: 'no marker here' },
      ] },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });

    expect(r.suppressedPublication).toBe(true);
    expect(oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'))).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('ADVISOR SPEC: two invocations, same repo/PR/SHA, both reach the boundary — exactly ONE GitHub review POST', async () => {
    // Worker A: fresh row, wins the claim, posts once.
    freshDb();
    const octA = baseOct();
    cleanModel();
    const resultA = await reviewPR({ pr: pr(), repository: REPO, octokit: octA });

    expect(resultA.publication.publishedOutcome).toBe('APPROVE');

    // Worker B (concurrent at the boundary): same row now claimed by A.
    // Its recovery sees 'submitting', the marker search finds nothing yet
    // (A is between claim and POST), and the stale-release guard refuses.
    freshDb({ id: 100, publication_state: 'submitting', github_review_id: null });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // stale-release loses to A's live claim
    const octB = baseOct({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: [] },
    });

    const resultB = await reviewPR({ pr: pr(), repository: REPO, octokit: octB });

    expect(resultB.suppressedPublication).toBe(true);

    const totalPosts =
      octA._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST')).length +
      octB._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST')).length;
    expect(totalPosts).toBe(1);
  });
});
