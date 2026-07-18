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
import { httpOperation, retryingHttpOperation } from './stress/burst-runner.js';

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

  // Each contract declares an anchored route template and the list of
  // fixture identities the route carries. The policy matches the route
  // exactly (rejecting mismatches before budget consumption) and validates
  // EVERY declared identity against the configured fixture.

  // repo-in-path routes: :owner/:repo segment pair, repo identity in path.
  const repoInPath = (name, routeSuffix, method = 'POST') => ({
    name,
    method,
    classification: 'FIXTURE_MUTATION',
    route: `/api/repos/:owner/:repo${routeSuffix}`,
    identities: [{ field: 'repo', location: 'path', param: 'owner' }],
  });
  // The maintainer/phase2-queue/phase3-deps/review-config routes share the
  // :owner/:repo shape but under different route prefixes.
  const ownerRepoUnder = (name, prefix, routeSuffix, method = 'POST') => ({
    name,
    method,
    classification: 'FIXTURE_MUTATION',
    route: `${prefix}/:owner/:repo${routeSuffix}`,
    identities: [{ field: 'repo', location: 'path', param: 'owner' }],
  });

  POLICY.registerMutationContract(repoInPath('repo-sync', '/sync'));
  POLICY.registerMutationContract(ownerRepoUnder('maintainer-settings', '/api/maintainer', '/settings', 'PATCH'));
  POLICY.registerMutationContract(ownerRepoUnder('maintainer-stale-scan', '/api/maintainer', '/stale-scan'));
  POLICY.registerMutationContract(ownerRepoUnder('maintainer-branch-cleanup', '/api/maintainer', '/branch-cleanup'));
  POLICY.registerMutationContract(ownerRepoUnder('phase2-queue-config', '/api/phase2/queue', '/config'));
  POLICY.registerMutationContract(ownerRepoUnder('phase3-dependencies-scan', '/api/phase3/dependencies', '/scan'));
  POLICY.registerMutationContract(ownerRepoUnder('phase3-dependencies-batch-pr', '/api/phase3/dependencies', '/batch-pr'));
  POLICY.registerMutationContract(ownerRepoUnder('phase3-reconciler-repos-config', '/api/phase3/reconciler/repos', '', 'PUT'));
  POLICY.registerMutationContract(ownerRepoUnder('review-config', '/api/review/config', ''));
  POLICY.registerMutationContract(ownerRepoUnder('duplicates-backfill', '/api/duplicates/backfill', ''));

  // fix-attempt: repo in path AND installation_id in query. Both identities
  // are declared and both are validated — this closes the bypass where an
  // undeclared repo in the path could target a non-fixture resource.
  POLICY.registerMutationContract({
    name: 'fix-attempt',
    method: 'POST',
    classification: 'FIXTURE_MUTATION',
    route: '/api/fix/:owner/:repo/issues/:number',
    identities: [
      { field: 'repo', location: 'path', param: 'owner' },
      { field: 'installationId', location: 'query' },
    ],
  });

  // installation_id-in-body routes (no repo in path).
  POLICY.registerMutationContract({
    name: 'enforcement-run',
    method: 'POST',
    classification: 'FIXTURE_MUTATION',
    route: '/api/enforcement/run',
    identities: [{ field: 'installationId', location: 'body', bodyField: 'installation_id' }],
  });
  POLICY.registerMutationContract({
    name: 'phase3-reconciler-run',
    method: 'POST',
    classification: 'FIXTURE_MUTATION',
    route: '/api/phase3/reconciler/run',
    identities: [{ field: 'installationId', location: 'body', bodyField: 'installation_id' }],
  });
}
registerMutationContracts();

/**
 * Prepare an API request: resolve URL, validate policy/mutation-gate, consume
 * budget, construct headers, stringify body. Returns { url, init, method }
 * ready for fetch(). This is the shared preparation path used by BOTH the
 * legacy api() compatibility wrapper AND the new apiBurstOperation()
 * factual-outcome constructor. The PR1 isolation boundary (policy, denylist,
 * contract, budget, credential timing) is preserved exactly.
 *
 * Any failure here (policy violation, denylisted target, missing contract,
 * budget exhaustion) escapes as a throw — which, in apiBurstOperation,
 * becomes BURST_OPERATION_REJECTED (a fatal harness defect, NOT a transport
 * failure). This is the amendment-10 boundary: policy errors are never
 * classified as transport outcomes.
 *
 * @param {string} path relative path or same-origin absolute URL
 * @param {Object} [options] same shape as api()
 * @returns {{ url: URL, init: Object, method: string }}
 */
