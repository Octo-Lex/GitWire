// tests/unit/advisoryApprovalMatrix.test.js
// The frozen v1.2 deterministic transaction matrix (WP-7). Every case runs
// end-to-end through reviewPR with a scripted model response and a mocked
// octokit — zero paid provider calls. Case numbers are the frozen plan's.
//
// Mechanism-level proofs live beside their modules:
//   policy table      reviewPublicationPolicy.test.js
//   coverage          reviewCoverageService.test.js, reviewBundleCoverage.test.js
//   evidence          reviewEvidenceService.test.js
//   supersession      service-advisory-supersession.test.js
//   recovery          service-advisory-publication.test.js

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
const mockBundle = jest.fn();
await jest.unstable_mockModule('../../src/services/reviewBundleService.js', () => ({
  buildReviewBundle: mockBundle,
}));
await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn().mockImplementation((report) => {
    const findings = (report.findings || []).map((f) => ({
      category: f.category,
      severity: f.priority === 'P0' ? 'critical' : f.priority === 'P1' ? 'high' : f.priority === 'P2' ? 'medium' : 'low',
      title: f.title, description: f.body || '', suggestion: '',
      file: f.code_location?.file_path ?? null, line: f.code_location?.line ?? null,
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
  runAdversarialChallenge: jest.fn(), refineFindings: jest.fn(),
}));
await jest.unstable_mockModule('../../src/services/adversarialDefense.js', () => ({
  runDefensePass: jest.fn(), refineWithDefense: jest.fn(),
}));

const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };
const HEAD = 'abc123';
const OTHER_HEAD = 'bbbbbbbbbbbbbbbb';

const BASE_CFG = {
  id: 1, enabled: true, check_security: true, check_architecture: true,
  block_on_verdict: ['request_changes'], min_confidence_to_block: 'medium',
  max_files_to_review: 30, max_lines_to_review: 2000, ignore_patterns: [],
  adversarial_review: false,
};

const GOOD_PATCH = '@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n ctx';
const DELETION_PATCH = '@@ -10,2 +9,0 @@\n-checkAuth()\n-validate()';

function file(name, opts = {}) {
  return {
    filename: name, status: opts.status ?? 'modified',
    additions: opts.additions ?? 3, deletions: opts.deletions ?? 1,
    patch: opts.patch === undefined ? GOOD_PATCH : opts.patch,
    sha: 's',
  };
}

function report({ correct = true, findings = [] } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      findings,
      overall_correctness: correct ? 'patch is correct' : 'patch is incorrect',
      overall_explanation: correct ? 'clean' : 'has findings',
      overall_confidence: 0.9,
    }) }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function finding({ priority = 'P0', file = 'a.js', line = 2, title = 'defect' } = {}) {
  return { title, body: 'body of ' + title, priority, confidence: 0.9, category: 'security',
    code_location: { file_path: file, line } };
}

function pr() {
  return { number: 5, head: { sha: HEAD }, base: { ref: 'main' }, title: 't', user: { login: 'dev' }, body: '' };
}

async function runMatrixCase({
  cfg = BASE_CFG,
  files = [file('a.js')],
  model = () => report({ correct: true }),
  pullHead = HEAD,
  existingReviews = null,
  insertRow = { id: 100 },
  postReviews = { data: { id: 200 } },
  bundle = null,
} = {}) {
  mockQuery.mockReset();
  mockCreate.mockReset();
  mockBundle.mockReset();
  mockBundle.mockResolvedValue(bundle ?? {
    bundle: 'b', changedFiles: files.map((f) => f.filename), totalChars: 1, coverageAdjustments: [],
  });
  mockQuery
    .mockResolvedValueOnce({ rows: [cfg] })
    .mockResolvedValueOnce({ rows: [insertRow] })
    .mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes("publication_claimed_at = NOW()")) return Promise.resolve({ rows: [{ id: 100 }] });
      if (s.includes("INTERVAL '10 minutes'")) return Promise.resolve({ rows: [{ id: 100 }] });
      return Promise.resolve({ rows: [] });
    });
  mockCreate.mockImplementationOnce(model);

  const responses = {
    'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: files },
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: pullHead } } },
    'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
    'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': postReviews,
  };
  if (existingReviews) {
    responses['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews'] = existingReviews;
  }

  const oct = mockOctokit(responses);
  let result = null;
  let error = null;
  try {
    result = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });
  } catch (e) {
    error = e;
  }
  return { result, error, oct };
}

