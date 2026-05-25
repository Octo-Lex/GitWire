// tests/api-fetcher.test.ts
// Test the SWR fetcher — verifies URL construction, error handling, JSON parsing.
// Auth is via httpOnly cookies (credentials: "include"), not Bearer headers.

import { jest } from '@jest/globals';

process.env.NEXT_PUBLIC_API_URL = 'https://test.local';

describe('SWR fetcher', () => {
  let fetchCalls: Array<{ url: string; opts?: RequestInit }> = [];

  beforeEach(() => {
    fetchCalls = [];
    (globalThis as any).fetch = async (url: string, opts?: RequestInit) => {
      fetchCalls.push({ url: String(url), opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: 'test' }),
      };
    };
  });

  test('fetcher sends credentials: include for cookie auth', async () => {
    const { fetcher } = await import('../src/lib/api');
    await fetcher('/api/repos');
    expect(fetchCalls[0].opts?.credentials).toBe('include');
  });

  test('fetcher prepends BASE URL', async () => {
    const { fetcher } = await import('../src/lib/api');
    await fetcher('/api/repos');
    expect(fetchCalls[0].url).toBe('https://test.local/api/repos');
  });

  test('fetcher throws on non-ok response', async () => {
    (globalThis as any).fetch = async (url: string) => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found' }),
    });
    const { fetcher } = await import('../src/lib/api');
    await expect(fetcher('/api/repos/missing')).rejects.toThrow('API error 404');
  });

  test('fetcher returns parsed JSON', async () => {
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ repos: [{ name: 'test' }] }),
    });
    const { fetcher } = await import('../src/lib/api');
    const result = await fetcher('/api/repos');
    expect(result).toEqual({ repos: [{ name: 'test' }] });
  });
});
