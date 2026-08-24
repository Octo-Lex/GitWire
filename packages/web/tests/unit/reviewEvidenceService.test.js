// tests/unit/reviewEvidenceService.test.js
// Frozen v1.2 WP-4: material findings carry canonical evidence validated
// against the exact review SHA and the acquired patches. Blocking eligibility
// and finding visibility are separate concepts.

import {
  buildEvidenceReceipts,
} from '../../src/services/reviewEvidenceService.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Hunk: old lines 1-3 (one deleted), new lines 1-3 (one added)
const PATCH = [
  '@@ -1,3 +1,3 @@',
  ' context one',
  '-old two',
  '+new two',
  ' context three',
].join('\n');

const REMOVED_PATCH = [
  '@@ -10,4 +9,0 @@',
  '-checkAuth()',
  '-validateToken()',
  '-audit()',
  '-close()',
].join('\n');

const FILES = [
  { filename: 'src/app.js', status: 'modified', patch: PATCH },
  { filename: 'auth.js', status: 'removed', patch: REMOVED_PATCH },
  { filename: 'logo.png', status: 'added', patch: '' },
];

function finding(overrides = {}) {
  return {
    severity: 'critical',
    title: 't',
    description: 'd',
    file: 'src/app.js',
    line: 3,
    ...overrides,
  };
}

describe('buildEvidenceReceipts — validation', () => {
  test('finding on a represented new-side line is valid changed_file evidence', () => {
    const { receipts, materialEvidenceValid } = buildEvidenceReceipts({
      findings: [finding({ line: 3 })],
      files: FILES, headSha: HEAD,
    });
    const r = receipts[0];
    expect(r.valid).toBe(true);
    expect(r.reason).toBe('validated');
    expect(r.evidenceType).toBe('changed_file');
    expect(r.path).toBe('src/app.js');
    expect(r.headSha).toBe(HEAD);
    expect(r.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(materialEvidenceValid).toBe(true);
  });

  test('deleted (old-side) lines are valid review evidence', () => {
    // Removed file auth.js: old side lines 10-13 are all deletions
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ file: 'auth.js', line: 12 })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(true);
    expect(receipts[0].range).toEqual({ side: 'old', start: 10, end: 13 });
  });

  test('line outside every represented hunk is invalid', () => {
    const { receipts, materialEvidenceValid } = buildEvidenceReceipts({
      findings: [finding({ line: 800 })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(false);
    expect(receipts[0].reason).toBe('line_outside_patch');
    expect(materialEvidenceValid).toBe(false);
  });

  test('unknown path (unchanged repo context) is invalid', () => {
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ file: 'src/unchanged.js' })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(false);
    expect(receipts[0].reason).toBe('path_not_in_review_scope');
  });

  test('finding without a line reference is invalid', () => {
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ line: null })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(false);
    expect(receipts[0].reason).toBe('no_line_reference');
  });

  test('finding without any location is invalid', () => {
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ file: null, line: null })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(false);
    expect(receipts[0].reason).toBe('no_location');
  });

  test('file without patch content has no usable evidence', () => {
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ file: 'logo.png', line: 1 })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].valid).toBe(false);
    expect(receipts[0].reason).toBe('no_patch_evidence');
  });

  test('digest is deterministic for identical patches', () => {
    const a = buildEvidenceReceipts({ findings: [finding()], files: FILES, headSha: HEAD });
    const b = buildEvidenceReceipts({ findings: [finding()], files: FILES, headSha: HEAD });
    expect(a.receipts[0].digest).toBe(b.receipts[0].digest);
  });
});

describe('buildEvidenceReceipts — material aggregation', () => {
  test('only material severities gate eligibility; low findings do not', () => {
    const { materialEvidenceValid } = buildEvidenceReceipts({
      findings: [finding({ severity: 'low', file: 'nowhere.js' })],
      files: FILES, headSha: HEAD,
    });
    expect(materialEvidenceValid).toBe(true);
  });

  test('one invalid material finding makes evidence invalid overall', () => {
    const { materialEvidenceValid } = buildEvidenceReceipts({
      findings: [
        finding({ line: 3 }),
        finding({ file: 'nowhere.js' }),
      ],
      files: FILES, headSha: HEAD,
    });
    expect(materialEvidenceValid).toBe(false);
  });

  test('no findings at all is vacuously valid', () => {
    const { materialEvidenceValid } = buildEvidenceReceipts({
      findings: [], files: FILES, headSha: HEAD,
    });
    expect(materialEvidenceValid).toBe(true);
  });

  test('receipts keep findingIndex alignment for receipt stitching', () => {
    const { receipts } = buildEvidenceReceipts({
      findings: [finding({ line: 3 }), finding({ file: 'x' })],
      files: FILES, headSha: HEAD,
    });
    expect(receipts[0].findingIndex).toBe(0);
    expect(receipts[1].findingIndex).toBe(1);
  });
});