const posts = (oct) => oct._calls.filter((c) => c.route.endsWith('/reviews') && c.route.startsWith('POST'));
const finalCheck = (oct) => {
  const patches = oct._calls.filter((c) => c.route.startsWith('PATCH /repos/{owner}/{repo}/check-runs/'));
  return patches.at(-1)?.params;
};

describe('frozen v1.2 deterministic matrix', () => {
  test('1. APPROVE + COMPLETE → APPROVE / ADVISORY / COMMENT', async () => {
    const { result, oct } = await runMatrixCase();
    expect(result.publication.publishedOutcome).toBe('APPROVE');
    expect(result.publication.authorityState).toBe('ADVISORY');
    expect(posts(oct)).toHaveLength(1);
    expect(posts(oct)[0].params.event).toBe('COMMENT');
    expect(finalCheck(oct).conclusion).toBe('success');
  });

  test('2. NEEDS_DISCUSSION + COMPLETE → NEEDS_DISCUSSION / ADVISORY / COMMENT', async () => {
    const { result, oct } = await runMatrixCase({
      model: () => report({ correct: false, findings: [finding({ priority: 'P1' })] }),
    });
    expect(result.publication.judgment).toBe('NEEDS_DISCUSSION');
    expect(result.publication.publishedOutcome).toBe('NEEDS_DISCUSSION');
    expect(result.publication.authorityState).toBe('ADVISORY');
    expect(posts(oct)[0].params.event).toBe('COMMENT');
  });

  test('3. REQUEST_CHANGES + COMPLETE + valid material evidence → policy evaluation / COMMENT', async () => {
    const { result, oct } = await runMatrixCase({
      model: () => report({ correct: false, findings: [finding()] }),
    });
    expect(result.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(result.publication.authorityState).toBe('POLICY_BLOCKED');
    expect(result.blocked).toBe(true);
    expect(posts(oct)[0].params.event).toBe('COMMENT');
    expect(finalCheck(oct).conclusion).toBe('failure');
  });

  test('4. APPROVE + INCOMPLETE → published INCOMPLETE, never a clean approve', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) files.push(file('f' + i + '.js'));
    const { result, oct } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_files_to_review: 2 }, files,
    });
    expect(result.publication.judgment).toBe('APPROVE');
    expect(result.publication.publishedOutcome).toBe('INCOMPLETE');
    expect(posts(oct)[0].params.event).toBe('COMMENT');
    expect(posts(oct)[0].params.body).toContain('no clean approval was issued');
  });

  test('5. NEEDS_DISCUSSION + INCOMPLETE → published INCOMPLETE', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) files.push(file('f' + i + '.js'));
    const { result } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_files_to_review: 2 }, files,
      model: () => report({ correct: false, findings: [finding({ priority: 'P1' })] }),
    });
    expect(result.publication.judgment).toBe('NEEDS_DISCUSSION');
    expect(result.publication.publishedOutcome).toBe('INCOMPLETE');
  });

  test('6. REQUEST_CHANGES + INCOMPLETE + valid material evidence → REQUEST_CHANGES survives, integrity still incomplete', async () => {
    const files = [file('a.js'), file('big.js', { additions: 5000 }), file('after.js')];
    const { result, oct } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_lines_to_review: 100 }, files,
      model: () => report({ correct: false, findings: [finding()] }),
    });
    expect(result.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(result.publication.integrityIncomplete).toBe(true);
    expect(result.publication.policyBlocked).toBe(true);
    expect(posts(oct)[0].params.body).toContain('Evidence: INCOMPLETE');
  });

  test('7. PINNED ROW: REQUEST_CHANGES + INCOMPLETE + no valid material evidence → REQUEST_CHANGES / ADVISORY / non-blocking / COMMENT', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) files.push(file('f' + i + '.js'));
    const { result, oct } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_files_to_review: 2 }, files,
      model: () => report({ correct: false, findings: [finding({ line: 800 })] }),
    });
    expect(result.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(result.publication.authorityState).toBe('ADVISORY');
    expect(result.publication.policyBlocked).toBe(false);
    expect(result.blocked).toBe(false);
    expect(posts(oct)[0].params.event).toBe('COMMENT');
    expect(finalCheck(oct).conclusion).toBe('success');
  });

  test('8. >100 changed files are fully accounted across pagination', async () => {
    // handled through the pagination-aware files handler
    mockQuery.mockReset(); mockCreate.mockReset(); mockBundle.mockReset();
    mockBundle.mockResolvedValue({ bundle: 'b', changedFiles: ['a.js'], totalChars: 1, coverageAdjustments: [] });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...BASE_CFG, max_files_to_review: 200 }] })
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })
      .mockImplementation((sql) => {
        const s = String(sql);
        if (s.includes("publication_claimed_at = NOW()")) return Promise.resolve({ rows: [{ id: 100 }] });
        return Promise.resolve({ rows: [] });
      });
    mockCreate.mockImplementationOnce(() => report({ correct: true }));

    const page1 = Array.from({ length: 100 }, (_, i) => file('p1-' + i + '.js', { additions: 5, deletions: 0 }));
    const page2 = Array.from({ length: 50 }, (_, i) => file('p2-' + i + '.js', { additions: 5, deletions: 0 }));

    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': (params) =>
        params.page === 1 ? { data: page1 } : { data: page2 },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { head: { sha: HEAD } } },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews': { data: { id: 200 } },
    });

    const r = await reviewPR({ pr: pr(), repository: REPO, octokit: oct });
    expect(r.coverage.totalChangedFiles).toBe(150);
    expect(r.coverage.accountedFiles).toBe(150);
    expect(r.coverage.approvalEvidenceComplete).toBe(true);
    expect(r.publication.publishedOutcome).toBe('APPROVE');
  });

  test('9. max_files_to_review overflow becomes explicit partial/incomplete', async () => {
    const files = [file('a.js'), file('b.js'), file('c.js'), file('d.js')];
    const { result } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_files_to_review: 2 }, files,
    });
    expect(result.coverage.limitsExceeded).toContain('max_files_to_review');
    expect(result.coverage.files.filter((f) => f.reason === 'max_files_exceeded').length).toBe(2);
    expect(result.coverage.approvalEvidenceComplete).toBe(false);
    expect(result.publication.integrityState).toBe('INCOMPLETE');
  });

  test('10. max_lines_to_review overflow becomes explicit partial/incomplete', async () => {
    const files = [file('a.js', { additions: 50 }), file('huge.js', { additions: 5000 }), file('tail.js')];
    const { result } = await runMatrixCase({
      cfg: { ...BASE_CFG, max_lines_to_review: 100 }, files,
    });
    expect(result.coverage.limitsExceeded).toContain('max_lines_to_review');
    expect(result.coverage.files.find((f) => f.path === 'huge.js').coverage).toBe('partial');
    expect(result.coverage.files.find((f) => f.path === 'tail.js').coverage).toBe('partial');
    expect(result.publication.integrityState).toBe('INCOMPLETE');
  });

  test('11. removed file with usable deletion evidence is reviewed', async () => {
    const { result, oct } = await runMatrixCase({
      files: [file('auth.js', { status: 'removed', deletions: 2, additions: 0, patch: DELETION_PATCH })],
      model: () => report({ correct: false, findings: [finding({ file: 'auth.js', line: 11 })] }),
    });
    // the deletion reached the bundle and its evidence validated
    expect(mockBundle.mock.calls[0][0].files.map((f) => f.filename)).toEqual(['auth.js']);
    expect(result.coverage.files[0]).toMatchObject({ path: 'auth.js', status: 'removed', coverage: 'full' });
    expect(result.evidence.materialEvidenceValid).toBe(true);
    expect(result.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(posts(oct)).toHaveLength(1);
  });

  test('12. explicit ignore of a removed file becomes policy_exempt', async () => {
    const { result } = await runMatrixCase({
      cfg: { ...BASE_CFG, ignore_patterns: ['generated/**'] },
      files: [file('generated/api.js', { status: 'removed', patch: DELETION_PATCH }), file('a.js')],
    });
    const record = result.coverage.files.find((f) => f.path === 'generated/api.js');
    expect(record.coverage).toBe('policy_exempt');
    expect(record.reason).toBe('ignore_pattern');
    expect(result.coverage.approvalEvidenceComplete).toBe(true);
  });

  test('13. missing patch becomes unavailable/incomplete', async () => {
    const { result } = await runMatrixCase({
      files: [file('a.js'), file('logo.png', { patch: null, additions: 0, deletions: 0 })],
    });
    expect(result.coverage.files.find((f) => f.path === 'logo.png').coverage).toBe('unavailable');
    expect(result.coverage.approvalEvidenceComplete).toBe(false);
    expect(result.publication.publishedOutcome).toBe('INCOMPLETE');
  });

  test('14. per-file bundle truncation is reflected in coverage', async () => {
    // truncation itself is proven against the real bundle service in
    // reviewBundleCoverage.test.js; the matrix proves the transaction:
    // adjustments downgrade integrity.
    const { result } = await runMatrixCase({
      bundle: { bundle: 'b', changedFiles: ['a.js'], totalChars: 1,
        coverageAdjustments: [{ path: 'a.js', coverage: 'partial', reason: 'patch_truncated' }] },
    });
    expect(result.coverage.files.find((f) => f.path === 'a.js').reason).toBe('patch_truncated');
    expect(result.publication.publishedOutcome).toBe('INCOMPLETE');
  });

  test('15. aggregate bundle truncation is reflected in coverage', async () => {
    const { result } = await runMatrixCase({
      bundle: { bundle: 'b', changedFiles: ['a.js'], totalChars: 1,
        coverageAdjustments: [{ path: 'a.js', coverage: 'partial', reason: 'bundle_truncated' }] },
    });
    expect(result.coverage.files.find((f) => f.path === 'a.js').reason).toBe('bundle_truncated');
    expect(result.publication.publishedOutcome).toBe('INCOMPLETE');
  });

  test('16. SHA changes before publication → SUPERSEDED, zero review POST', async () => {
    const { result, oct } = await runMatrixCase({ pullHead: OTHER_HEAD });
    expect(result.superseded).toBe(true);
    expect(result.publication.integrityState).toBe('SUPERSEDED');
    expect(posts(oct)).toHaveLength(0);
    expect(finalCheck(oct).conclusion).toBe('neutral');
  });

  test('17. malformed model output never becomes a clean APPROVE', async () => {
    const { result, oct } = await runMatrixCase({
      model: () => ({ content: [{ type: 'text', text: 'narration, no JSON' }], usage: {} }),
    });
    expect(result).toBeNull();
    expect(posts(oct)).toHaveLength(0);
    expect(finalCheck(oct).conclusion).toBe('neutral');
  });

  test('18. unsupported material finding cannot block', async () => {
    const { result, oct } = await runMatrixCase({
      model: () => report({ correct: false, findings: [finding({ file: 'not/in/patch.js' })] }),
    });
    expect(result.evidence.materialEvidenceValid).toBe(false);
    expect(result.publication.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(result.publication.authorityState).toBe('ADVISORY');
    expect(result.blocked).toBe(false);
    expect(finalCheck(oct).conclusion).toBe('success');
    expect(posts(oct)[0].params.body).toContain('unverified');
  });

  test('19. GitHub POST rejection remains terminal (one POST, FAILURE check)', async () => {
    const { error, oct } = await runMatrixCase({
      model: () => report({ correct: false, findings: [finding()] }),
      postReviews: () => { const e = new Error('422'); e.status = 422; throw e; },
    });
    expect(error).toMatchObject({ gitwireErrorCode: 'E_REVIEW_DELIVERY' });
    expect(posts(oct)).toHaveLength(1);
    expect(finalCheck(oct).conclusion).toBe('failure');
  });

  test('20. crash after successful POST before persist recovers exactly one review', async () => {
    const marker = '<!-- gitwire-pub:100:1:5:' + HEAD + ' -->';
    const { result, oct } = await runMatrixCase({
      insertRow: {
        id: 100, publication_state: 'submitting', github_review_id: null,
        verdict: 'request_changes', published_outcome: 'REQUEST_CHANGES',
        judgment: 'REQUEST_CHANGES', integrity_state: 'COMPLETE', policy_blocked: true,
      },
      existingReviews: { data: [{ id: 556, body: 'x\n' + marker + '\ny' }] },
    });
    expect(result.recovered).toBe(true);
    expect(posts(oct)).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('21. multiple recovery markers fail closed (terminal, no repost)', async () => {
    const marker = '<!-- gitwire-pub:100:1:5:' + HEAD + ' -->';
    const { error, oct } = await runMatrixCase({
      insertRow: { id: 100, publication_state: 'submitting' },
      existingReviews: { data: [{ id: 1, body: marker }, { id: 2, body: marker }] },
    });
    expect(error).toMatchObject({ gitwireErrorCode: 'E_AMBIGUOUS_PUBLICATION' });
    expect(posts(oct)).toHaveLength(0);
  });

  test('22. recovery lookup failure does not blindly repost', async () => {
    const { error, oct } = await runMatrixCase({
      insertRow: { id: 100, publication_state: 'submitting' },
      existingReviews: () => { throw new Error('502'); },
    });
    expect(error).toMatchObject({ gitwireErrorCode: 'E_PUBLICATION_LOOKUP' });
    expect(posts(oct)).toHaveLength(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
