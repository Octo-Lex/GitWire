// tests/unit/provider-budget-regression.test.js
// Unit A regression: pin all nine provider-budget values so no accidental
// change can silently reduce them below the thinking-model demand measured
// during the 2026-08-28 incident investigation.
//
// The Z.AI endpoint now routes every model string to a thinking model that
// emits reasoning blocks before text. At the old budgets, the thinking alone
// consumed the entire max_tokens allocation, producing empty responses and
// taking down both the review and triage pipelines for ~2 days.

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
    { file: 'services/aiReviewService.js', value: 'max_tokens: 16384,', label: 'runStructuredReview (main review)', old: 'max_tokens: 4096,' },
    { file: 'services/adversarialReview.js', value: 'max_tokens: 8192,', label: 'adversarialReview', old: 'max_tokens: 2048,' },
    { file: 'services/adversarialDefense.js', value: 'max_tokens: 8192,', label: 'adversarialDefense', old: 'max_tokens: 2048,' },
    { file: 'services/flakyTestService.js', value: 'max_tokens: 8192,', label: 'flakyTestService', old: 'max_tokens: 2048,' },
    { file: 'services/configValidationService.js', value: 'max_tokens: 4096,', label: 'configValidationService', old: 'max_tokens: 1024,' },
    { file: 'workers/ciHealWorker.js', value: 'max_tokens: 16384,', label: 'ciHealWorker (heal generation)', old: 'max_tokens: 512,' },
    { file: 'workers/ciHealWorker.js', value: 'max_tokens: 4096,', label: 'ciHealWorker (log analysis)', old: 'max_tokens: 512,' },
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

  it('review duration default: 600 seconds (not 300)', () => {
    const src = readSrc('services/aiReviewService.js');
    expect(src).toContain('DEFAULT_MAX_DURATION_MS = 600000');
    expect(src).not.toContain('DEFAULT_MAX_DURATION_MS = 300000');
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
