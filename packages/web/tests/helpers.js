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
//
// MUTATIONS: every mutating request MUST reference a registered mutation
// contract by name. The policy rejects bare mutations with no contract, and
// verifies the declared fixture identity is present and correct at the
// declared location. See registerMutationContracts() below for the surface.

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

// ─── Mutation contract registry ────────────────────────────────────────────
//
// Every mutating route used by the stress suite is registered here with a
// declaration of where the fixture identity MUST appear. The policy uses these
// contracts to verify, per request, that the fixture repo / installation is
// present and correct — fail-closed. Adding a new mutation route means
// registering a contract here; unregistered mutations are rejected.

function registerMutationContracts() {
  // The contract registers ONLY when mutations are opted in — otherwise the
  // gate rejects all mutations at the opt-in check before contract lookup,
  // and these registrations are inert (the routes are never called).
  if (!POLICY.allowMutations) return;

  // Helper to build a repo-in-path contract for routes like
  // /api/repos/:owner/:repo/<suffix> or /api/fix/:owner/:repo/...
  const repoInPath = (name, method = 'POST', suffix = '') => ({
    name,
    method,
    classification: 'FIXTURE_MUTATION',
    target: { field: 'repo', location: 'path' },
    // suffix is informational only; the policy does not match full routes,
    // it only checks that the path's owner/repo == fixture.
    suffix,
  });

  const instInBody = (name, method = 'POST', bodyField = 'installation_id') => ({
    name,
    method,
    classification: 'FIXTURE_MUTATION',
    target: { field: 'installationId', location: 'body', bodyField },
  });

  const instInQuery = (name) => ({
    name,
    method: 'POST',
    classification: 'FIXTURE_MUTATION',
    target: { field: 'installationId', location: 'query' },
  });

  // Repository-in-path mutations (sync, settings, scan, config, etc.)
  POLICY.registerMutationContract(repoInPath('repo-sync'));
  POLICY.registerMutationContract(repoInPath('maintainer-settings'));
  POLICY.registerMutationContract(repoInPath('maintainer-stale-scan'));
  POLICY.registerMutationContract(repoInPath('maintainer-branch-cleanup'));
  POLICY.registerMutationContract(repoInPath('phase2-queue-config'));
  POLICY.registerMutationContract(repoInPath('phase3-dependencies-scan'));
  POLICY.registerMutationContract(repoInPath('phase3-dependencies-batch-pr'));
  POLICY.registerMutationContract(repoInPath('phase3-reconciler-repos-config', 'PUT'));
  POLICY.registerMutationContract(repoInPath('review-config'));
  POLICY.registerMutationContract(repoInPath('duplicates-backfill'));
  // fix-attempt carries installation_id in query (?installation_id=...)
  POLICY.registerMutationContract(instInQuery('fix-attempt'));
  // Routes whose mutation target is an installation_id in the body.
  POLICY.registerMutationContract(instInBody('enforcement-run'));
  POLICY.registerMutationContract(instInBody('phase3-reconciler-run'));
}
registerMutationContracts();

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
 *     and installation ID, a REGISTERED mutation contract, and consume the
 *     mutation budget.
 *
 * @param {string} path relative path or same-origin absolute URL
 * @param {Object} [options]
 * @param {string} [options.method] default GET
 * @param {Object} [options.body] request body. For mutations this MUST be an
 *   object (string bodies are rejected — the policy cannot inspect them).
 * @param {Object} [options.headers] merged on top of the auth + content-type
 *   headers. Pass `{ Authorization: '' }` to suppress the bearer token for
 *   endpoints that must not receive it (e.g. /webhooks/github).
 * @param {string} [options.contractName] REQUIRED for mutations. Name of a
 *   registered mutation contract (see registerMutationContracts above).
 * @param {string} [options.operationName] label for budget consumption.
 */
export async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // The body is passed to the policy for inspection. Object bodies are
  // inspected for embedded production identities; string bodies are rejected
  // for mutations (the policy throws). For reads, body shape is irrelevant.
  const bodyForPolicy = options.body;

  // Resolve + same-origin check + production-host check. Throws before any
  // header is built if the target is disallowed.
  const url = POLICY.resolveRequest(path);

  // Mutation gate (also throws on budget exhaustion / denylisted identity /
  // missing contract / string body / missing declared fixture identity).
  POLICY.assertMutationAllowed({
    method,
    url,
    body: bodyForPolicy,
    contractName: options.contractName,
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

  // Stringify object bodies. (String bodies for mutations were already
  // rejected above; string bodies for reads are passed through unchanged,
  // which is fine since reads carry no fixture identity to inspect.)
  const bodyToSend = options.body && typeof options.body === 'object'
    ? JSON.stringify(options.body)
    : options.body;

  const res = await fetch(url.href, { method, headers, body: bodyToSend });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/** GET request */
export async function get(path) {
  return api(path, { method: 'GET' });
}

/**
 * POST request. `contractName` is required for mutations — pass the name of
 * a registered mutation contract.
 */
export function post(path, data, opts = {}) {
  return api(path, {
    method: 'POST',
    body: data,
    contractName: opts.contractName,
    operationName: opts.operationName,
  });
}

/** PUT request. `contractName` required for mutations. */
export function put(path, data, opts = {}) {
  return api(path, {
    method: 'PUT',
    body: data,
    contractName: opts.contractName,
    operationName: opts.operationName,
  });
}

/** PATCH request. `contractName` required for mutations. */
export function patch(path, data, opts = {}) {
  return api(path, {
    method: 'PATCH',
    body: data,
    contractName: opts.contractName,
    operationName: opts.operationName,
  });
}

/** DELETE request. `contractName` required for mutations. */
export function del(path, opts = {}) {
  return api(path, {
    method: 'DELETE',
    contractName: opts.contractName,
    operationName: opts.operationName,
  });
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
