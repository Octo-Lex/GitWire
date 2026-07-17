// tests/helpers.js
// Shared test utilities for GitWire API integration tests.
//
// SECURITY: No production URL or credential defaults. All configuration
// must be provided via environment variables. The harness refuses to load
// unless GITWIRE_STRESS_ENV=isolated is set, and rejects known production
// hostnames, repositories, and installation IDs regardless of configuration.
//
// This module delegates URL resolution, the production denylist, mutation
// gating, and the mutation budget to tests/target-policy.js — the same module
// scripts/benchmark.js uses. The contract is therefore identical across the
// Jest stress suite and the benchmark harness.

import { loadPolicy } from './target-policy.js';

// Load once at module import. Any missing env var or denylisted target
// throws here, so a misconfigured run fails before any request is attempted.
const POLICY = loadPolicy({ requireStressGate: true });

// Re-export the base URL and API key for tests that construct raw requests
// (e.g. webhook tests that must NOT send the bearer token). These come from
// the validated policy, not directly from env.
const BASE_URL = POLICY.baseUrlRaw;
const API_KEY = POLICY.apiKey;

// Mutation opt-in state (read by some stress files).
const ALLOW_MUTATIONS = POLICY.allowMutations;
const FIXTURE_REPO = POLICY.fixtureRepo;
const FIXTURE_INSTALLATION_ID = POLICY.fixtureInstallationId;

export { BASE_URL, API_KEY, ALLOW_MUTATIONS, FIXTURE_REPO, FIXTURE_INSTALLATION_ID };

/**
 * Fetch wrapper with API key auth. Returns parsed JSON + status.
 *
 * URL resolution and mutation gating are delegated to the shared target
 * policy:
 *   - Relative paths resolve against the validated base URL.
 *   - Absolute URLs must be same-origin with the base URL; cross-origin
 *     requests throw BEFORE any header is constructed or fetch is called.
 *   - Mutating methods (POST/PUT/PATCH/DELETE) require
 *     GITWIRE_STRESS_ALLOW_MUTATIONS=true plus a configured fixture repo
 *     and installation ID, and consume the mutation budget.
 *
 * @param {string} path relative path or same-origin absolute URL
 * @param {Object} [options]
 * @param {string} [options.method] default GET
 * @param {Object} [options.body] parsed JSON body; when provided as an
 *   object it is JSON.stringified and the policy inspects it for denylisted
 *   identities. When provided as a string it is sent as-is (the policy
 *   cannot inspect it; callers using string bodies are responsible for not
 *   embedding production identities).
 * @param {Object} [options.headers] merged on top of the auth + content-type
 *   headers. Pass `{ Authorization: '' }` to suppress the bearer token for
 *   endpoints that must not receive it (e.g. /webhooks/github).
 * @param {Object} [options.contract] declared mutation target contract
 *   (see target-policy.js MutationTargetContract).
 * @param {string} [options.operationName] label for budget consumption.
 */
export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  let parsedBody = null;
  if (options.body && typeof options.body === 'object') {
    parsedBody = options.body;
  }

  // Resolve + same-origin check + production-host check. Throws before any
  // header is built if the target is disallowed.
  const url = POLICY.resolveRequest(path);

  // Mutation gate (also throws on budget exhaustion / denylisted identity
  // anywhere in path/query/body).
  POLICY.assertMutationAllowed({
    method,
    url,
    body: parsedBody,
    contract: options.contract,
    operationName: options.operationName,
  });

  // Construct headers ONLY after all policy checks pass. This is what makes
  // the absolute-URL bypass safe: a rejected request never produces a
  // credential string.
  const authHeader = options.headers && Object.keys(options.headers).some(
    h => h.toLowerCase() === 'authorization'
  ) ? {} : (POLICY.authHeader() ? { Authorization: POLICY.authHeader() } : {});

  const headers = {
    'Content-Type': 'application/json',
    ...authHeader,
    ...options.headers,
  };

  const res = await fetch(url.href, {
    method,
    headers,
    body: parsedBody ? JSON.stringify(parsedBody) : options.body,
  });
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
export function post(path, data, opts = {}) {
  return api(path, {
    method: 'POST',
    body: data,
    contract: opts.contract,
    operationName: opts.operationName,
  });
}

/** PUT request */
export function put(path, data) {
  return api(path, { method: 'PUT', body: data });
}

/** PATCH request */
export function patch(path, data) {
  return api(path, { method: 'PATCH', body: data });
}

/** DELETE request */
export function del(path) {
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
