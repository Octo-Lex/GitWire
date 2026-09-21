// tests/unit/phase4-trigger-route.test.js
// PC-01 v2.1: the dashboard on-demand trigger enqueues a Phase-4 manual job
// instead of calling reviewPR directly, so BullMQ owns bounded retries for
// transient provider failures. The { started: true, pr } contract is
// unchanged, and repeated explicit triggers remain legitimate separate runs
// (the manual job carries no PR+SHA idempotency marker).

import { jest } from '@jest/globals';
import express from 'express';

const mockQuery = jest.fn();
const mockGetInstallationClient = jest.fn();
const mockQueueAdd = jest.fn();

await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/github.js', () => ({ getInstallationClient: mockGetInstallationClient }));
await jest.unstable_mockModule('../../src/lib/githubWrapper.js', () => ({ wrapOctokit: (c) => c }));
await jest.unstable_mockModule('../../src/lib/queue.js', () => ({
  phase4Queue: { add: mockQueueAdd },
}));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { phase4Router } = await import('../../src/routes/phase4.js');
const { default: request } = await import('supertest');

const app = express();
app.use(express.json());
app.use('/api', phase4Router);

const REPO_ROW = {
  github_id: 999, full_name: 'org/repo', owner: 'org', name: 'repo',
  default_branch: 'main', installation_id: 11111,
};

const PR = { number: 16, head: { sha: 'abc123' }, base: { ref: 'main' }, user: { login: 'contributor' }, title: 't' };

beforeEach(() => {
  mockQuery.mockReset();
  mockQueueAdd.mockReset();
  mockGetInstallationClient.mockReset();
  mockQueueAdd.mockResolvedValue({ id: 'j1' });
  mockGetInstallationClient.mockResolvedValue({
    request: jest.fn(async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: PR };
      return { data: {} };
    }),
  });
});

describe('POST /api/review/trigger — queue-owned manual review (PC-01 v2.1)', () => {
  test('responds { started: true, pr } and enqueues an ai-review-manual job with the fetched PR', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [REPO_ROW] });

    const res = await request(app).post('/api/review/trigger/org/repo/16').expect(200);
    expect(res.body).toEqual({ started: true, pr: 16 });

    // The PR fetch and enqueue happen after the response — let the microtasks settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('ai-review-manual');
    expect(opts).toEqual({ priority: 1 });
    expect(data.pr).toEqual(PR);
    expect(data.repository.id).toBe(999);
    expect(data.repository.owner).toEqual({ login: 'org' });
    expect(data.installation).toEqual({ id: 11111 });
  });

  test('unknown repository still 404s without enqueueing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).post('/api/review/trigger/org/other/16').expect(404);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('repeated triggers enqueue independent jobs (no dedupe identity)', async () => {
    mockQuery.mockResolvedValue({ rows: [REPO_ROW] });
    await request(app).post('/api/review/trigger/org/repo/16').expect(200);
    await new Promise((r) => setTimeout(r, 10));
    await request(app).post('/api/review/trigger/org/repo/16').expect(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    for (const [name] of mockQueueAdd.mock.calls) expect(name).toBe('ai-review-manual');
  });
});