export function prepareApiRequest(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
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
  // omitAuth=true suppresses the bearer token entirely (for endpoints that
  // must not receive it, e.g. /health, /webhooks/github).
  const hasAuthOverride = options.headers && Object.keys(options.headers).some(
    h => h.toLowerCase() === 'authorization'
  );
  const authHeader = (options.omitAuth || hasAuthOverride)
    ? {}
    : (POLICY.authHeader() ? { Authorization: POLICY.authHeader() } : {});

  const headers = {
    'Content-Type': 'application/json',
    ...authHeader,
    ...options.headers,
  };

  // Stringify object bodies. (String bodies for mutations were already
  // rejected above; string bodies for reads are passed through unchanged.)
  const bodyToSend = options.body && typeof options.body === 'object'
    ? JSON.stringify(options.body)
    : options.body;

  return { url, init: { method, headers, body: bodyToSend }, method };
}

/**
 * Fetch wrapper with API key auth. Returns parsed JSON + status.
 *
 * COMPATIBILITY wrapper for non-burst callers (integration tests, individual
 * stress tests that call get()/post() directly outside a burst). Body
 * parse state is NOT preserved here — a JSON parse failure silently becomes
 * the raw string (the pre-PR2a behavior). For factual body classification,
 * use apiBurstOperation() inside a runBurst() call.
 *
 * @param {string} path relative path or same-origin absolute URL
 * @param {Object} [options] see prepareApiRequest
 */
export async function api(path, options = {}) {
  const { url, init } = prepareApiRequest(path, options);
  const res = await fetch(url.href, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

/**
 * Construct an operation descriptor for use with runBurst(). The descriptor
 * uses prepareApiRequest() for policy/contract/budget (preserving the PR1
 * isolation boundary) and httpOperation() for factual transport/body
 * classification. Only the fetch() call is inside the transport catch.
 *
 * Policy errors (from prepareApiRequest) escape operation.run and become
 * BURST_OPERATION_REJECTED — they are NOT classified as transport failures.
 *
 * @param {string} path
 * @param {Object} [options]
 * @param {string} [options.kind] operation label for attribution
 * @param {string} [options.method] default GET
 * @param {"none"|"text"|"json"|"auto"} [options.bodyMode="auto"]
 * @param {string} [options.contractName] required for mutations
 * @param {Object} [options.body] request body
 * @param {Object} [options.headers] extra headers
 * @returns {{ kind: string|null, method: string, run: () => Promise<ClassifiedOutcome> }}
 */
export function apiBurstOperation(path, options = {}) {
  return {
    kind: options.kind ?? null,
    method: (options.method || "GET").toUpperCase(),
    run: async () => {
      const request = prepareApiRequest(path, options);
      return httpOperation({
        method: request.method,
        bodyMode: options.bodyMode ?? "auto",
        execute: () => fetch(request.url.href, request.init),
      });
    },
  };
}

/**
 * Construct a retry-aware read operation for use with runBurst(). Retries on
 * 429 (rate limit) with Retry-After backoff, up to `retries` attempts. Only
 * the final Response enters the operation result; intermediate 429s are
 * retried. Fetch failures during any attempt use the frozen transport taxonomy.
 *
 * @param {string} path
 * @param {Object} [options]
 * @param {number} [options.retries=3]
 * @param {string} [options.kind="read"]
 * @param {"none"|"text"|"json"|"auto"} [options.bodyMode="auto"]
 * @returns {{ kind: string, method: string, run: () => Promise<ClassifiedOutcome> }}
 */
export function resilientGetBurstOperation(path, options = {}) {
  const retries = options.retries ?? 3;
  const kind = options.kind ?? "read";
  const bodyMode = options.bodyMode ?? "auto";
  return {
    kind,
    method: "GET",
    run: async () => {
      // prepareApiRequest is OUTSIDE the transport boundary (amendment 10:
      // policy errors escape as BURST_OPERATION_REJECTED, not transport
      // failures). The retry loop is inside retryingHttpOperation's execute
      // boundary so fetch failures are classified as transportFailed.
      const request = prepareApiRequest(path, { method: "GET" });
      return retryingHttpOperation({
        method: "GET",
        bodyMode,
        retries,
        fetchFn: (url, init) => fetch(url, init),
        url: request.url.href,
        init: request.init,
      });
    },
  };
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
