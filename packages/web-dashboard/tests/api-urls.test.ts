// tests/api-urls.test.ts
// Test API URL builder object — verifies all URL generation
import { API } from '../src/lib/api';

describe('API URL builders', () => {
  test('insights returns correct path', () => {
    expect(API.insights()).toBe('/api/insights/overview');
  });

  test('repos without query', () => {
    expect(API.repos()).toBe('/api/repos');
  });

  test('repos with query', () => {
    expect(API.repos('page=2&limit=10')).toBe('/api/repos?page=2&limit=10');
  });

  test('repo detail path', () => {
    expect(API.repo('o', 'r')).toBe('/api/repos/o/r');
  });

  test('issues with query', () => {
    expect(API.issues('repo=o/r')).toBe('/api/issues?repo=o/r');
  });

  test('prs without query', () => {
    expect(API.prs()).toBe('/api/pull-requests');
  });

  test('ci runs with query', () => {
    expect(API.ciRuns('limit=5')).toBe('/api/ci/?limit=5');
  });

  test('maintainer settings path', () => {
    expect(API.maintainerSettings('o', 'r')).toBe('/api/maintainer/o/r/settings');
  });

  test('maintainer actions path with query', () => {
    expect(API.maintainerActions('o', 'r', 'page=1')).toBe('/api/maintainer/o/r/actions?page=1');
  });

  test('heal history with query', () => {
    expect(API.healHistory('limit=10')).toBe('/api/heal?limit=10');
  });

  test('fix attempts path', () => {
    expect(API.fixAttempts('o', 'r')).toBe('/api/fix/o/r/attempts');
  });

  test('duplicates with query', () => {
    expect(API.duplicates('page=2')).toBe('/api/duplicates?page=2');
  });

  test('enforcement policies', () => {
    expect(API.enforcementPolicies()).toBe('/api/enforcement/policies');
  });

  test('queue repo path', () => {
    expect(API.queueRepo('o', 'r')).toBe('/api/phase2/queue/o/r');
  });

  test('feedback rules', () => {
    expect(API.feedbackRules()).toBe('/api/phase2/feedback');
  });

  test('flaky tests with query', () => {
    expect(API.flakyTests('page=1')).toBe('/api/phase3/flaky?page=1');
  });

  test('dep repo path', () => {
    expect(API.depRepo('o', 'r')).toBe('/api/phase3/dependencies/o/r');
  });

  test('review config path', () => {
    expect(API.reviewConfig('o', 'r')).toBe('/api/review/config/o/r');
  });

  test('audit stats with days', () => {
    expect(API.auditStats(60)).toBe('/api/audit/stats?days=60');
  });

  test('audit report by id', () => {
    expect(API.auditReport(42)).toBe('/api/audit/reports/42');
  });
});
