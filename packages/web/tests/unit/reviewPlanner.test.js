// tests/unit/reviewPlanner.test.js
// SC-01 P1 replay/property evidence for the pure deterministic planner.
//
// Frozen contract points proven here:
//   4. fast-path identity with the production PC-01 complete path
//   5. overflow creates work, never missing evidence (no bundle_truncated)
//   6. hierarchy: whole files → hunks → deterministic regions
//   7. monotonic coverage (eligible(A) ⊆ eligible(B) ⇒ coverage(A) ⊆ coverage(B))
//   8. determinism (identical inputs + oracle ⇒ identical plans/ids)
//   9. no authority fields in planner output
//   10. historical reason renderability (incl. patch_truncated)
//
// The planner is exercised with an injected deterministic oracle — no
// provider call is ever made (contract 2). The fast-path identity case runs
// the REAL admitPrimaryReviewEvidence with a mocked countInputTokens
// returning the same estimator's value, proving the planner's one unit is
// the production complete path, not a new representation.

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

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
  config: {
    server: { env: 'test' },
    anthropic: { apiKey: 'test', baseURL: 'http://test' },
    ai: { model: 'test-model' },
  },
}));

// Deterministic estimator shared by the mocked counter and the planner
// oracle — the SAME function measures both paths in the identity proof.
const charEstimator = ({ system, userPrompt }) =>
  Math.ceil((((system ?? '') + (userPrompt ?? '')).length) / 4);
const mockCountInputTokens = jest.fn(charEstimator);

await jest.unstable_mockModule('../../src/services/reviewTokenAccounting.js', () => ({
  countInputTokens: mockCountInputTokens,
  classifyProviderRejection: jest.fn((e) => e?.gitwireRejectionClass || 'other'),
  MAX_PRIMARY_INPUT_TOKENS: 958016,
}));

await jest.unstable_mockModule('../../src/services/reviewValidator.js', () => ({
  validateReview: jest.fn(),
}));

await jest.unstable_mockModule('../../src/services/reviewHeartbeat.js', () => ({
  withHeartbeat: jest.fn(async (fn) => fn()),
}));

await jest.unstable_mockModule('../../src/services/adversarialReview.js', () => ({
  runAdversarialChallenge: jest.fn(),
  refineFindings: jest.fn(),
}));

await jest.unstable_mockModule('../../src/services/adversarialDefense.js', () => ({
  runDefensePass: jest.fn(),
  refineWithDefense: jest.fn(),
}));

const { buildReviewBundle } = await import('../../src/services/reviewBundleService.js');
const { buildReviewRequest, admitPrimaryReviewEvidence } = await import('../../src/services/aiReviewService.js');
const { planReviewUnits, splitPatchIntoHunks, PLANNER_ERRORS, PLANNER_VERSION } = await import('../../src/services/reviewPlanner.js');
const { resolveReviewScope } = await import('../../src/services/reviewScopeResolver.js');
const { buildFileCoverage, finalizeCoverage, coverageSummaryLine } = await import('../../src/services/reviewCoverageService.js');

const PR = { number: 7, title: 'T', user: { login: 'dev' }, base: { ref: 'main' }, head: { ref: 'br' }, body: '' };
const REPO = { id: 1, full_name: 'o/r' };
const BINDING = { repo: 'o/r', prNumber: 7, headSha: 'deadbeefcafe' };

const OPTS = {
  model: 'claude-sonnet-4-20250514',
  includeSecurity: true, includeArchitecture: true,
  prTitle: 'T', prAuthor: '@dev', prBranch: 'main ← br', repoName: 'o/r',
};

function hunkedPatch(hunks) {
  return hunks.map((h) => h.header + '\n' + h.lines.join('\n')).join('\n');
}

function ghFile(name, patch, { additions = 1, deletions = 0, status = 'modified' } = {}) {
  return { filename: name, status, additions, deletions, patch, sha: 's-' + name };
}

// Build a synthetic changed line of ~`chars` characters.
function line(prefix, chars) { return prefix + 'x'.repeat(chars); }

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockCountInputTokens.mockClear();
  mockCountInputTokens.mockImplementation(charEstimator);
});

/** Resolve scope + build the REAL complete bundle + run the planner. */
async function planFiles(prFiles, cfg, { ceiling, oracle = charEstimator } = {}) {
  const scope = resolveReviewScope({ prFiles, cfg, headSha: BINDING.headSha });
  const bundleParts = await buildReviewBundle({ files: scope.eligible, pr: PR, repository: REPO });
  const plan = await planReviewUnits({
    binding: BINDING, scope, bundleParts, changedFiles: bundleParts.changedFiles,
    opts: OPTS, buildRequest: buildReviewRequest, oracle, ceiling,
  });
  return { scope, bundleParts, plan };
}

