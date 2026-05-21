// tests/helpers/mock-fetch.ts
// Mock global fetch for dashboard API client tests

type MockResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

const calls: Array<{ url: string; opts?: RequestInit }> = [];
let responses: Map<string, MockResponse> = new Map();
let defaultResponse: MockResponse = {
  ok: true,
  status: 200,
  json: async () => ({}),
};

export function mockFetchSetup() {
  calls.length = 0;
  responses.clear();
  defaultResponse = { ok: true, status: 200, json: async () => ({}) };

  (globalThis as any).fetch = async (url: string, opts?: RequestInit) => {
    calls.push({ url: String(url), opts });
    const match = responses.get(String(url));
    if (match) return match;
    return defaultResponse;
  };
}

export function setDefaultResponse(status: number, body: unknown) {
  defaultResponse = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

export function mockResponse(urlPattern: string | RegExp, status: number, body: unknown) {
  // For exact match
  if (typeof urlPattern === 'string') {
    responses.set(urlPattern, {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
  }
}

export function getCalls() { return calls; }
export function getLastCall() { return calls[calls.length - 1]; }
export function resetCalls() { calls.length = 0; }
