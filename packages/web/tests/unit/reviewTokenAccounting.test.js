// tests/unit/reviewTokenAccounting.test.js
// PC-01 v2.1: the frozen input ceiling, the exact count_tokens client
// (no fallback), and the seven-way provider rejection classification.

import { jest } from '@jest/globals';

const mockCountTokens = jest.fn();

await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = { countTokens: (body) => mockCountTokens(body) };
    }
  },
}));

await jest.unstable_mockModule('../../config/index.js', () => ({
  config: { server: { env: 'test' }, anthropic: { apiKey: 'test', baseURL: 'http://test' } },
}));

await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

const {
  MAX_PRIMARY_INPUT_TOKENS,
  REJECTION_CLASSES,
  classifyProviderRejection,
  countInputTokens,
  isPromptTooLongRejection,
} = await import('../../src/services/reviewTokenAccounting.js');

describe('MAX_PRIMARY_INPUT_TOKENS (frozen PC-01 v2.1 constant)', () => {
  test('derives from 1,000,000 − 32,768 − 9,216', () => {
    expect(MAX_PRIMARY_INPUT_TOKENS).toBe(1000000 - 32768 - 9216);
    expect(MAX_PRIMARY_INPUT_TOKENS).toBe(958016);
  });
  test('stays below the empirically accepted 958,682 (preflight 2026-09-21)', () => {
    expect(MAX_PRIMARY_INPUT_TOKENS).toBeLessThan(958682);
  });
});

describe('countInputTokens', () => {
  beforeEach(() => mockCountTokens.mockReset());

  test('returns the exact provider count for the given model/system/message', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 4068 });
    const n = await countInputTokens({ model: 'claude-sonnet-4-20250514', system: 'SYS', userPrompt: 'BODY' });
    expect(n).toBe(4068);
    expect(mockCountTokens).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-20250514',
      system: 'SYS',
      messages: [{ role: 'user', content: 'BODY' }],
    });
  });

  test('omits system when absent', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 5 });
    await countInputTokens({ model: 'm', userPrompt: 'x' });
    const body = mockCountTokens.mock.calls[0][0];
    expect('system' in body).toBe(false);
  });

  test('non-numeric count is a failure, not a guess', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: NaN });
    await expect(countInputTokens({ model: 'm', userPrompt: 'x' }))
      .rejects.toMatchObject({ gitwireErrorCode: 'E_TOKEN_COUNT_FAILED' });
  });

  test('endpoint failure wraps as E_TOKEN_COUNT_FAILED with the rejection class attached — no fallback value', async () => {
    const apiErr = new Error('Connection error.');
    apiErr.name = 'APIConnectionError';
    mockCountTokens.mockRejectedValueOnce(apiErr);
    await expect(countInputTokens({ model: 'm', userPrompt: 'x' }))
      .rejects.toMatchObject({ gitwireErrorCode: 'E_TOKEN_COUNT_FAILED', gitwireRejectionClass: 'transport' });
  });
});

