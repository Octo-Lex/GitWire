// tests/unit/reviewPublicationPolicy.test.js
// Frozen v1.2 publication contract: judgment / integrity / outcome / authority.
//
// The pinned WP-7 row (REQUEST_CHANGES + INCOMPLETE + no valid material
// evidence → REQUEST_CHANGES published, ADVISORY, non-blocking, COMMENT) is
// asserted explicitly below.

import {
  resolveReviewPublication,
  normalizeJudgment,
  judgmentToLegacy,
  JUDGMENTS,
  INTEGRITY_STATES,
} from '../../src/services/reviewPublicationPolicy.js';

const BLOCKING_POLICY = {
  blockOnVerdict: ['request_changes'],
  minConfidenceToBlock: 'medium',
  confidence: 'high',
};

const NO_POLICY = { blockOnVerdict: [], minConfidenceToBlock: 'medium', confidence: 'high' };

describe('normalizeJudgment', () => {
  test.each([
    ['approved', 'APPROVE'],
    ['needs_discussion', 'NEEDS_DISCUSSION'],
    ['request_changes', 'REQUEST_CHANGES'],
    ['APPROVE', 'APPROVE'],
    ['NEEDS_DISCUSSION', 'NEEDS_DISCUSSION'],
    ['REQUEST_CHANGES', 'REQUEST_CHANGES'],
  ])('maps %s → %s', (input, expected) => {
    expect(normalizeJudgment(input)).toBe(expected);
  });

  test('unknown verdict maps to null', () => {
    expect(normalizeJudgment('unknown')).toBeNull();
    expect(normalizeJudgment(undefined)).toBeNull();
  });

  test('judgmentToLegacy round-trips every judgment', () => {
    for (const j of JUDGMENTS) {
      expect(normalizeJudgment(judgmentToLegacy(j))).toBe(j);
    }
  });
});

describe('resolveReviewPublication — advisory resolution table', () => {
  test('APPROVE + COMPLETE → published APPROVE, COMMENT, ADVISORY', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'COMPLETE',
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('APPROVE');
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.authorityState).toBe('ADVISORY');
    expect(r.policyBlocked).toBe(false);
    expect(r.publicationAllowed).toBe(true);
  });

  test('APPROVE + INCOMPLETE → published INCOMPLETE (no clean approve)', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'INCOMPLETE',
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('INCOMPLETE');
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.authorityState).toBe('ADVISORY');
    expect(r.reason).toBe('evidence_incomplete_downgrade');
  });

  test('NEEDS_DISCUSSION + COMPLETE → published NEEDS_DISCUSSION, non-blocking', () => {
    const r = resolveReviewPublication({
      judgment: 'needs_discussion', integrityState: 'COMPLETE',
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('NEEDS_DISCUSSION');
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.authorityState).toBe('ADVISORY');
    expect(r.policyBlocked).toBe(false);
  });

  test('NEEDS_DISCUSSION + INCOMPLETE → published INCOMPLETE', () => {
    const r = resolveReviewPublication({
      judgment: 'needs_discussion', integrityState: 'INCOMPLETE',
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('INCOMPLETE');
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.authorityState).toBe('ADVISORY');
  });

  test('REQUEST_CHANGES + COMPLETE + valid evidence + blocking policy → POLICY_BLOCKED check consequence', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'COMPLETE',
      materialEvidenceValid: true,
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.authorityState).toBe('POLICY_BLOCKED');
    expect(r.policyBlocked).toBe(true);
  });

  test('REQUEST_CHANGES + INCOMPLETE + valid evidence → REQUEST_CHANGES survives, still blockable', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'INCOMPLETE',
      materialEvidenceValid: true,
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(r.integrityIncomplete).toBe(true);
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.policyBlocked).toBe(true);
  });

  test('PINNED WP-7 ROW: REQUEST_CHANGES + INCOMPLETE + no valid material evidence → REQUEST_CHANGES / ADVISORY / non-blocking / COMMENT', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'INCOMPLETE',
      materialEvidenceValid: false,
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.publishedOutcome).toBe('REQUEST_CHANGES');
    expect(r.authorityState).toBe('ADVISORY');
    expect(r.policyBlocked).toBe(false);
    expect(r.githubReviewEvent).toBe('COMMENT');
    expect(r.integrityIncomplete).toBe(true);
    expect(r.evidenceValid).toBe(false);
  });

  test('REQUEST_CHANGES + COMPLETE + no valid evidence → advisory even with blocking policy', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'COMPLETE',
      materialEvidenceValid: false,
      repositoryPolicy: BLOCKING_POLICY, publicationMode: 'advisory',
    });
    expect(r.policyBlocked).toBe(false);
    expect(r.authorityState).toBe('ADVISORY');
  });
});

