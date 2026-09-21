// tests/unit/reviewBundleCoverage.test.js
// PC-01 v2.1: the bundle service assembles COMPLETE evidence and never
// truncates on its own. Aggregate token admission lives in the review
// execution layer (aiReviewService + reviewTokenAccounting); this service
// reports allocation outcomes via reassemble()'s bundle_truncated
// adjustments (frozen v1.2 WP-2 mechanism 6 semantics, carried forward).

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

await jest.unstable_mockModule('../../src/lib/db.js', () => ({
  db: { query: mockQuery },
}));

await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

await jest.unstable_mockModule('../../src/services/configService.js', () => ({
  getConfigForRepo: jest.fn().mockResolvedValue({}),
}));

const { buildReviewBundle } = await import('../../src/services/reviewBundleService.js');

const PR = { number: 1, title: 't', user: { login: 'dev' }, base: { ref: 'main' }, head: { ref: 'x' }, body: '' };
const REPO = { id: 1, full_name: 'o/r' };

function bigFile(name, chars, additions = 1) {
  return {
    filename: name, status: 'modified',
    additions, deletions: 0,
    patch: '+' + 'x'.repeat(chars),
    sha: 's',
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('buildReviewBundle — complete evidence assembly (PC-01 v2.1)', () => {
  test('no per-file cap: a 13k patch survives whole (12k rule removed)', async () => {
    const result = await buildReviewBundle({
      files: [bigFile('a.js', 100), bigFile('mid.js', 5000), bigFile('big.js', 13000)],
      pr: PR, repository: REPO,
    });

    expect(result.coverageAdjustments).toEqual([]);
    expect(result.bundle).toContain('x'.repeat(13000));
    expect(result.bundle).not.toContain('... (truncated)');
    expect(result.bundle).toContain('a.js');
  });

  test('no aggregate char cap: bundles beyond 180k chars assemble whole', async () => {
    const files = [];
    for (let i = 0; i < 60; i++) files.push(bigFile('f' + i + '.js', 5000));
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });

    expect(result.totalChars).toBeGreaterThan(180000);
    expect(result.coverageAdjustments).toEqual([]);
    expect(result.bundle).toContain('x'.repeat(5000));
  });

  test('a single large file may exceed every legacy ceiling at once', async () => {
    const result = await buildReviewBundle({
      files: [bigFile('huge.js', 250000)],
      pr: PR, repository: REPO,
    });
    expect(result.bundle).toContain('x'.repeat(250000));
    expect(result.coverageAdjustments).toEqual([]);
  });

  test('binary files keep the no-diff placeholder and produce no adjustments', async () => {
    const result = await buildReviewBundle({
      files: [{ filename: 'bin.dat', status: 'added', additions: 0, deletions: 0, patch: null, sha: 's' }],
      pr: PR, repository: REPO,
    });
    expect(result.bundle).toContain('(no diff available — binary or large file)');
    expect(result.coverageAdjustments).toEqual([]);
    // the section is still addressable for allocation accounting
    expect(result.fileSections).toHaveLength(1);
    expect(result.fileSections[0].path).toBe('bin.dat');
  });

  test('fileSections preserve existing file order and per-file text', async () => {
    const files = [bigFile('z.js', 10), bigFile('a.js', 20), bigFile('m.js', 30)];
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });
    expect(result.fileSections.map((s) => s.path)).toEqual(['z.js', 'a.js', 'm.js']);
    for (const s of result.fileSections) {
      expect(s.text).toContain('#### ' + s.path);
      expect(s.text).toContain('```diff');
    }
  });
});

describe('reassemble — deterministic aggregate allocation output', () => {
  test('reassemble(n) keeps the first n sections, marks the rest bundle_truncated', async () => {
    const files = [bigFile('f0.js', 100), bigFile('f1.js', 100), bigFile('f2.js', 100), bigFile('f3.js', 100)];
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });

    const partial = result.reassemble(2);
    expect(partial.coverageAdjustments).toEqual([
      { path: 'f2.js', coverage: 'partial', reason: 'bundle_truncated' },
      { path: 'f3.js', coverage: 'partial', reason: 'bundle_truncated' },
    ]);
    // admitted sections present, omitted absent
    expect(partial.bundle).toContain('#### f0.js');
    expect(partial.bundle).toContain('#### f1.js');
    expect(partial.bundle).not.toContain('#### f2.js');
    expect(partial.bundle).not.toContain('#### f3.js');
    // metadata and repository/config context survive
    expect(partial.bundle).toContain('## PR Metadata');
    expect(partial.bundle).toContain('### File Summary');
    expect(partial.bundle).toContain('## Repository Context');
    expect(partial.bundle).toContain('## Active Configuration');
    // file summary still lists every changed file (scope visibility)
    expect(partial.bundle).toContain('f3.js');
    // deterministic truncation note
    expect(partial.bundle).toContain('(review input token budget reached — 2 remaining changed-file diffs omitted)');
  });

  test('reassemble(all) reproduces the complete bundle byte-for-byte', async () => {
    const files = [bigFile('f0.js', 100), bigFile('f1.js', 30000)];
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });
    expect(result.reassemble(files.length).bundle).toBe(result.bundle);
    expect(result.reassemble(files.length).coverageAdjustments).toEqual([]);
  });

  test('reassemble(0) keeps metadata/context and marks every file bundle_truncated', async () => {
    const files = [bigFile('f0.js', 100), bigFile('f1.js', 100)];
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });
    const skeleton = result.reassemble(0);
    expect(skeleton.coverageAdjustments).toHaveLength(2);
    expect(skeleton.bundle).not.toContain('```diff');
    expect(skeleton.bundle).toContain('## Repository Context');
  });

  test('clamping: out-of-range counts are safe', async () => {
    const files = [bigFile('f0.js', 100)];
    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });
    expect(result.reassemble(99).coverageAdjustments).toEqual([]);
    expect(result.reassemble(-1).coverageAdjustments).toEqual([
      { path: 'f0.js', coverage: 'partial', reason: 'bundle_truncated' },
    ]);
  });
});