describe('planReviewUnits — fast-path identity (contract 4)', () => {
  test('a fitting PR plans exactly ONE unit that IS the PC-01 complete path', async () => {
    const files = [
      ghFile('a.js', '@@ -1,2 +1,2 @@\n ctx\n-old\n+new'),
      ghFile('b.js', '@@ -10,2 +10,3 @@\n ctx\n ctx\n+added'),
    ];

    const scope = resolveReviewScope({ prFiles: files, cfg: {}, headSha: BINDING.headSha });
    const bundleParts = await buildReviewBundle({ files: scope.eligible, pr: PR, repository: REPO });

    // Production admission with the SAME estimator: fits → complete path.
    const admission = await admitPrimaryReviewEvidence({
      bundleParts, changedFiles: bundleParts.changedFiles, opts: OPTS, deadline: Date.now() + 60000,
    });
    expect(admission.allocated).toBe(false);

    const plan = await planReviewUnits({
      binding: BINDING, scope, bundleParts, changedFiles: bundleParts.changedFiles,
      opts: OPTS, buildRequest: buildReviewRequest, oracle: charEstimator, ceiling: 958016,
    });

    expect(plan.strategy).toBe('fast_path');
    expect(plan.units).toHaveLength(1);
    const unit = plan.units[0];
    expect(unit.kind).toBe('complete');
    expect(unit.request).toEqual(admission.request);          // same request object shape/content
    expect(unit.bundleChars).toBe(admission.bundleChars);     // same complete bundle
    expect(plan.completeRequestTokens).toBe(admission.requestedTokens);
    expect(unit.files).toEqual(['a.js', 'b.js']);
    expect(plan.plannedCoverage.complete).toBe(true);
  });
});

describe('planReviewUnits — legacy cutoffs no longer pre-cut scope', () => {
  test('>2,000 changed lines: the plan represents the whole PR; legacy cuts it', async () => {
    const prFiles = [];
    for (let i = 0; i < 12; i++) {
      const body = Array.from({ length: 220 }, (_, k) => (k % 3 === 0 ? line('+', 40) : ' ctx' + i)).join('\n');
      prFiles.push(ghFile('f' + i + '.js', '@@ -1,3 +1,220 @@\n' + body, { additions: 220, deletions: 0 }));
    }
    const legacy = buildFileCoverage({ prFiles, cfg: {}, headSha: 'x' });
    expect(legacy.coverage.limitsExceeded).toContain('max_lines_to_review');   // legacy DOES cut
    expect(legacy.coverage.files.some((r) => r.reason === 'max_lines_exceeded')).toBe(true);

    const { plan } = await planFiles(prFiles, {}, { ceiling: 958016 });
    expect(plan.strategy).toBe('fast_path');
    expect(plan.units[0].files).toHaveLength(12);
    expect(plan.plannedCoverage.complete).toBe(true);
    expect(plan.plannedCoverage.unaccountedEvidence).toEqual([]);
  });

  test('>30 eligible files: all remain represented', async () => {
    const prFiles = [];
    for (let i = 0; i < 40; i++) {
      prFiles.push(ghFile('f' + i + '.js', '@@ -1,1 +1,2 @@\n ctx\n+new' + i, { additions: 2 }));
    }
    const legacy = buildFileCoverage({ prFiles, cfg: {}, headSha: 'x' });
    expect(legacy.coverage.limitsExceeded).toContain('max_files_to_review');

    const { plan } = await planFiles(prFiles, {}, { ceiling: 958016 });
    expect(plan.plannedCoverage.coveredFiles).toHaveLength(40);
    expect(plan.plannedCoverage.complete).toBe(true);
  });
});

