// Review delivery boundary (NodeChain P1 correction).
//
// Proves deterministically, with no LLM:
//   - inline comments are line/side anchored from the unified patch and
//     NEVER serialized as `position: <file line>` (the 422 defect shape);
//   - unanchorable findings degrade to body-only while the review itself
//     still posts;
//   - a GitHub review POST rejection (422) is a TERMINAL delivery failure:
//     verdict='error' receipt, FAILURE check, rethrown (worker fails), and
//     exactly ONE POST attempt — no automatic second mutation.

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params, calls) : h;
      return { data: {} };
    },
    _calls: calls,
  };
}

function reviewPostCalls(oct) {
  return oct._calls.filter((c) => c.route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews');
}
function checkPatchCalls(oct) {
  return oct._calls.filter((c) => c.route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}');
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
  config: { server: { env: 'test' }, anthropic: { apiKey: 'test', baseURL: 'http://test' }, ai: { model: 'test-model' } },
}));
await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: jest.fn().mockResolvedValue({
    bundle: "## PR Metadata\nTest PR\n## Changes\n```diff\n+hello\n```",
    changedFiles: ["src/app.js"],
    totalChars: 100,
  }),
}));
await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report) => {
    const findings = (report.findings || []).map(function (f) {
      return {
        category: f.category,
        severity: f.priority === "P0" ? "critical" : f.priority === "P1" ? "high" : "medium",
        title: f.title,
        description: f.body || "",
        suggestion: "",
        file: f.code_location?.file_path || null,
        line: f.code_location?.line || null,
        confidence: f.confidence,
      };
    });
    const isCorrect = report.overall_correctness === "patch is correct";
    return {
      valid: true,
      legacy: {
        findings,
        verdict: !isCorrect && findings.some((f) => f.severity === "critical") ? "request_changes" : "approved",
        confidence: "high",
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
await jest.unstable_mockModule('../../src/services/reviewHeartbeat.js', () => ({
  withHeartbeat: jest.fn().mockImplementation(async (fn) => fn()),
}));
await jest.unstable_mockModule('../../src/services/adversarialReview.js', () => ({
  runAdversarialChallenge: jest.fn(),
  refineFindings: jest.fn(),
}));

const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'octo/repo', owner: { login: 'octo' }, name: 'repo' };

const CONFIG_ROW = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium',
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
};

function findingReport(line) {
  return {
    findings: [{
      title: "finding at line " + line,
      body: "description",
      priority: "P0",
      confidence: 0.95,
      category: "security",
      code_location: { file_path: "src/app.js", line },
    }],
    overall_correctness: "patch is incorrect",
    overall_explanation: "has a finding",
    overall_confidence: 0.9,
  };
}

const SMALL_PATCH = [
  '@@ -1,3 +1,3 @@',
  ' context one',
  '-old two',
  '+new two',
  ' context three',
].join('\n');

describe('review delivery boundary', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCreate.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  test('valid anchor: comment carries {path, line, side:RIGHT} and NEVER a position', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] }).mockResolvedValueOnce({ rows: [{ id: 200 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(findingReport(2)) }], usage: { input_tokens: 10, output_tokens: 5 } });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'abc' } } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/app.js', status: 'modified', additions: 2, deletions: 1, patch: SMALL_PATCH }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 300 } },
    });

    const r = await reviewPR({ pr: { number: 5, head: { sha: 'abc' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });
    expect(r.verdict).toBe('request_changes');
    const posts = reviewPostCalls(oct);
    expect(posts).toHaveLength(1);
    expect(posts[0].params.commit_id).toBe('abc');
    expect(posts[0].params.comments).toEqual([
      expect.objectContaining({ path: 'src/app.js', line: 2, side: 'RIGHT' }),
    ]);
    expect(posts[0].params.comments[0]).not.toHaveProperty('position');
  });

  test('THE DEFECT SHAPE: file line 800 against a 3-line patch → body-only, review still posts and succeeds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] }).mockResolvedValueOnce({ rows: [{ id: 201 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(findingReport(800)) }], usage: { input_tokens: 10, output_tokens: 5 } });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 11 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'def' } } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/app.js', status: 'modified', additions: 2, deletions: 1, patch: SMALL_PATCH }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 301 } },
    });

    const r = await reviewPR({ pr: { number: 6, head: { sha: 'def' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });
    expect(r.verdict).toBe('request_changes');
    const posts = reviewPostCalls(oct);
    expect(posts).toHaveLength(1);
    expect(posts[0].params.comments).toEqual([]);
    // The finding itself is NOT dropped — it stays in the review body.
    expect(posts[0].params.body).toContain('finding at line 800');
    expect(checkPatchCalls(oct).at(-1).params.conclusion).toBe('failure'); // request_changes blocks
  });

  test('422 on the review POST is a TERMINAL delivery failure — error receipt, FAILURE check, rethrow, ONE POST', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] }).mockResolvedValueOnce({ rows: [{ id: 202 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(findingReport(2)) }], usage: { input_tokens: 10, output_tokens: 5 } });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 12 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: 'ghi' } } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/app.js', status: 'modified', additions: 2, deletions: 1, patch: SMALL_PATCH }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': () => {
        const err = new Error('422 Position could not be resolved');
        err.status = 422;
        throw err;
      },
    });

    await expect(
      reviewPR({ pr: { number: 7, head: { sha: 'ghi' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct })
    ).rejects.toMatchObject({ gitwireErrorCode: 'E_REVIEW_DELIVERY' });

    // Exactly ONE review POST — no automatic second mutation attempt.
    expect(reviewPostCalls(oct)).toHaveLength(1);

    // The check terminalizes as FAILURE with a truthful delivery title.
    const patches = checkPatchCalls(oct);
    expect(patches.at(-1).params.conclusion).toBe('failure');
    expect(patches.at(-1).params.output.title).toContain('delivery failed');

    // The error receipt was persisted (verdict='error' + delivery summary).
    const errorUpdate = mockQuery.mock.calls.find((c) => String(c[0]).includes("verdict = 'error'"));
    expect(errorUpdate).toBeTruthy();
    expect(errorUpdate[1][0]).toContain('GitHub review delivery failed');
  });

  test('non-delivery failures keep the pre-existing behavior (neutral + null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONFIG_ROW] }).mockResolvedValueOnce({ rows: [{ id: 203 }] }).mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'narration, no JSON' }], usage: { input_tokens: 10, output_tokens: 5 } });

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 13 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'x.js', status: 'modified', additions: 1, deletions: 0, patch: '+x' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    });

    const r = await reviewPR({ pr: { number: 8, head: { sha: 'jkl' }, title: 't', user: { login: 'dev' }, body: '' }, repository: REPO, octokit: oct });
    expect(r).toBeNull();
    expect(reviewPostCalls(oct)).toHaveLength(0);
  });
});
