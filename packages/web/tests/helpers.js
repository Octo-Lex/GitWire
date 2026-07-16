// tests/helpers.js
// Shared test utilities for GitWire API integration tests.
//
// SECURITY: No production URL or credential defaults. All configuration
// must be provided via environment variables. The harness refuses to load
// unless GITWIRE_STRESS_ENV=isolated is set, and rejects known production
// hostnames regardless of configuration.

// Known production hostnames that must NEVER be targeted by tests.
// This is a denylist of known production targets, not a full identity verification.
const PRODUCTION_HOSTS = new Set([
  'gitwire.erlab.uk',
]);

function requireEnv(name) {
  const val = process.env[name];
  if (!val || val.length === 0) {
    throw new Error(
      `${name} environment variable is required. Tests will not run without explicit configuration.`
    );
  }
  return val;
}

function validateBaseUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`GITWIRE_BASE_URL is not a valid URL: ${url}`);
  }
  if (PRODUCTION_HOSTS.has(hostname)) {
    throw new Error(
      `GITWIRE_BASE_URL hostname '${hostname}' is a known production target. ` +
      `Tests must target an isolated environment.`
    );
  }
  return url;
}

// Require explicit environment — no defaults.
const BASE_URL = validateBaseUrl(requireEnv('GITWIRE_BASE_URL'));
const API_KEY  = requireEnv('API_KEY');

// Stress tests require an additional safety gate.
const STRESS_ENV = process.env.GITWIRE_STRESS_ENV;
if (STRESS_ENV !== 'isolated') {
  throw new Error(
    'Stress and integration tests require GITWIRE_STRESS_ENV=isolated. ' +
    'This prevents accidental execution against non-isolated environments.'
  );
}

// Mutation tests require an explicit opt-in.
const ALLOW_MUTATIONS = process.env.GITWIRE_STRESS_ALLOW_MUTATIONS === 'true';
const FIXTURE_REPO = process.env.GITWIRE_STRESS_FIXTURE_REPO || null;

if (ALLOW_MUTATIONS && !FIXTURE_REPO) {
  throw new Error(
    'GITWIRE_STRESS_ALLOW_MUTATIONS=true requires GITWIRE_STRESS_FIXTURE_REPO ' +
    'to be set to a disposable owner/repo.'
  );
}

/**
 * Block mutating requests unless the mutation opt-in is configured.
 * This is enforced centrally in the api() helper so individual test
 * suites cannot accidentally bypass the gate.
 */
function assertMutationAllowed(method) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;

  if (!ALLOW_MUTATIONS) {
    throw new Error(
      `${method} requests require GITWIRE_STRESS_ALLOW_MUTATIONS=true`
    );
  }
  if (!FIXTURE_REPO) {
    throw new Error(
      "Mutation requests require GITWIRE_STRESS_FIXTURE_REPO to be set to a disposable owner/repo."
    );
  }
}

export { ALLOW_MUTATIONS, FIXTURE_REPO };

/**
 * Fetch wrapper with API key auth. Returns parsed JSON + status.
 * Mutating methods (POST/PUT/PATCH/DELETE) are blocked unless
 * GITWIRE_STRESS_ALLOW_MUTATIONS=true and GITWIRE_STRESS_FIXTURE_REPO are set.
 */
export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  assertMutationAllowed(method);

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