describe('planReviewUnits — overflow creates work, never missing evidence (contract 5)', () => {
  test('deterministic multi-unit plan; every file covered once; no unit over ceiling', async () => {
    const prFiles = [];
    for (let i = 0; i < 6; i++) {
      const body = Array.from({ length: 60 }, () => line('+', 80)).join('\n');
      prFiles.push(ghFile('f' + i + '.js', '@@ -1,1 +1,60 @@\n' + body, { additions: 60 }));
    }
    const { plan } = await planFiles(prFiles, {}, { ceiling: 2600 }); // complete ~7k tokens

    expect(plan.strategy).toBe('multi_unit');
    expect(plan.units.length).toBeGreaterThan(1);
    for (const unit of plan.units) {
      expect(unit.estimatedRequestTokens).toBeLessThanOrEqual(plan.ceiling);
    }
    const covered = plan.units.flatMap((u) => u.files);
    expect(covered.sort()).toEqual([...prFiles.map((f) => f.filename)].sort());
    expect(plan.plannedCoverage.complete).toBe(true);

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('bundle_truncated');
    expect(serialized).not.toContain('max_lines_exceeded');
    expect(serialized).not.toContain('max_files_exceeded');
  });

  test('oversized single file decomposes by hunks; all hunk indices accounted', async () => {
    const hunks = [0, 1, 2].map((h) => ({
      header: `@@ -${10 * h + 1},1 +${10 * h + 1},20 @@`,
      lines: Array.from({ length: 20 }, () => line('+', 90)),
    }));
    const prFiles = [ghFile('big.js', hunkedPatch(hunks), { additions: 60 })];

    // Derive the ceiling from the measured complete request: 75% forces
    // the whole-file section out of any single unit while each hunk
    // (~1/3 of the file) still fits.
    const fitting = (await planFiles(prFiles, {}, { ceiling: 958016 })).plan;
    const ceiling = Math.ceil(fitting.completeRequestTokens * 0.75);
    const { plan } = await planFiles(prFiles, {}, { ceiling });
    expect(plan.strategy).toBe('multi_unit');
    expect(plan.units.some((u) => u.kind === 'file_hunks')).toBe(true);

    const hunkIdx = plan.units
      .flatMap((u) => u.fragments)
      .flatMap((f) => f.hunks ?? [])
      .sort((a, b) => a - b);
    expect(hunkIdx).toEqual([0, 1, 2]);
    expect(plan.plannedCoverage.complete).toBe(true);
    expect(plan.plannedCoverage.accountedHunks).toBe(3);
  });

  test('giant single hunk partitions into deterministic line regions with original coordinates', async () => {
    const lines = Array.from({ length: 400 }, () => line('+', 90));
    const prFiles = [ghFile('huge.js', '@@ -1,1 +1,400 @@\n' + lines.join('\n'), { additions: 400 })];

    // Half the measured complete request: the single ~9k-token hunk cannot
    // fit any unit, so it must partition into regions.
    const fitting = (await planFiles(prFiles, {}, { ceiling: 958016 })).plan;
    const ceiling = Math.ceil(fitting.completeRequestTokens * 0.5);
    const { plan } = await planFiles(prFiles, {}, { ceiling });
    expect(plan.strategy).toBe('multi_unit');
    expect(plan.units.every((u) => u.kind === 'hunk_regions')).toBe(true);
    expect(plan.units.length).toBeGreaterThan(1);

    // Original coordinates preserved: regions ascend, start at new-file
    // line 1, and are contiguous non-overlapping cores.
    const ranges = plan.units
      .flatMap((u) => u.fragments)
      .flatMap((f) => f.regions.map((r) => r.newRange))
      .sort((a, b) => a[0] - b[0]);
    expect(ranges[0][0]).toBe(1);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1]); // no core overlap
    }
    expect(plan.plannedCoverage.complete).toBe(true);
    for (const unit of plan.units) {
      expect(unit.estimatedRequestTokens).toBeLessThanOrEqual(plan.ceiling);
    }
  });
});

describe('planReviewUnits — determinism (contract 8)', () => {
  test('identical inputs + oracle produce identical plans, unit ids and order', async () => {
    const prFiles = [];
    for (let i = 0; i < 5; i++) {
      const body = Array.from({ length: 40 }, () => line('+', 70)).join('\n');
      prFiles.push(ghFile('d' + i + '.js', '@@ -1,1 +1,40 @@\n' + body, { additions: 40 }));
    }
    const a = await planFiles(prFiles, {}, { ceiling: 2000 });
    const b = await planFiles(prFiles, {}, { ceiling: 2000 });
    expect(a.plan).toEqual(b.plan);
    expect(a.plan.units.map((u) => u.unitId)).toEqual(b.plan.units.map((u) => u.unitId));
  });
});

