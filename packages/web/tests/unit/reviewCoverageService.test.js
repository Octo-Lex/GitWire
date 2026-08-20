// tests/unit/reviewCoverageService.test.js
// Frozen v1.2 WP-2: every changed file accounted for across all seven
// scope-loss mechanisms; removed files are reviewable, never auto-exempt.

import {
  buildFileCoverage,
  finalizeCoverage,
  coverageSummaryLine,
} from '../../src/services/reviewCoverageService.js';

function file(name, opts = {}) {
  return {
    filename: name,
    status: opts.status ?? 'modified',
    additions: opts.additions ?? 10,
    deletions: opts.deletions ?? 0,
    patch: opts.patch === undefined ? '+a\n+b' : opts.patch,
    sha: 'sha-' + name,
  };
}

const CFG = { ignore_patterns: [], max_files_to_review: 30, max_lines_to_review: 2000 };

describe('buildFileCoverage — accounting', () => {
  test('every changed file gets a record; complete evidence when all full', () => {
    const { files, coverage } = buildFileCoverage({
      prFiles: [file('a.js'), file('b.js'), file('c.js')],
      cfg: CFG, headSha: 'sha1',
    });
    expect(coverage.totalChangedFiles).toBe(3);
    expect(coverage.accountedFiles).toBe(3);
    expect(coverage.files.map((r) => r.path)).toEqual(['a.js', 'b.js', 'c.js']);
    expect(coverage.approvalEvidenceComplete).toBe(true);
    expect(files.map((f) => f.filename)).toEqual(['a.js', 'b.js', 'c.js']);
  });

  test('removed files are normal reviewable changes — never auto-exempt (frozen v1.2 ruling)', () => {
    const { files, coverage } = buildFileCoverage({
      prFiles: [file('deleted.js', { status: 'removed', deletions: 20, additions: 0, patch: '-line1\n-line2' })],
      cfg: CFG, headSha: 'sha1',
    });
    const record = coverage.files[0];
    expect(record.coverage).toBe('full');
    expect(record.status).toBe('removed');
    expect(files[0].filename).toBe('deleted.js');
    expect(coverage.approvalEvidenceComplete).toBe(true);
  });

  test('explicit ignore pattern classifies policy_exempt and excludes from review', () => {
    const { files, coverage } = buildFileCoverage({
      prFiles: [file('vendor/lib.js'), file('src/app.js')],
      cfg: { ...CFG, ignore_patterns: ['vendor/**'] },
      headSha: 'sha1',
    });
    const vendor = coverage.files.find((r) => r.path === 'vendor/lib.js');
    expect(vendor.coverage).toBe('policy_exempt');
    expect(vendor.reason).toBe('ignore_pattern');
    expect(files.map((f) => f.filename)).toEqual(['src/app.js']);
    // policy_exempt does not break evidence completeness
    expect(coverage.approvalEvidenceComplete).toBe(true);
  });

  test('binary/no-patch files are unavailable and break evidence completeness', () => {
    const { coverage } = buildFileCoverage({
      prFiles: [file('logo.png', { patch: null }), file('a.js')],
      cfg: CFG, headSha: 'sha1',
    });
    const png = coverage.files.find((r) => r.path === 'logo.png');
    expect(png.coverage).toBe('unavailable');
    expect(png.reason).toBe('no_patch');
    expect(coverage.approvalEvidenceComplete).toBe(false);
  });
});

