// tests/unit/reviewSupersession.test.js
// FR-02 regressions: published-review supersession on PR synchronize.
//
// Proves, with no LLM and no provider:
//   1. published review for an older head + moved authoritative head →
//      exactly one supersession notice posted, DB row marked SUPERSEDED,
//      check-run title patched;
//   2. authoritative head equal to the published SHA → no-op;
//   3. repeated delivery (marker already present) → idempotent, no second
//      notice, DB state guarded;
//   4. no published review → no-op;
//   5. an out-of-order synchronize (event payload carries an older head)
//      cannot downgrade a publication that already matches the
//      authoritative head — the comparison uses the API head, never the
//      event payload.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(routes = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = routes[route];
      if (h) return typeof h === 'function' ? h(params, calls) : h;
      return { data: {} };
    },
    _calls: calls,
  };
}

await jest.unstable_mockModule('../../src/lib/db.js', () => ({
  db: { query: mockQuery },
}));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
await jest.unstable_mockModule('../../src/services/auditTrailService.js', () => ({
  Trail: { appendEntry: jest.fn(), aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn(), ciRunCompleted: jest.fn() },
}));
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: jest.fn() }; } },
}));
await jest.unstable_mockModule('../../config/index.js', () => ({
  config: { server: { env: 'test' }, anthropic: { apiKey: 'test', baseURL: 'http://test' }, ai: { model: 'test-model' } },
}));

const { supersedePublishedReviewForPr } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 42, full_name: 'octo/repo', owner: { login: 'octo' }, name: 'repo' };
const PR = { number: 7 };
const HEAD_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function publishedRow(overrides = {}) {
  return {
    id: 924,
    commit_sha: HEAD_A,
    github_review_id: 5202609228,
    check_run_id: 77,
    integrity_state: 'COMPLETE',
    ...overrides,
  };
}

function octFor({ head, reviews = [] }) {
  return mockOctokit({
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: head } } },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: reviews },
    'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 999 } },
    'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
  });
}

function reviewPosts(oct) {
  return oct._calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews');
}
function checkPatches(oct) {
  return oct._calls.filter((c) => c.route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}');
}
function updateCalls() {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE ai_reviews'));
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe('FR-02 — published review supersession on synchronize', () => {
  test('older published head + moved authoritative head → superseded with exactly one notice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publishedRow()] });          // SELECT latest published
    const oct = octFor({ head: HEAD_B });                                 // authoritative head moved
    mockQuery.mockResolvedValue({ rows: [] });                            // UPDATE (guarded)

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('superseded');
    expect(r.from).toBe(HEAD_A);
    expect(r.to).toBe(HEAD_B);

    const posts = reviewPosts(oct);
    expect(posts).toHaveLength(1);
    expect(posts[0].params.event).toBe('COMMENT');
    expect(posts[0].params.body).toContain('superseded');
    expect(posts[0].params.body).toContain('gitwire-pub-superseded:924:42:7:' + HEAD_A);

    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toContain("integrity_state = 'SUPERSEDED'");
    expect(String(updates[0][0])).toContain("terminal_reason = 'head_superseded_post_publication'");

    const patches = checkPatches(oct);
    expect(patches).toHaveLength(1);
    expect(patches[0].params.output.title).toContain('superseded');
  });

  test('authoritative head equals published SHA → no-op, nothing posted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publishedRow()] });
    const oct = octFor({ head: HEAD_A });

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('head_matches_publication');
    expect(reviewPosts(oct)).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
  });

  test('repeated delivery (marker already present) → idempotent catch-up, no duplicate notice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publishedRow()] });
    const noticeBody = '<!-- gitwire-pub-superseded:924:42:7:' + HEAD_A + ' -->';
    const oct = octFor({
      head: HEAD_B,
      reviews: [{ id: 990, body: '## superseded…\n' + noticeBody }],
    });
    mockQuery.mockResolvedValue({ rows: [] });

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('notice_already_present');
    expect(reviewPosts(oct)).toHaveLength(0);
    // DB catch-up still runs, guarded against re-mutation.
    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toContain("integrity_state <> 'SUPERSEDED'");
  });

  test('already-superseded row → no-op before any GitHub call', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publishedRow({ integrity_state: 'SUPERSEDED' })] });
    const oct = octFor({ head: HEAD_B });

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('already_superseded');
    expect(oct._calls).toHaveLength(0);
  });

  test('no published review → no-op', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const oct = octFor({ head: HEAD_B });

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('no_published_review');
    expect(oct._calls).toHaveLength(0);
  });

  test('out-of-order synchronize cannot downgrade a publication matching the authoritative head', async () => {
    // The event payload below claims head A (stale delivery), but the
    // authoritative API head is HEAD_B and the LATEST published review is
    // already for HEAD_B. The function must compare API head vs publication
    // — not the payload — and no-op.
    mockQuery.mockResolvedValueOnce({
      rows: [publishedRow({ id: 930, commit_sha: HEAD_B, github_review_id: 530, check_run_id: 78 })],
    });
    const oct = octFor({ head: HEAD_B });
    const stalePayloadPr = { number: 7, head: { sha: HEAD_A } }; // event's stale view

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: stalePayloadPr });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('head_matches_publication');
    expect(reviewPosts(oct)).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
  });

  test('notice lookup failure → fail closed, defers to next delivery', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [publishedRow()] });
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: HEAD_B } } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': () => { throw new Error('pag cap'); },
    });

    const r = await supersedePublishedReviewForPr({ octokit: oct, repository: REPO, pr: PR });

    expect(r.action).toBe('noop');
    expect(r.reason).toBe('notice_lookup_failed');
    expect(reviewPosts(oct)).toHaveLength(0);
    expect(updateCalls()).toHaveLength(0);
  });
});
