// tests/unit/provider-budget-regression.test.js
// Unit A regression: pin all nine provider-budget values so no accidental
// change can silently reduce them below the thinking-model demand measured
// during the 2026-08-28 incident investigation.
//
// The Z.AI endpoint now routes every model string to a thinking model that
// emits reasoning blocks before text. At the old budgets, the thinking alone
// consumed the entire max_tokens allocation, producing empty responses and
// taking down both the review and triage pipelines for ~2 days.
//
// RC-01 (2026-08-30) raised the main review ceiling 16,384 -> 32,768 after a
// production-shaped bundle exhausted the 16,384 budget (19,746 output tokens
// demanded, empty output). The same change bound the Anthropic client
// transport at 600,000 ms so the SDK permits the larger non-streaming
// request; the behavioral proof lives in service-ai-review.test.js.

import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

// Read the actual source files and verify the constants are what we expect.
// This approach is robust against import-order issues and tests the shipped
// source directly.

function readSrc(relPath) {
  return readFileSync(new URL('../../src/' + relPath, import.meta.url), 'utf-8');
}

describe('provider output-budget regression (Unit A)', () => {
  const EXPECTED = [
    { file: 'services/aiReviewService.js', value: 'max_tokens: 32768,', label: 'runStructuredReview (main review, RC-01)', old: 'max_tokens: 16384,' },
    { file: 'services/adversarialReview.js', value: 'max_tokens: 8192,', label: 'adversarialReview', old: 'max_tokens: 2048,' },
    { file: 'services/adversarialDefense.js', value: 'max_tokens: 8192,', label: 'adversarialDefense', old: 'max_tokens: 2048,' },
    { file: 'services/flakyTestService.js', value: 'max_tokens: 8192,', label: 'flakyTestService', old: 'max_tokens: 2048,' },
    { file: 'services/configValidationService.js', value: 'max_tokens: 4096,', label: 'configValidationService', old: 'max_tokens: 1024,' },
  ];

  for (const exp of EXPECTED) {
    it(`${exp.label}: ${exp.value} present, old value absent`, () => {
      const src = readSrc(exp.file);
      expect(src).toContain(exp.value);
      expect(src).not.toContain(exp.old);
    });
  }

  it('triageWorker: both call sites at max_tokens 4096 (no 512 remaining)', () => {
    const src = readSrc('workers/triageWorker.js');
    expect(src).not.toContain('max_tokens: 512,');
    const count = (src.match(/max_tokens: 4096,/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2); // issue triage + PR triage
  });

  it('review duration fallback: 600 seconds (not 300)', () => {
    const src = readSrc('services/aiReviewService.js');
    expect(src).toContain('DEFAULT_MAX_DURATION_MS = 600000');
    expect(src).not.toContain('DEFAULT_MAX_DURATION_MS = 300000');
  });

  it('Anthropic client transport timeout: 600000 ms (RC-01)', () => {
    // Pin the transport bound explicitly to the 600 s review deadline so it
    // never rides on SDK defaults. Behavioral proof: service-ai-review.test.js.
    const src = readSrc('services/aiReviewService.js');
    expect(src).toContain('timeout:  600000,');
  });

  // ── ciHealWorker: two provider call sites in one file ────────────────────
  // Whole-file presence/absence checks cannot prove the two sites
  // independently (both values occur in the same file, and the heal site's
  // old value 4096 is the log site's new value). Scope each assertion to a
  // window anchored at `anthropic.messages.create(` and identified by that
  // call's unique system prompt.
  function providerCallSites(src) {
    return src
      .split('anthropic.messages.create(')
      .slice(1)
      .map((chunk) => chunk.slice(0, 700));
  }

  it('ciHealWorker heal generation site: max_tokens 16384 (old value 4096 absent at that site)', () => {
    const sites = providerCallSites(readSrc('workers/ciHealWorker.js'));
    expect(sites).toHaveLength(2); // heal generation + log analysis — no third unclassified site
    const heal = sites.find((s) => s.includes('Fix CI failures with minimal, precise changes'));
    expect(heal).toBeDefined();
    expect(heal).toContain('max_tokens: 16384,');
    expect(heal).not.toContain('max_tokens: 4096,');
  });

  it('ciHealWorker log analysis site: max_tokens 4096 (old value 512 absent at that site)', () => {
    const sites = providerCallSites(readSrc('workers/ciHealWorker.js'));
    const logs = sites.find((s) => s.includes('CI failure analysis expert'));
    expect(logs).toBeDefined();
    expect(logs).toContain('max_tokens: 4096,');
    expect(logs).not.toContain('max_tokens: 512,');
    expect(logs).not.toContain('max_tokens: 16384,');
  });

  // ── Effective review timeout: the persisted configuration path ───────────
  // The review path resolves its timeout from the ai_review_config row
  // (cfg.max_duration_seconds), so the 600-second service fallback is
  // bypassed for every activated repository. The route default and the
  // schema default must both be 600, and existing 300-second rows must be
  // migrated; otherwise the fallback pin above is moot in production.
  it('config route defaults new rows to max_duration_seconds 600 (not 300)', () => {
    const src = readSrc('routes/phase4.js');
    expect(src).toContain('max_duration_seconds ?? 600,');
    expect(src).not.toContain('max_duration_seconds ?? 300,');
  });

  it('migration 044 raises the schema default and migrates existing 300-second rows', () => {
    const sql = readFileSync(
      new URL('../../db/migrations/044_review_duration_600.sql', import.meta.url),
      'utf-8'
    );
    expect(sql).toContain('ALTER COLUMN max_duration_seconds SET DEFAULT 600');
    expect(sql).toMatch(
      /UPDATE\s+ai_review_config\s+SET\s+max_duration_seconds\s*=\s*600\s+WHERE\s+max_duration_seconds\s*=\s*300/i
    );
  });

  it('no reasoning_effort parameter was added', () => {
    // The scenario matrix proved reasoning_effort does not reduce thinking
    // on review prompts. It must not appear in any provider call.
    const files = [
      'services/aiReviewService.js',
      'services/adversarialReview.js',
      'services/adversarialDefense.js',
      'workers/triageWorker.js',
      'workers/ciHealWorker.js',
      'services/flakyTestService.js',
      'services/configValidationService.js',
    ];
    for (const f of files) {
      expect(readSrc(f)).not.toContain('reasoning_effort');
    }
  });

  it('model strings unchanged (claude-sonnet-4-20250514)', () => {
    // The intervention changes budgets only, not the model identity.
    const src = readSrc('services/aiReviewService.js');
    expect(src).toContain('claude-sonnet-4-20250514');
    expect(src).not.toContain('glm-');
  });
});