describe('planReviewUnits — monotonic coverage (contract 7)', () => {
  // Seeded generator; property: eligible(A) ⊆ eligible(B) ⇒ every file
  // covered by A's plan is covered by B's plan, and B is complete.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('adding eligible evidence never decreases planned coverage (25 rounds)', async () => {
    const rand = mulberry32(1337);
    for (let round = 0; round < 25; round++) {
      const extraCount = 1 + Math.floor(rand() * 3);
      const base = [];
      for (let i = 0; i < 3; i++) {
        const body = Array.from({ length: 5 + Math.floor(rand() * 40) }, () => line('+', 20 + Math.floor(rand() * 90))).join('\n');
        base.push(ghFile('b' + round + '_' + i + '.js', '@@ -1,1 +1,' + (body.split('\n').length) + ' @@\n' + body, { additions: body.split('\n').length }));
      }
      const extra = [];
      for (let i = 0; i < extraCount; i++) {
        const body = Array.from({ length: 5 + Math.floor(rand() * 40) }, () => line('+', 20 + Math.floor(rand() * 90))).join('\n');
        extra.push(ghFile('e' + round + '_' + i + '.js', '@@ -1,1 +1,' + (body.split('\n').length) + ' @@\n' + body, { additions: body.split('\n').length }));
      }
      const ceiling = 1800 + Math.floor(rand() * 3000); // mixes fast_path and multi_unit

      const planA = (await planFiles(base, {}, { ceiling })).plan;
      const planB = (await planFiles([...base, ...extra], {}, { ceiling })).plan;

      expect(planA.plannedCoverage.complete).toBe(true);
      expect(planB.plannedCoverage.complete).toBe(true);
      for (const path of planA.plannedCoverage.coveredFiles) {
        expect(planB.plannedCoverage.coveredFiles).toContain(path);
      }
    }
  });
});