describe('buildFileCoverage — budget accounting', () => {
  test('max_files_to_review overflow becomes explicit partial', () => {
    const prFiles = [];
    for (let i = 0; i < 5; i++) prFiles.push(file('f' + i + '.js'));
    const { files, coverage } = buildFileCoverage({
      prFiles,
      cfg: { ...CFG, max_files_to_review: 3 },
      headSha: 'sha1',
    });
    expect(files.length).toBe(3);
    expect(coverage.limitsExceeded).toContain('max_files_to_review');
    const overflow = coverage.files.filter((r) => r.reason === 'max_files_exceeded');
    expect(overflow.map((r) => r.path).sort()).toEqual(['f3.js', 'f4.js']);
    expect(overflow.every((r) => r.coverage === 'partial')).toBe(true);
    expect(coverage.approvalEvidenceComplete).toBe(false);
  });

  test('max_lines_to_review overflow becomes explicit partial, including files after the trip', () => {
    const prFiles = [
      file('small.js', { additions: 100, deletions: 0 }),
      file('big.js', { additions: 5000, deletions: 0 }),
      file('after.js', { additions: 10, deletions: 0 }),
    ];
    const { files, coverage } = buildFileCoverage({
      prFiles,
      cfg: { ...CFG, max_lines_to_review: 2000 },
      headSha: 'sha1',
    });
    expect(files.map((f) => f.filename)).toEqual(['small.js']);
    expect(coverage.limitsExceeded).toContain('max_lines_to_review');
    const partials = coverage.files.filter((r) => r.coverage === 'partial');
    // the trip file AND everything never examined after it
    expect(partials.map((r) => r.path).sort()).toEqual(['after.js', 'big.js']);
    expect(coverage.approvalEvidenceComplete).toBe(false);
  });

  test('pagination cap marks evidence incomplete even when all pages shown are full', () => {
    const { coverage } = buildFileCoverage({
      prFiles: [file('a.js')],
      cfg: CFG, headSha: 'sha1', paginationCapped: true,
    });
    expect(coverage.limitsExceeded).toContain('changed_files_pagination_cap');
    expect(coverage.approvalEvidenceComplete).toBe(false);
  });
});

describe('finalizeCoverage — bundle-stage truncation', () => {
  test('patch truncation downgrades the affected file to partial', () => {
    const { coverage } = buildFileCoverage({ prFiles: [file('a.js'), file('b.js')], cfg: CFG, headSha: 'sha1' });
    const final = finalizeCoverage(coverage, [
      { path: 'a.js', coverage: 'partial', reason: 'patch_truncated' },
    ]);
    expect(final.files.find((r) => r.path === 'a.js').coverage).toBe('partial');
    expect(final.files.find((r) => r.path === 'b.js').coverage).toBe('full');
    expect(final.approvalEvidenceComplete).toBe(false);
  });

  test('aggregate bundle truncation downgrades affected files', () => {
    const { coverage } = buildFileCoverage({ prFiles: [file('a.js'), file('b.js')], cfg: CFG, headSha: 'sha1' });
    const final = finalizeCoverage(coverage, [
      { path: 'a.js', coverage: 'partial', reason: 'bundle_truncated' },
      { path: 'b.js', coverage: 'partial', reason: 'bundle_truncated' },
    ]);
    expect(final.approvalEvidenceComplete).toBe(false);
    expect(final.files.every((r) => r.reason === 'bundle_truncated')).toBe(true);
  });

  test('no adjustments keeps completeness; input coverage is not mutated', () => {
    const { coverage } = buildFileCoverage({ prFiles: [file('a.js')], cfg: CFG, headSha: 'sha1' });
    const final = finalizeCoverage(coverage, undefined);
    expect(final.approvalEvidenceComplete).toBe(true);
    expect(coverage).not.toBe(final);
  });
});

describe('coverageSummaryLine', () => {
  test('complete evidence renders accounted counts', () => {
    const { coverage } = buildFileCoverage({ prFiles: [file('a.js'), file('b.js')], cfg: CFG, headSha: 's' });
    expect(coverageSummaryLine(coverage)).toBe('Evidence complete \u00B7 2/2 changed files accounted for');
  });

  test('incomplete evidence renders lacking counts and limits', () => {
    const prFiles = [file('a.js'), file('b.js'), file('c.js'), file('d.js')];
    const { coverage } = buildFileCoverage({ prFiles, cfg: { ...CFG, max_files_to_review: 2 }, headSha: 's' });
    const line = coverageSummaryLine(coverage);
    expect(line).toContain('Evidence incomplete');
    expect(line).toContain('2 of 4');
    expect(line).toContain('max_files_to_review');
  });
});