describe('resolveReviewPublication — advisory mode never emits authority events', () => {
  test('no combination of judgment/integrity/evidence/policy yields APPROVE or REQUEST_CHANGES event', () => {
    const policies = [NO_POLICY, BLOCKING_POLICY];
    for (const judgment of JUDGMENTS) {
      for (const integrity of INTEGRITY_STATES) {
        for (const evidence of [true, false]) {
          for (const repositoryPolicy of policies) {
            const r = resolveReviewPublication({
              judgment, integrityState: integrity,
              materialEvidenceValid: evidence, repositoryPolicy,
              publicationMode: 'advisory',
            });
            expect(['COMMENT', null]).toContain(r.githubReviewEvent);
          }
        }
      }
    }
  });
});

describe('resolveReviewPublication — repository policy controls blocking', () => {
  test('confidence below the configured threshold does not block', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'COMPLETE',
      materialEvidenceValid: true,
      repositoryPolicy: {
        blockOnVerdict: ['request_changes'],
        minConfidenceToBlock: 'high',
        confidence: 'low',
      },
      publicationMode: 'advisory',
    });
    expect(r.policyBlocked).toBe(false);
    expect(r.authorityState).toBe('ADVISORY');
  });

  test('empty block_on_verdict never blocks', () => {
    const r = resolveReviewPublication({
      judgment: 'request_changes', integrityState: 'COMPLETE',
      materialEvidenceValid: true,
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.policyBlocked).toBe(false);
  });

  test('policy naming a different verdict does not block this judgment', () => {
    const r = resolveReviewPublication({
      judgment: 'needs_discussion', integrityState: 'COMPLETE',
      materialEvidenceValid: true,
      repositoryPolicy: {
        blockOnVerdict: ['request_changes'],
        minConfidenceToBlock: 'medium',
        confidence: 'high',
      },
      publicationMode: 'advisory',
    });
    expect(r.policyBlocked).toBe(false);
  });
});

describe('resolveReviewPublication — legacy_stateful rollback mode', () => {
  test('preserves the pre-advisory event mapping', () => {
    const base = { integrityState: 'COMPLETE', materialEvidenceValid: true, repositoryPolicy: NO_POLICY, publicationMode: 'legacy_stateful' };
    expect(resolveReviewPublication({ ...base, judgment: 'approved' }).githubReviewEvent).toBe('APPROVE');
    expect(resolveReviewPublication({ ...base, judgment: 'request_changes' }).githubReviewEvent).toBe('REQUEST_CHANGES');
    expect(resolveReviewPublication({ ...base, judgment: 'needs_discussion' }).githubReviewEvent).toBe('COMMENT');
  });

  test('never dresses an INCOMPLETE outcome as a GitHub APPROVE', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'INCOMPLETE',
      repositoryPolicy: NO_POLICY, publicationMode: 'legacy_stateful',
    });
    expect(r.publishedOutcome).toBe('INCOMPLETE');
    expect(r.githubReviewEvent).toBe('COMMENT');
  });

  test('unknown mode falls back to advisory', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'COMPLETE',
      repositoryPolicy: NO_POLICY, publicationMode: 'nonsense',
    });
    expect(r.publicationMode).toBe('advisory');
    expect(r.githubReviewEvent).toBe('COMMENT');
  });
});

describe('resolveReviewPublication — terminal and defensive states', () => {
  test('SUPERSEDED publishes nothing', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'SUPERSEDED',
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.publicationAllowed).toBe(false);
    expect(r.publishedOutcome).toBeNull();
    expect(r.githubReviewEvent).toBeNull();
    expect(r.reason).toBe('head_superseded');
  });

  test('FAILED publishes nothing', () => {
    const r = resolveReviewPublication({
      judgment: 'approved', integrityState: 'FAILED',
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.publicationAllowed).toBe(false);
    expect(r.githubReviewEvent).toBeNull();
    expect(r.reason).toBe('review_failed');
  });

  test('unknown or missing integrity is treated conservatively as INCOMPLETE', () => {
    const r = resolveReviewPublication({
      judgment: 'approved',
      repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
    });
    expect(r.integrityState).toBe('INCOMPLETE');
    expect(r.publishedOutcome).toBe('INCOMPLETE');
  });

  test('unknown judgment throws', () => {
    expect(() =>
      resolveReviewPublication({
        judgment: 'unknown-verdict',
        repositoryPolicy: NO_POLICY, publicationMode: 'advisory',
      })
    ).toThrow(/unknown judgment/);
  });
});
