// tests/unit/reviewBundleCoverage.test.js
// The real bundle service reports its own truncation as coverage adjustments
// (frozen v1.2 WP-2 mechanisms 5 and 6: per-file patch truncation and
// aggregate bundle truncation).

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

describe('buildReviewBundle — truncation adjustments', () => {
  test('patch beyond MAX_DIFF_PER_FILE is reported as patch_truncated', async () => {
    const result = await buildReviewBundle({
      files: [bigFile('a.js', 100), bigFile('big.js', 5000)],
      pr: PR, repository: REPO,
    });

    expect(result.coverageAdjustments).toEqual([
      { path: 'big.js', coverage: 'partial', reason: 'patch_truncated' },
    ]);
    // the small file is untouched
    expect(result.bundle).toContain('a.js');
  });

  test('aggregate budget rebuild reports dropped and sliced files as bundle_truncated', async () => {
    // Enough patch volume to blow the 180K-char bundle budget in the rebuild
    // branch: metadata + context stay, diffs are rebuilt within budget and the
    // tail files fall out.
    const files = [];
    for (let i = 0; i < 60; i++) files.push(bigFile('f' + i + '.js', 5000));

    const result = await buildReviewBundle({ files, pr: PR, repository: REPO });

    const truncated = result.coverageAdjustments.filter((a) => a.reason === 'bundle_truncated');
    expect(truncated.length).toBeGreaterThan(0);
    expect(result.totalChars).toBeLessThanOrEqual(181000);
    // every adjustment path is a real file
    for (const adj of result.coverageAdjustments) {
      expect(files.some((f) => f.filename === adj.path)).toBe(true);
      expect(adj.coverage).toBe('partial');
    }
  });

  test('no truncation produces no adjustments', async () => {
    const result = await buildReviewBundle({
      files: [bigFile('a.js', 100)],
      pr: PR, repository: REPO,
    });
    expect(result.coverageAdjustments).toEqual([]);
  });
});
