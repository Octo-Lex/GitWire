// tests/helpers.js
// Shared test utilities for GitWire API integration tests.
// Tests run against the live production API at GITWIRE_BASE_URL.

const BASE_URL = process.env.GITWIRE_BASE_URL || 'https://gitwire.erlab.uk';
const API_KEY  = process.env.API_KEY || '5339e850a33c40f292e9e7ef6a70240fa566b21f38544b6d';

/**
 * Fetch wrapper with API key auth. Returns parsed JSON + status.
 */
export async function api(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/** GET request */
export async function get(path) {
  return api(path, { method: 'GET' });
}

/** POST request */
export async function post(path, data) {
  return api(path, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** PUT request */
export async function put(path, data) {
  return api(path, { method: 'PUT', body: data ? JSON.stringify(data) : undefined });
}

/** PATCH request */
export async function patch(path, data) {
  return api(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined });
}

/** DELETE request */
export async function del(path) {
  return api(path, { method: 'DELETE' });
}

/** Assert status is 200 */
export function expectOk(res) {
  if (res.status !== 200) {
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`);
  }
  return res;
}

/** Assert status is in expected range */
export function expectStatus(res, expected) {
  if (res.status !== expected) {
    throw new Error(`Expected ${expected}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`);
  }
  return res;
}

/** Check body has expected structure */
export function expectShape(body, requiredKeys) {
  for (const key of requiredKeys) {
    if (!(key in body)) {
      throw new Error(`Missing key "${key}" in body: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }
  return body;
}

export { BASE_URL, API_KEY };