describe('planReviewUnits — semantics retention and truthful incompleteness', () => {
  test('ignored and no-patch files keep their separate semantics', async () => {
    const prFiles = [
      ghFile('keep.js', '@@ -1,1 +1,1 @@\n ctx\n+new'),
      { filename: 'gen.lock', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-lock\n+lock', sha: 's' },
      { filename: 'img.png', status: 'added', additions: 0, deletions: 0, patch: null, sha: 's' },
    ];
    const { plan } = await planFiles(prFiles, { ignore_patterns: ['*.lock'] }, { ceiling: 958016 });

    expect(plan.scope.policyExempt).toEqual([{ path: 'gen.lock', reason: 'ignore_pattern' }]);
    expect(plan.scope.unavailable).toEqual([{ path: 'img.png', reason: 'no_patch' }]);
    expect(plan.plannedCoverage.coveredFiles).toEqual(['keep.js']);
    expect(plan.plannedCoverage.policyExemptFiles).toBe(1);
    // Genuine source unavailability is truthful INCOMPLETE (A1 no_patch doctrine).
    expect(plan.plannedCoverage.complete).toBe(false);
    expect(plan.plannedCoverage.sourceUnavailableFiles).toBe(1);
  });

  test('paginationCapped scope stays truthfully incomplete', async () => {
    const scope = resolveReviewScope({
      prFiles: [ghFile('a.js', '@@ -1,1 +1,1 @@\n ctx\n+new')],
      cfg: {}, headSha: BINDING.headSha, paginationCapped: true,
    });
    const bundleParts = await buildReviewBundle({ files: scope.eligible, pr: PR, repository: REPO });
    const plan = await planReviewUnits({
      binding: BINDING, scope, bundleParts, changedFiles: bundleParts.changedFiles,
      opts: OPTS, buildRequest: buildReviewRequest, oracle: charEstimator, ceiling: 958016,
    });
    expect(plan.plannedCoverage.complete).toBe(false);
    expect(plan.plannedCoverage.paginationCapped).toBe(true);
  });
});

describe('planReviewUnits — no child authority (contract 9)', () => {
  test('units and plan carry only authority-free fields', async () => {
    const prFiles = [ghFile('a.js', '@@ -1,1 +1,2 @@\n ctx\n+new', { additions: 2 })];
    const { plan } = await planFiles(prFiles, {}, { ceiling: 958016 });

    const UNIT_KEYS = new Set([
      'unitId', 'ordinal', 'kind', 'files', 'fragments', 'estimatedRequestTokens',
      'request', 'bundleChars',
    ]);
    for (const unit of plan.units) {
      for (const key of Object.keys(unit)) expect(UNIT_KEYS.has(key)).toBe(true);
      expect(['complete', 'files', 'file_hunks', 'hunk_regions']).toContain(unit.kind);
    }
    // Structural scan with the embedded production request redacted — its
    // prompt PROSE legitimately says "verdict"; authority is about fields,
    // not the borrowed prompt text.
    const redacted = {
      ...plan,
      units: plan.units.map(({ request, ...rest }) => ({ ...rest, request: "[redacted]" })),
    };
    const serialized = JSON.stringify(redacted).toLowerCase();
    for (const forbidden of ['verdict', 'publication', 'publish', 'approval', 'check_run', 'rereview', 'supersed']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('planReviewUnits — truthful failure modes', () => {
  test('skeleton alone over the ceiling → typed error, never a fabricated plan', async () => {
    const prFiles = [ghFile('a.js', '@@ -1,1 +1,2 @@\n ctx\n+new', { additions: 2 })];
    await expect(planFiles(prFiles, {}, { ceiling: 5, oracle: async () => 1000000 }))
      .rejects.toMatchObject({ code: PLANNER_ERRORS.E_PLANNER_SKELETON_OVERFLOW });
  });

  test('a single diff line over a whole unit → typed error, never omission', async () => {
    const prFiles = [ghFile('one.js', '@@ -1,1 +1,1 @@\n' + line('+', 40000), { additions: 1 })];
    // Half the measured complete request: even one line cannot fit a unit.
    const fitting = (await planFiles(prFiles, {}, { ceiling: 958016 })).plan;
    const ceiling = Math.ceil(fitting.completeRequestTokens * 0.5);
    await expect(planFiles(prFiles, {}, { ceiling, oracle: charEstimator }))
      .rejects.toMatchObject({ code: PLANNER_ERRORS.E_PLANNER_EVIDENCE_OVERFLOW });
  });

  test('bundle/scope wiring mismatch → typed error', async () => {
    const scope = resolveReviewScope({
      prFiles: [ghFile('a.js', '@@ -1,1 +1,1 @@\n ctx\n+new'), ghFile('b.js', '@@ -1,1 +1,1 @@\n ctx\n+new')],
      cfg: {}, headSha: BINDING.headSha,
    });
    const bundleParts = await buildReviewBundle({ files: [scope.eligible[1], scope.eligible[0]], pr: PR, repository: REPO });
    await expect(planReviewUnits({
      binding: BINDING, scope, bundleParts, changedFiles: bundleParts.changedFiles,
      opts: OPTS, buildRequest: buildReviewRequest, oracle: charEstimator, ceiling: 958016,
    })).rejects.toMatchObject({ code: PLANNER_ERRORS.E_PLANNER_BUNDLE_MISMATCH });
  });
});

describe('historical reason compatibility (contract 10)', () => {
  test('patch_truncated and legacy limits render through the coverage surfaces', () => {
    const historical = {
      headSha: 'old', totalChangedFiles: 3, accountedFiles: 3,
      files: [
        { path: 'a.js', status: 'modified', coverage: 'full', reason: null },
        { path: 'b.js', status: 'modified', coverage: 'partial', reason: 'patch_truncated' },
        { path: 'c.js', status: 'modified', coverage: 'partial', reason: 'bundle_truncated' },
      ],
      limitsExceeded: ['max_lines_to_review'],
      approvalEvidenceComplete: false,
    };
    const summary = coverageSummaryLine(historical);
    expect(summary).toContain('Evidence incomplete');
    expect(summary).toContain('max_lines_to_review');

    const finalized = finalizeCoverage(historical, [
      { path: 'a.js', coverage: 'partial', reason: 'patch_truncated' },
    ]);
    expect(finalized.files.find((r) => r.path === 'a.js').reason).toBe('patch_truncated');
    expect(finalized.approvalEvidenceComplete).toBe(false);
  });
});

describe('purity guard — no side-effect imports (contract 1/2)', () => {
  test('planner and resolver import nothing that performs I/O', () => {
    // Jest cwd is packages/web.
    const plannerSrc = readFileSync('src/services/reviewPlanner.js', 'utf8');
    const resolverSrc = readFileSync('src/services/reviewScopeResolver.js', 'utf8');
    for (const [name, src] of [['reviewPlanner', plannerSrc], ['reviewScopeResolver', resolverSrc]]) {
      const imports = [...src.matchAll(/^import .*?from "(.+?)";/gm)].map((m) => m[1]);
      expect(imports.length).toBeGreaterThan(0);
      for (const spec of imports) {
        expect(spec === 'node:crypto' || spec === 'minimatch').toBe(true);
      }
    }
  });
});

describe('splitPatchIntoHunks — parsing invariants', () => {
  test('headers, coordinates and ordering are preserved', () => {
    const hunks = splitPatchIntoHunks('@@ -1,3 +1,4 @@\n ctx\n-old\n+new\n ctx\n@@ -20,2 +21,2 @@\n ctx\n-x\n+y');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 });
    expect(hunks[1]).toMatchObject({ oldStart: 20, oldCount: 2, newStart: 21, newCount: 2 });
    expect(hunks[0].lines).toEqual([' ctx', '-old', '+new', ' ctx']);
  });
});