describe('classifyProviderRejection — seven-way taxonomy', () => {
  const gwError = (status, code, message) => {
    const e = new Error(message);
    e.status = status;
    e.error = { error: { code } };
    return e;
  };

  test('context_limit: gateway 1261 prompt-too-long (measured preflight error)', () => {
    expect(classifyProviderRejection(gwError(400, 1261, '[1261][prompt is too long][...]'))).toBe('context_limit');
  });
  test('context_limit: gateway 1210 illegal max_tokens (output-contract violation)', () => {
    expect(classifyProviderRejection(gwError(400, 1210, '[1210][The max_tokens parameter is illegal...]'))).toBe('context_limit');
  });
  test('context_limit: message text fallback for prompt-too-long', () => {
    const e = new Error('prompt is too long: 1200000 > 1000000');
    e.status = 400;
    expect(classifyProviderRejection(e)).toBe('context_limit');
  });
  test('quota: 429 naming credits/plan limits', () => {
    expect(classifyProviderRejection(gwError(429, null, 'Coding Plan credit window exhausted'))).toBe('quota');
  });
  test('rate_limit: any other 429', () => {
    expect(classifyProviderRejection(gwError(429, null, 'Too many requests'))).toBe('rate_limit');
  });
  test('auth_entitlement: 401 and 403', () => {
    expect(classifyProviderRejection(gwError(401, null, 'invalid x-api-key'))).toBe('auth_entitlement');
    expect(classifyProviderRejection(gwError(403, null, 'not allowed'))).toBe('auth_entitlement');
  });
  test('timeout: SDK timeout error name, ETIMEDOUT, 408, or timeout message', () => {
    const t1 = new Error('Request timed out'); t1.name = 'APIConnectionTimeoutError';
    expect(classifyProviderRejection(t1)).toBe('timeout');
    const t2 = new Error('connect'); t2.code = 'ETIMEDOUT';
    expect(classifyProviderRejection(t2)).toBe('timeout');
    expect(classifyProviderRejection(gwError(408, null, 'request timeout'))).toBe('timeout');
    expect(classifyProviderRejection(new Error('Request body timed out'))).toBe('timeout');
  });
  test('transport: SDK connection error, socket/DNS codes, 5xx and 529', () => {
    const c1 = new Error('Connection error.'); c1.name = 'APIConnectionError';
    expect(classifyProviderRejection(c1)).toBe('transport');
    const c2 = new Error('reset'); c2.code = 'ECONNRESET';
    expect(classifyProviderRejection(c2)).toBe('transport');
    expect(classifyProviderRejection(gwError(503, null, 'upstream'))).toBe('transport');
    expect(classifyProviderRejection(gwError(529, null, 'overloaded'))).toBe('transport');
  });
  test('other: everything else, including null', () => {
    expect(classifyProviderRejection(gwError(418, null, "I'm a teapot"))).toBe('other');
    expect(classifyProviderRejection(new Error('weird'))).toBe('other');
    expect(classifyProviderRejection(null)).toBe('other');
  });
  test('the taxonomy is exactly the seven frozen classes', () => {
    expect(REJECTION_CLASSES).toEqual([
      'context_limit', 'timeout', 'rate_limit', 'quota',
      'auth_entitlement', 'transport', 'other',
    ]);
  });
});

describe('countInputTokens — over-limit semantics (PC-01 v2.1 amendment)', () => {
  beforeEach(() => mockCountTokens.mockReset());

  test('gateway 1261 prompt-too-long returns Infinity — definitively over, not an error', async () => {
    const e = new Error('[1261][prompt is too long][req]');
    e.status = 400;
    e.error = { error: { code: 1261 } };
    mockCountTokens.mockRejectedValueOnce(e);
    await expect(countInputTokens({ model: 'm', userPrompt: 'x' })).resolves.toBe(Infinity);
  });

  test('message-text prompt-too-long (no gateway code) also returns Infinity', async () => {
    const e = new Error('prompt is too long: 1200000 > 1000000');
    e.status = 400;
    mockCountTokens.mockRejectedValueOnce(e);
    await expect(countInputTokens({ model: 'm', userPrompt: 'x' })).resolves.toBe(Infinity);
  });

  test('gateway 1210 (illegal max_tokens) is NOT over-limit for counting — throws', async () => {
    const e = new Error('[1210][The max_tokens parameter is illegal]');
    e.status = 400;
    e.error = { error: { code: 1210 } };
    mockCountTokens.mockRejectedValueOnce(e);
    await expect(countInputTokens({ model: 'm', userPrompt: 'x' }))
      .rejects.toMatchObject({ gitwireErrorCode: 'E_TOKEN_COUNT_FAILED' });
  });

  test('isPromptTooLongRejection: only 400 + (code 1261 or prompt-too-long text)', () => {
    const mk = (status, code, msg) => { const e = new Error(msg); e.status = status; e.error = { error: { code } }; return e; };
    expect(isPromptTooLongRejection(mk(400, 1261, 'x'))).toBe(true);
    expect(isPromptTooLongRejection(mk(400, null, 'prompt is too long'))).toBe(true);
    expect(isPromptTooLongRejection(mk(400, 1210, 'max_tokens illegal'))).toBe(false);
    expect(isPromptTooLongRejection(mk(429, 1261, 'x'))).toBe(false);
    expect(isPromptTooLongRejection(null)).toBe(false);
  });
});
