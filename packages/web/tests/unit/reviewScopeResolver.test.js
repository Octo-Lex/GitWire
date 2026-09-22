// tests/unit/reviewScopeResolver.test.js
// SC-01 P1: the scope resolver classifies every changed file WITHOUT the
// legacy admission budgets (max_files_to_review / max_lines_to_review),
// while keeping ignore-pattern, no-patch and deleted-file semantics
// identical to buildFileCoverage().

import { jest } from '@jest/globals';

const { resolveReviewScope } = await import('../../src/services/reviewScopeResolver.js');
// Pure module — no mocks needed.
const { buildFileCoverage } = await import('../../src/services/reviewCoverageService.js');

function ghFile(name, { additions = 1, deletions = 0, status = 'modified', patch = '@@ -1,1 +1,1 @@\n ctx\n+new' } = {}) {
  return { filename: name, status, additions, deletions, patch, sha: 's-' + name };
}

// Deterministic PRNG (mulberry32) — property tests must not depend on
// Math.random for reproducibility.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('resolveReviewScope — budget-free classification', () => {
  test('legacy budgets never define the candidate evidence set', () => {
    const files = [];
    for (let i = 0; i < 50; i++) {
      files.push(ghFile('f' + i + '.js', { additions: 240, deletions: 10 })); // 12,500 lines total
    }
    const cfg = { ignore_patterns: [], max_files_to_review: 5, max_lines_to_review: 10 };

    const scope = resolveReviewScope({ prFiles: files, cfg, headSha: 'abc' });

    expect(scope.eligible).toHaveLength(50);
    expect(scope.totals.eligibleAdded).toBe(50 * 240);
    expect(scope.totals.eligibleRemoved).toBe(50 * 10);

    // Contrast: the legacy cutter cuts the SAME input to nothing — the
    // line budget trips on the very first file (250 > 10) and everything
    // after it is partial. The difference is real, not vacuous.
    const legacy = buildFileCoverage({ prFiles: files, cfg, headSha: 'abc' });
    expect(legacy.files.length).toBe(0);
    expect(legacy.coverage.limitsExceeded).toContain('max_lines_to_review');
    expect(legacy.coverage.files.every((r) => r.reason === 'max_lines_exceeded')).toBe(true);
  });

  test('classification parity with buildFileCoverage when budgets do not bind', () => {
    const rand = mulberry32(42);
    for (let round = 0; round < 25; round++) {
      const files = [];
      const n = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) {
        const kind = rand();
        if (kind < 0.2) files.push({ ...ghFile('ign' + i + '.lock'), filename: 'src' + round + '/x' + i + '.lock' });
        else if (kind < 0.35) files.push({ filename: 'bin' + i + '.png', status: 'added', additions: 0, deletions: 0, patch: null, sha: 's' });
        else if (kind < 0.5) files.push(ghFile('del' + i + '.js', { status: 'removed', additions: 0, deletions: 30 }));
        else files.push(ghFile('m' + i + '.js', { additions: 1 + Math.floor(rand() * 40) }));
      }
      const cfg = { ignore_patterns: ['*.lock'], max_files_to_review: 30, max_lines_to_review: 2000 };

      const scope = resolveReviewScope({ prFiles: files, cfg, headSha: 'sha' + round });
      const legacy = buildFileCoverage({ prFiles: files, cfg, headSha: 'sha' + round });

      const legacyByPath = Object.fromEntries(legacy.coverage.files.map((r) => [r.path, r]));
      for (const e of scope.eligible) {
        expect(legacyByPath[e.filename]?.coverage).toBe('full');
        expect(legacyByPath[e.filename]?.reason).toBe(null);
      }
      for (const e of scope.policyExempt) expect(legacyByPath[e.path]?.reason).toBe('ignore_pattern');
      for (const e of scope.unavailable) expect(legacyByPath[e.path]?.reason).toBe('no_patch');
      expect(scope.totalChangedFiles).toBe(legacy.coverage.totalChangedFiles);
    }
  });

  test('deleted files with patches are eligible; missing patches are unavailable', () => {
    const files = [
      ghFile('gone.js', { status: 'removed', additions: 0, deletions: 12 }),
      { filename: 'huge.bin', status: 'added', additions: 0, deletions: 0, patch: null, sha: 's' },
    ];
    const scope = resolveReviewScope({ prFiles: files, cfg: { ignore_patterns: [] }, headSha: 'h' });
    expect(scope.eligible.map((f) => f.filename)).toEqual(['gone.js']);
    expect(scope.unavailable).toEqual([{ path: 'huge.bin', status: 'added', reason: 'no_patch' }]);
  });

  test('eligible records are bundle-normalized (added/removed, not additions/deletions)', () => {
    const scope = resolveReviewScope({
      prFiles: [ghFile('a.js', { additions: 7, deletions: 3 })],
      cfg: {}, headSha: 'h',
    });
    expect(scope.eligible[0]).toMatchObject({ filename: 'a.js', added: 7, removed: 3 });
  });

  test('paginationCapped is surfaced, never interpreted', () => {
    const scope = resolveReviewScope({
      prFiles: [ghFile('a.js')], cfg: {}, headSha: 'h', paginationCapped: true,
    });
    expect(scope.paginationCapped).toBe(true);
    // The cap does not reclassify anything — it is acquisition metadata.
    expect(scope.eligible).toHaveLength(1);
  });
});
