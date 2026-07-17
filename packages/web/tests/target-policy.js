// packages/web/tests/target-policy.js
//
// Shared isolation policy for all GitWire stress/benchmark tooling.
//
// Both the Jest stress suite (via tests/helpers.js) and scripts/benchmark.js
// route every request through this module. It enforces a fail-closed contract:
//
//   1. Every required identity comes from an explicit environment variable.
//      No defaults, no fallbacks. A missing variable is a hard error at load.
//   2. Known production identities are denylisted and rejected regardless of
//      configuration. The denylist is objective and not overridable by env.
//   3. Absolute request URLs must be same-origin with the configured base URL.
//      This closes the bypass where an `http(s)://` path skipped base-URL
//      validation and still received the bearer credential.
//   4. Mutating requests require an explicit fixture-target contract that
//      declares where the fixture identity appears (path segment, JSON field,
//      or query). The policy validates the actual request against the contract
//      rather than inferring target identity from arbitrary strings.
//   5. A mutation budget is consumed for every mutating call and rejects once
//      exhausted.
//
// This module performs NO network access. Every check is pure string/URL logic,
// so the negative tests in tests/unit/target-policy.test.js run network-free.

// ─── Production denylist ───────────────────────────────────────────────────
//
// These identities are production-adjacent and MUST NOT be targeted by stress
// or benchmark tooling under any configuration. Adding an env var does not
// re-enable them. If a future identity needs to graduate from fixture to
// production (or vice versa), edit this list in source — do not parameterize.

/** Hostnames that are always rejected as request targets. */
const PRODUCTION_HOSTS = new Set([
  'gitwire.erlab.uk',
]);

/**
 * Repository full_names (owner/repo) that are always rejected as mutation or
 * sync targets, wherever they appear in a path or payload.
 */
const PRODUCTION_REPOS = new Set([
  'Elephant-Rock-Lab/GitWire',
]);

/**
 * Organization logins that are always rejected as mutation targets. Matches
 * the owner segment of any owner/repo path or an `org` JSON field.
 */
const PRODUCTION_ORGS = new Set([
  'Elephant-Rock-Lab',
]);

/**
 * GitHub installation IDs that are always rejected as mutation targets. Stored
 * as strings so comparison is type-stable regardless of how the value arrives
 * (env vars are strings; JSON payloads may carry numbers).
 */
const PRODUCTION_INSTALLATION_IDS = new Set([
  '133349719',
]);

// ─── Environment contract ──────────────────────────────────────────────────

/**
 * Required environment variables for any run that loads this module. Each
 * must be a non-empty string. Stress tests additionally require the stress
 * gate and (for mutations) the fixture identities + opt-in.
 */
const REQUIRED_ENV = [
  'GITWIRE_BASE_URL',
  'API_KEY',
];

const REQUIRED_STRESS_ENV = [
  'GITWIRE_STRESS_ENV',
];

const REQUIRED_MUTATION_ENV = [
  'GITWIRE_STRESS_ALLOW_MUTATIONS',
  'GITWIRE_STRESS_FIXTURE_REPO',
  'GITWIRE_STRESS_FIXTURE_INSTALLATION_ID',
];

const REQUIRED_RUN_ID_ENV = [
  'GITWIRE_STRESS_RUN_ID',
];

const REQUIRED_BUDGET_ENV = [
  'GITWIRE_STRESS_MUTATION_BUDGET',
];

/**
 * Read a required env var or throw a descriptive error. Never returns empty.
 * @param {string} name
 * @returns {string}
 */
function requireEnv(name) {
  const val = process.env[name];
  if (!val || String(val).trim().length === 0) {
    throw new Error(
      `${name} environment variable is required. Tests will not run without explicit configuration.`
    );
  }
  return String(val).trim();
}

/**
 * Read an optional env var. Returns null when absent/empty. Never throws.
 * @param {string} name
 * @returns {string | null}
 */
function optionalEnv(name) {
  const val = process.env[name];
  if (!val || String(val).trim().length === 0) return null;
  return String(val).trim();
}

// ─── URL / identity validation ─────────────────────────────────────────────

/**
 * Validate that a base URL is syntactically valid and resolvable to an origin.
 * Does NOT check the denylist — that happens at request time so the rejection
 * surface is uniform. Returns the parsed URL.
 *
 * @param {string} baseUrl
 * @returns {URL}
 */
function parseBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`GITWIRE_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (!parsed.origin || parsed.origin === 'null') {
    throw new Error(`GITWIRE_BASE_URL has no usable origin: ${baseUrl}`);
  }
  return parsed;
}

/**
 * Reject if a hostname is on the production denylist.
 * @param {string} hostname
 * @throws {Error} when the hostname is denylisted
 */
function assertHostNotProduction(hostname) {
  if (PRODUCTION_HOSTS.has(hostname)) {
    throw new Error(
      `Request target hostname '${hostname}' is a known production target. ` +
      `Tests must target an isolated environment.`
    );
  }
}

/**
 * Reject if an owner/repo string is on the production denylist. Comparison is
 * exact and case-sensitive; GitHub logins are.
 * @param {string} repo owner/repo
 * @throws {Error} when the repo is denylisted
 */
function assertRepoNotProduction(repo) {
  if (!repo) return;
  const normalized = String(repo).trim();
  if (PRODUCTION_REPOS.has(normalized)) {
    throw new Error(
      `Repository '${normalized}' is a production target and cannot be used by stress tooling.`
    );
  }
  // Also reject if the owner segment is a denylisted org.
  const owner = normalized.split('/')[0];
  if (PRODUCTION_ORGS.has(owner)) {
    throw new Error(
      `Organization '${owner}' is a production target and cannot be used by stress tooling.`
    );
  }
}

/**
 * Reject if an installation ID is on the production denylist. Coerces to
 * string for type-stable comparison.
 * @param {string | number} installationId
 * @throws {Error} when the installation ID is denylisted
 */
function assertInstallationNotProduction(installationId) {
  if (installationId === undefined || installationId === null || installationId === '') return;
  const asString = String(installationId).trim();
  if (PRODUCTION_INSTALLATION_IDS.has(asString)) {
    throw new Error(
      `Installation ID '${asString}' is a production target and cannot be used by stress tooling.`
    );
  }
}

/**
 * Resolve a request path (relative or absolute) against the base URL and
 * enforce that the resulting origin matches the base origin. This is the
 * closure for the helpers.js:96 absolute-URL bypass: any absolute URL whose
 * origin differs from the validated base URL is rejected BEFORE any header
 * is constructed or any fetch is issued.
 *
 * @param {string} path relative path, same-origin absolute URL, or external URL
 * @param {URL} baseUrl parsed base URL
 * @returns {URL} the resolved, same-origin-validated URL
 * @throws {Error} on cross-origin absolute URL or invalid path
 */
function resolveSameOrigin(path, baseUrl) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Request path is empty.');
  }
  // new URL(path, base) correctly handles both relative and absolute inputs:
  //   new URL('/api/repos', base)         → same origin
  //   new URL('https://evil/x', base)     → evil origin
  //   new URL('http://other/y', base)     → other origin
  let resolved;
  try {
    resolved = new URL(path, baseUrl);
  } catch {
    throw new Error(`Could not resolve request path '${path}' against base URL.`);
  }
  if (resolved.origin !== baseUrl.origin) {
    throw new Error(
      `Cross-origin test request rejected: '${resolved.origin}' !== configured base origin '${baseUrl.origin}'. ` +
      `Absolute URLs must be same-origin with GITWIRE_BASE_URL.`
    );
  }
  assertHostNotProduction(resolved.hostname);
  return resolved;
}

// ─── Mutation budget ───────────────────────────────────────────────────────

/**
 * A bounded mutation counter. Throws once the configured budget is exhausted.
 * Constructed once per run from GITWIRE_STRESS_MUTATION_BUDGET. Not threadsafe
 * in the sense of cross-process — it bounds a single Jest/benchmark process.
 */
class MutationBudget {
  /**
   * @param {number} max non-negative integer
   */
  constructor(max) {
    if (!Number.isInteger(max) || max < 0) {
      throw new Error(
        `GITWIRE_STRESS_MUTATION_BUDGET must be a non-negative integer, got: ${max}`
      );
    }
    this.max = max;
    this.consumed = 0;
  }

  /**
   * Consume one unit of budget. Throws when doing so would exceed the max.
   * @param {string} [operation] for error clarity
   */
  consume(operation) {
    if (this.consumed >= this.max) {
      throw new Error(
        `Mutation budget exhausted: ${this.consumed}/${this.max} consumed` +
        (operation ? ` (rejected operation: ${operation})` : '') +
        `. Increase GITWIRE_STRESS_MUTATION_BUDGET or reduce the scenario.`
      );
    }
    this.consumed += 1;
  }

  /** @returns {number} remaining budget */
  remaining() {
    return this.max - this.consumed;
  }
}

// ─── Mutation target contracts ─────────────────────────────────────────────

/**
 * @typedef {Object} MutationTargetContract
 * @property {string} name human label, used in errors/budget
 * @property {string} method HTTP method (POST/PUT/PATCH/DELETE)
 * @property {string} path path template; the fixture repo is substituted into
 *   ':owner/:repo' segments when present
 * @property {'FIXTURE_MUTATION'} classification always FIXTURE_MUTATION for now
 * @property {Object} [target] where the fixture identity is declared
 * @property {'repo'|'installationId'} [target.field] which fixture identity
 *   this operation targets
 * @property {'path'|'body'|'query'} [target.location] where it appears
 * @property {string} [target.bodyField] JSON field name for body-located ids
 * @property {number[]} [expectedStatuses] permitted success/status codes
 */

/**
 * Route keywords known to precede an `:owner/:repo` pair in the GitWire API.
 * Used to anchor extraction so we don't misidentify `api`/`repos` as a pair.
 * If you add a new repo-scoped route, add its keyword here.
 */
const REPO_LEADING_KEYWORDS = new Set([
  'repos', 'fix', 'maintainer', 'review', 'config', 'gates',
  'duplicates', 'dependencies', 'queue', 'relays', 'waivers', 'transfers',
]);

/**
 * Extract any owner/repo pair from a URL pathname. Returns the first match or
 * null. Anchors on known route keywords (e.g. `/api/repos/:owner/:repo`) so we
 * don't misidentify route infrastructure segments (`api`, `repos`) as a pair.
 *
 * @param {URL} url
 * @returns {{owner: string, repo: string} | null}
 */
function extractRepoFromPath(url) {
  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i + 2 < segments.length; i++) {
    if (!REPO_LEADING_KEYWORDS.has(segments[i])) continue;
    const owner = decodeURIComponent(segments[i + 1]);
    const repo = decodeURIComponent(segments[i + 2]);
    // Sanity: owner/repo segments should not contain path separators or dots
    // (hostnames). Reject anything that looks like a route keyword itself.
    if (!owner || !repo) continue;
    if (owner.includes('.') || repo.includes('.')) continue;
    if (REPO_LEADING_KEYWORDS.has(owner) || REPO_LEADING_KEYWORDS.has(repo)) continue;
    return { owner, repo };
  }
  return null;
}

/**
 * Extract installation_id from a URL's query string, if present.
 * @param {URL} url
 * @returns {string | null}
 */
function extractInstallationFromQuery(url) {
  const v = url.searchParams.get('installation_id');
  return v === null ? null : v;
}

/**
 * Find an installation_id field in a parsed JSON body.
 * @param {*} body parsed JSON (any shape)
 * @returns {string | null}
 */
function findInstallationInBody(body) {
  if (!body || typeof body !== 'object') return null;
  // Direct field.
  if ('installation_id' in body) return String(body.installation_id);
  // Common nested shapes used by reconciler/enforcement endpoints.
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (v && typeof v === 'object' && 'installation_id' in v) {
      return String(v.installation_id);
    }
  }
  return null;
}

/**
 * Find an owner/repo reference in a parsed JSON body. Looks for common field
 * names: repo, repo_full_name, full_name, repository (string form).
 * @param {*} body parsed JSON
 * @returns {string | null}
 */
function findRepoInBody(body) {
  if (!body || typeof body !== 'object') return null;
  for (const k of ['repo', 'repo_full_name', 'full_name']) {
    if (typeof body[k] === 'string' && body[k].includes('/')) return body[k];
  }
  return null;
}

// ─── Policy facade ─────────────────────────────────────────────────────────

/**
 * The single policy object constructed once per process. Constructed via
 * `loadPolicy()` so errors surface at load time rather than per-request.
 */
class TargetPolicy {
  /**
   * @param {Object} opts
   * @param {string} opts.baseUrl raw configured base URL
   * @param {string} opts.apiKey configured API key
   * @param {boolean} opts.isStress whether the stress gate is required
   * @param {boolean} opts.allowMutations whether mutations are opted in
   * @param {string | null} opts.fixtureRepo owner/repo
   * @param {string | null} opts.fixtureInstallationId
   * @param {string | null} opts.runId
   * @param {MutationBudget | null} opts.budget null when mutations disallowed
   */
  constructor(opts) {
    this.baseUrlRaw = opts.baseUrl;
    this.baseUrl = parseBaseUrl(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.isStress = opts.isStress;
    this.allowMutations = opts.allowMutations;
    this.fixtureRepo = opts.fixtureRepo;
    this.fixtureInstallationId = opts.fixtureInstallationId;
    this.runId = opts.runId;
    this.budget = opts.budget;
  }

  /**
   * Resolve and validate a request path against this policy. Returns the final
   * URL to fetch. Enforces same-origin and production-host denylist. Does NOT
   * touch the network.
   *
   * @param {string} path
   * @returns {URL}
   */
  resolveRequest(path) {
    return resolveSameOrigin(path, this.baseUrl);
  }

  /**
   * Authorization header value, or null when no API key is configured.
   * Constructed lazily so rejected requests (which throw before this is
   * called) never produce a credential string.
   * @returns {string | null}
   */
  authHeader() {
    if (!this.apiKey) return null;
    return `Bearer ${this.apiKey}`;
  }

  /**
   * Assert that a mutating request is permitted under this policy. Validates
   * method, fixture identity, denylists (in path/query/body), budget, and the
   * declared target contract when one is supplied.
   *
   * @param {Object} req
   * @param {string} req.method HTTP method
   * @param {URL} req.url resolved URL (already same-origin checked)
   * @param {*} [req.body] parsed JSON body, if any
   * @param {MutationTargetContract} [req.contract] declared operation contract
   * @param {string} [req.operationName] label for budget/errors
   */
  assertMutationAllowed({ method, url, body, contract, operationName }) {
    const verb = String(method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return; // read

    if (!this.allowMutations) {
      throw new Error(
        `${verb} requests require GITWIRE_STRESS_ALLOW_MUTATIONS=true. ` +
        `(operation: ${operationName || url.pathname})`
      );
    }
    if (!this.fixtureRepo) {
      throw new Error(
        'Mutation requests require GITWIRE_STRESS_FIXTURE_REPO to be set to a disposable owner/repo.'
      );
    }

    // Denylist checks across every channel identities can appear in.
    const pathRepo = extractRepoFromPath(url);
    if (pathRepo) {
      assertRepoNotProduction(`${pathRepo.owner}/${pathRepo.repo}`);
    }
    const queryInstallation = extractInstallationFromQuery(url);
    if (queryInstallation !== null) {
      assertInstallationNotProduction(queryInstallation);
    }
    if (body) {
      const bodyRepo = findRepoInBody(body);
      if (bodyRepo) assertRepoNotProduction(bodyRepo);
      const bodyInstallation = findInstallationInBody(body);
      if (bodyInstallation !== null) assertInstallationNotProduction(bodyInstallation);
    }

    // Contract conformance: if a contract declares where the fixture identity
    // must appear, the request must actually carry the configured fixture
    // identity in that location (or omit it entirely — the server will fill
    // from the path). We reject requests that carry a DIFFERENT identity.
    if (contract && contract.target) {
      this._assertContractMet({ url, body, contract });
    }

    // Budget.
    if (this.budget) {
      this.budget.consume(operationName || contract?.name || verb);
    }
  }

  /**
   * Reject requests whose declared target location carries a non-fixture
   * identity. We do not require the fixture identity to be present (the
   * server treats absence as "use the path"), but we DO require that any
   * identity present is the fixture, not production and not some other repo.
   *
   * @private
   */
  _assertContractMet({ url, body, contract }) {
    const { field, location, bodyField } = contract.target;
    if (field === 'installationId') {
      let present = null;
      if (location === 'query') present = extractInstallationFromQuery(url);
      else if (location === 'body') {
        present = bodyField && body ? String(body[bodyField] ?? '') : findInstallationInBody(body);
      }
      if (present !== null && present !== '' && present !== String(this.fixtureInstallationId)) {
        throw new Error(
          `Mutation contract '${contract.name}' carries installation_id '${present}' ` +
          `which is not the configured fixture installation.`
        );
      }
    } else if (field === 'repo') {
      let present = null;
      if (location === 'body' && bodyField && body) {
        present = typeof body[bodyField] === 'string' ? body[bodyField] : null;
      } else if (location === 'path') {
        const pr = extractRepoFromPath(url);
        present = pr ? `${pr.owner}/${pr.repo}` : null;
      }
      if (present && present !== this.fixtureRepo) {
        throw new Error(
          `Mutation contract '${contract.name}' targets repo '${present}' ` +
          `which is not the configured fixture repo (${this.fixtureRepo}).`
        );
      }
    }
  }
}

// ─── Loaders ───────────────────────────────────────────────────────────────

/**
 * Load and validate the base policy (no mutations). Used by benchmark.js read
 * paths and by helpers.js when GITWIRE_STRESS_ALLOW_MUTATIONS is unset.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.requireStressGate] default true — the Jest stress
 *   suite requires GITWIRE_STRESS_ENV=isolated. benchmark.js may pass false
 *   for read-only runs but mutations still require the full gate.
 * @returns {TargetPolicy}
 */
export function loadPolicy(opts = {}) {
  const requireStressGate = opts.requireStressGate !== false;
  const baseUrl = requireEnv('GITWIRE_BASE_URL');
  const apiKey = requireEnv('API_KEY');

  // Validate the base URL is not a production host. (resolveSameOrigin checks
  // this again per-request, but failing at load gives a clearer error.)
  const parsed = parseBaseUrl(baseUrl);
  assertHostNotProduction(parsed.hostname);

  if (requireStressGate) {
    const stressEnv = requireEnv('GITWIRE_STRESS_ENV');
    if (stressEnv !== 'isolated') {
      throw new Error(
        `GITWIRE_STRESS_ENV='${stressEnv}' — must be 'isolated' for stress/integration tests.`
      );
    }
  }

  // Mutation opt-in is parsed but NOT required at load for the base policy.
  // assertMutationAllowed enforces the full mutation gate per-request.
  const allowMutations = process.env.GITWIRE_STRESS_ALLOW_MUTATIONS === 'true';
  let fixtureRepo = optionalEnv('GITWIRE_STRESS_FIXTURE_REPO');
  let fixtureInstallationId = optionalEnv('GITWIRE_STRESS_FIXTURE_INSTALLATION_ID');
  const runId = optionalEnv('GITWIRE_STRESS_RUN_ID');

  // The fixture repo itself must not be on the production denylist. This
  // catches an operator accidentally pointing the fixture at a production repo.
  if (fixtureRepo) assertRepoNotProduction(fixtureRepo);
  if (fixtureInstallationId) assertInstallationNotProduction(fixtureInstallationId);

  // If mutations are enabled, ALL fixture identity + budget env must be present.
  let budget = null;
  if (allowMutations) {
    if (!fixtureRepo) {
      throw new Error(
        'GITWIRE_STRESS_ALLOW_MUTATIONS=true requires GITWIRE_STRESS_FIXTURE_REPO.'
      );
    }
    if (!fixtureInstallationId) {
      throw new Error(
        'GITWIRE_STRESS_ALLOW_MUTATIONS=true requires GITWIRE_STRESS_FIXTURE_INSTALLATION_ID.'
      );
    }
    if (!runId) {
      throw new Error('GITWIRE_STRESS_ALLOW_MUTATIONS=true requires GITWIRE_STRESS_RUN_ID.');
    }
    const budgetRaw = requireEnv('GITWIRE_STRESS_MUTATION_BUDGET');
    const budgetNum = parseInt(budgetRaw, 10);
    budget = new MutationBudget(budgetNum);
  }

  return new TargetPolicy({
    baseUrl,
    apiKey,
    isStress: requireStressGate,
    allowMutations,
    fixtureRepo,
    fixtureInstallationId,
    runId,
    budget,
  });
}

// ─── Exports for testing (pure functions, network-free) ────────────────────

export const TESTING_ONLY = {
  PRODUCTION_HOSTS,
  PRODUCTION_REPOS,
  PRODUCTION_ORGS,
  PRODUCTION_INSTALLATION_IDS,
  REQUIRED_ENV,
  REQUIRED_STRESS_ENV,
  REQUIRED_MUTATION_ENV,
  REQUIRED_RUN_ID_ENV,
  REQUIRED_BUDGET_ENV,
  parseBaseUrl,
  assertHostNotProduction,
  assertRepoNotProduction,
  assertInstallationNotProduction,
  resolveSameOrigin,
  extractRepoFromPath,
  extractInstallationFromQuery,
  findInstallationInBody,
  findRepoInBody,
  MutationBudget,
  TargetPolicy,
};
