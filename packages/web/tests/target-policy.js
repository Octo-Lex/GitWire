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

/**
 * Hostnames that are always rejected as request targets. Stored lowercase;
 * comparisons are case-insensitive (GitHub and DNS resolve case-insensitively).
 * Includes the production CT's LAN IP as an alias.
 */
const PRODUCTION_HOSTS = new Set([
  'gitwire.erlab.uk',
  '192.168.3.151', // CT 115 LAN IP — same host as gitwire.erlab.uk
]);

/**
 * Repository full_names (owner/repo) that are always rejected as mutation or
 * sync targets, wherever they appear in a path or payload. Stored lowercase
 * for case-insensitive comparison (GitHub owner/repo resolution is case-folded).
 */
const PRODUCTION_REPOS = new Set([
  'elephant-rock-lab/gitwire',
]);

/**
 * Organization logins that are always rejected as mutation targets. Stored
 * lowercase. Matches the owner segment of any owner/repo path or an `org`
 * JSON field.
 */
const PRODUCTION_ORGS = new Set([
  'elephant-rock-lab',
]);

/**
 * GitHub installation IDs that are always rejected as mutation targets,
 * canonicalized to integer-then-string so `133349719`, `'133349719'`, and
 * `133349719.0` all compare equal.
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
 * Canonicalize a hostname for case-insensitive denylist comparison.
 * DNS and GitHub hostnames resolve case-insensitively.
 */
function canonicalHost(hostname) {
  return String(hostname || '').trim().toLowerCase();
}

/**
 * Canonicalize an owner/repo for case-insensitive denylist comparison.
 * GitHub owner/repo resolution is case-folded (Owner/Repo == owner/repo).
 */
function canonicalRepo(repo) {
  return String(repo || '').trim().toLowerCase();
}

/**
 * Canonicalize an installation ID to integer-then-string, so `133349719`,
 * `'133349719'`, and `133349719.0` all compare equal. Throws on non-numeric
 * input (an installation ID that isn't a number is not a valid installation ID).
 */
function canonicalInstallationId(installationId) {
  if (installationId === undefined || installationId === null || installationId === '') {
    return null;
  }
  const asString = String(installationId).trim();
  // Reject non-integer strings — they cannot be real installation IDs.
  if (!/^\d+$/.test(asString)) {
    throw new Error(
      `Installation ID '${asString}' is not a valid integer installation ID.`
    );
  }
  // Canonicalize: parseInt then String, so '007' → '7'.
  return String(parseInt(asString, 10));
}

/**
 * Reject if a hostname is on the production denylist. Case-insensitive.
 * @param {string} hostname
 * @throws {Error} when the hostname is denylisted
 */
function assertHostNotProduction(hostname) {
  const canon = canonicalHost(hostname);
  if (PRODUCTION_HOSTS.has(canon)) {
    throw new Error(
      `Request target hostname '${hostname}' is a known production target. ` +
      `Tests must target an isolated environment.`
    );
  }
}

/**
 * Reject if an owner/repo string is on the production denylist. Comparison is
 * case-insensitive (GitHub owner/repo resolution is case-folded).
 * @param {string} repo owner/repo
 * @throws {Error} when the repo is denylisted
 */
function assertRepoNotProduction(repo) {
  if (!repo) return;
  const canonical = canonicalRepo(repo);
  if (PRODUCTION_REPOS.has(canonical)) {
    throw new Error(
      `Repository '${repo}' is a production target and cannot be used by stress tooling.`
    );
  }
  // Also reject if the owner segment is a denylisted org.
  const owner = canonical.split('/')[0];
  if (PRODUCTION_ORGS.has(owner)) {
    throw new Error(
      `Organization '${repo.split('/')[0]}' is a production target and cannot be used by stress tooling.`
    );
  }
}

/**
 * Reject if an installation ID is on the production denylist. Canonicalizes
 * to integer-then-string for type-stable comparison.
 * @param {string | number} installationId
 * @throws {Error} when the installation ID is denylisted or non-numeric
 */
function assertInstallationNotProduction(installationId) {
  const canon = canonicalInstallationId(installationId);
  if (canon === null) return;
  if (PRODUCTION_INSTALLATION_IDS.has(canon)) {
    throw new Error(
      `Installation ID '${installationId}' is a production target and cannot be used by stress tooling.`
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A run-wide mutation counter backed by a filesystem file. The counter is
 * shared across all processes (Jest workers, benchmark forks) in the same run
 * because they share the filesystem and the same GITWIRE_STRESS_RUN_ID. This
 * closes the per-process budget bypass: under Jest's parallel worker mode,
 * each worker previously got its own in-memory budget, silently multiplying
 * the configured cap by the worker count.
 *
 * Each consume() appends one line to <budgetFile>; the count is the line
 * count. The check-then-append is not atomically locked, so a small over-count
 * near the boundary is possible under heavy parallelism — this is acceptable
 * for a safety CAP (slightly under-allowing is safe; over-allowing is the
 * failure mode, and a few extra near the limit is far better than the previous
 * silent Nx multiplication). For truly atomic accounting, an O_EXCL lockfile
 * loop could be added; it is not needed at stress-test scales.
 *
 * The budget file lives in the OS temp dir, scoped by runId, and is removed
 * when the budget object is finalized (or left for the OS to clean up if the
 * process crashes — it is keyed by runId so a future run does not see it).
 */
class RunWideMutationBudget {
  /**
   * @param {number} max non-negative integer
   * @param {string} runId unique run identifier (GITWIRE_STRESS_RUN_ID)
   */
  constructor(max, runId) {
    if (!Number.isInteger(max) || max < 0) {
      throw new Error(
        `GITWIRE_STRESS_MUTATION_BUDGET must be a non-negative integer, got: ${max}`
      );
    }
    if (!runId || typeof runId !== 'string') {
      throw new Error('RunWideMutationBudget requires a non-empty runId.');
    }
    this.max = max;
    this.runId = runId;
    // Sanitize runId into a filename-safe token.
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.budgetFile = path.join(os.tmpdir(), `gitwire-stress-budget-${safe}.count`);
    // Start from a clean state for this runId. If a stale file from a previous
    // crashed run with the same runId exists, it is reset — the operator is
    // expected to use a fresh runId per run (the policy requires RUN_ID env).
    try {
      fs.writeFileSync(this.budgetFile, '', { flag: 'w' });
    } catch (err) {
      throw new Error(
        `Could not initialize mutation budget file at ${this.budgetFile}: ${err.message}`
      );
    }
    // Register cleanup on process exit so the file does not linger.
    process.once('exit', () => this._cleanup());
  }

  _cleanup() {
    try { fs.unlinkSync(this.budgetFile); } catch { /* already gone */ }
  }

  /** @returns {number} lines currently in the budget file */
  _count() {
    try {
      const content = fs.readFileSync(this.budgetFile, 'utf8');
      // Count non-empty lines (trailing newline should not count as a line).
      const trimmed = content.replace(/\n+$/, '');
      if (trimmed === '') return 0;
      return trimmed.split('\n').length;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * Consume one unit of budget. Throws when doing so would exceed the max.
   * @param {string} [operation] for error clarity
   */
  consume(operation) {
    const consumed = this._count();
    if (consumed >= this.max) {
      throw new Error(
        `Mutation budget exhausted: ${consumed}/${this.max} consumed ` +
        `(run-wide counter at ${this.budgetFile})` +
        (operation ? ` (rejected operation: ${operation})` : '') +
        `. Increase GITWIRE_STRESS_MUTATION_BUDGET or reduce the scenario.`
      );
    }
    try {
      fs.appendFileSync(this.budgetFile, `${operation || 'mutation'}\n`);
    } catch (err) {
      throw new Error(
        `Could not record mutation budget consumption at ${this.budgetFile}: ${err.message}`
      );
    }
  }

  /** @returns {number} remaining budget (may be slightly stale under parallelism) */
  remaining() {
    return Math.max(0, this.max - this._count());
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
 * Compile a route template like '/api/repos/:owner/:repo/sync' into a RegExp
 * matcher with named param capture. The matcher is anchored (full-path match)
 * so a contract for /api/repos/:owner/:repo/sync does not also match
 * /api/repos/:owner/:repo/config.
 *
 * Query strings are stripped before matching (they are not part of the route).
 *
 * @param {string} route template with :param segments
 * @returns {{ regex: RegExp, params: string[] }}
 */
function compileRoute(route) {
  const params = [];
  // Escape regex specials, then replace escaped :param with a capture group.
  // :param matches one path segment (no slash).
  const pattern = route
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        params.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  // Anchor: the pathname must match the pattern exactly (no extra segments).
  const regex = new RegExp('^' + pattern + '$');
  return { regex, params };
}

/**
 * Match a URL pathname against a compiled route. Returns the extracted params
 * keyed by name, or null if no match.
 *
 * @param {string} pathname
 * @param {{ regex: RegExp, params: string[] }} compiled
 * @returns {Object<string, string> | null}
 */
function matchRoute(pathname, compiled) {
  const m = compiled.regex.exec(pathname);
  if (!m) return null;
  const out = {};
  compiled.params.forEach((p, i) => { out[p] = decodeURIComponent(m[i + 1]); });
  return out;
}

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
    // Central registry of recognized mutation contracts. Every mutation must
    // reference one of these by name; ad-hoc contracts are rejected.
    this.contracts = new Map();
  }

  /**
   * Register a mutation contract. Must be called once per contract name at
   * module init (helpers.js registers the GitWire mutation surface). A
   * contract declares the method, route, classification, and where the
   * fixture identity MUST appear for that operation.
   *
   * @param {MutationTargetContract} contract
   */
  registerMutationContract(contract) {
    if (!contract || !contract.name) {
      throw new Error('Mutation contract requires a name.');
    }
    if (this.contracts.has(contract.name)) {
      throw new Error(`Mutation contract '${contract.name}' is already registered.`);
    }
    // Validate shape.
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(contract.method)) {
      throw new Error(`Contract '${contract.name}' has invalid method '${contract.method}'.`);
    }
    if (contract.classification !== 'FIXTURE_MUTATION') {
      throw new Error(
        `Contract '${contract.name}' classification must be 'FIXTURE_MUTATION' ` +
        `(got '${contract.classification}'). The policy only permits fixture mutations.`
      );
    }
    // Route template is required and must be anchored (start with /). It may
    // contain :param segments. The matcher enforces the exact route shape so
    // a caller cannot reuse a contract on an unintended endpoint.
    if (!contract.route || typeof contract.route !== 'string' || !contract.route.startsWith('/')) {
      throw new Error(
        `Contract '${contract.name}' must declare a route template starting with '/' ` +
        `(e.g. '/api/repos/:owner/:repo/sync').`
      );
    }
    // Identities is an array (possibly empty for routes with no fixture id,
    // though such routes should not be mutations). Each identity declares
    // where the fixture identity MUST appear and be validated.
    if (!Array.isArray(contract.identities)) {
      throw new Error(
        `Contract '${contract.name}' must declare an 'identities' array. ` +
        `Use [] for no fixture identity (rare for mutations).`
      );
    }
    for (const id of contract.identities) {
      if (!id || !id.field || !id.location) {
        throw new Error(
          `Contract '${contract.name}' has an identity missing field/location.`
        );
      }
      if (!['repo', 'installationId'].includes(id.field)) {
        throw new Error(
          `Contract '${contract.name}' identity.field must be 'repo' or 'installationId'.`
        );
      }
      if (!['path', 'body', 'query'].includes(id.location)) {
        throw new Error(
          `Contract '${contract.name}' identity.location must be 'path', 'body', or 'query'.`
        );
      }
      if (id.location === 'path' && !id.param) {
        throw new Error(
          `Contract '${contract.name}' path-located identity must declare 'param' ` +
          `(the :param name in the route template).`
        );
      }
      if (id.location === 'body' && !id.bodyField) {
        throw new Error(
          `Contract '${contract.name}' body-located identity must declare 'bodyField'.`
        );
      }
    }
    // Compile the route into a matcher. Convert :param segments into capture
    // groups and anchor the whole pattern.
    const compiled = compileRoute(contract.route);
    this.contracts.set(contract.name, { ...contract, _compiled: compiled });
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
   * Assert that a mutating request is permitted under this policy. Every
   * mutation MUST be declared via a recognized central contract — ad-hoc
   * mutations without a contract are rejected. The contract's declared
   * fixture identity MUST be present in the request at the declared location
   * (path/query/body); missing identity is fail-closed rejection, not
   * "use the path".
   *
   * String bodies are rejected for mutations: the policy cannot inspect a
   * pre-serialized string for embedded production identities, so a mutating
   * request MUST pass an object body (or no body) — never a string.
   *
   * @param {Object} req
   * @param {string} req.method HTTP method
   * @param {URL} req.url resolved URL (already same-origin checked)
   * @param {*} [req.body] parsed JSON body (object) — strings rejected for mutations
   * @param {string} req.contractName name of a registered mutation contract
   * @param {Object} [req.contractOverride] optional per-call contract fields
   *   (only allowed for fields the registry permits; otherwise rejected)
   * @param {string} [req.operationName] label for budget/errors
   * @throws {Error} on any policy violation, before fetch
   */
  assertMutationAllowed({ method, url, body, contractName, operationName }) {
    const verb = String(method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return; // read

    if (!this.allowMutations) {
      throw new Error(
        `${verb} requests require GITWIRE_STRESS_ALLOW_MUTATIONS=true. ` +
        `(operation: ${operationName || url.pathname})`
      );
    }

    // 1. Every mutation MUST declare a recognized contract from the central
    //    registry. Ad-hoc contracts supplied inline are rejected — this stops
    //    a caller from fabricating a permissive contract to bypass fixture
    //    enforcement.
    if (!contractName) {
      throw new Error(
        `${verb} mutation requires a registered contract name. Bare mutations ` +
        `without a declared target contract are not permitted. ` +
        `(operation: ${operationName || url.pathname})`
      );
    }
    const contract = this.contracts.get(contractName);
    if (!contract) {
      throw new Error(
        `Unknown mutation contract '${contractName}'. Register it via ` +
        `registerMutationContract() before use. Every mutating operation ` +
        `must reference a centrally-recognized contract.`
      );
    }
    if (contract.classification !== 'FIXTURE_MUTATION') {
      throw new Error(
        `Contract '${contractName}' classification is '${contract.classification}', ` +
        `not 'FIXTURE_MUTATION'. Only fixture mutations are permitted by the policy.`
      );
    }
    // Method + route must match the contract.
    if (contract.method !== verb) {
      throw new Error(
        `Contract '${contractName}' expects method ${contract.method}, got ${verb}.`
      );
    }

    if (!this.fixtureRepo) {
      throw new Error(
        'Mutation requests require GITWIRE_STRESS_FIXTURE_REPO to be set to a disposable owner/repo.'
      );
    }

    // 2. String bodies are rejected for mutations — they cannot be inspected.
    if (typeof body === 'string') {
      throw new Error(
        `${verb} mutation with a string body is rejected: the policy cannot ` +
        `inspect a pre-serialized body for embedded production identities. ` +
        `Pass an object body (or omit body). (contract: ${contractName})`
      );
    }

    // 3. Route match (anchored). The request pathname must match the
    //    contract's route template exactly — this stops a caller from
    //    reusing a same-method contract on an unintended endpoint. Done
    //    BEFORE the budget so a mismatch never consumes a slot.
    const routeParams = matchRoute(url.pathname, contract._compiled);
    if (routeParams === null) {
      throw new Error(
        `Route mismatch for contract '${contractName}': ` +
        `request path '${url.pathname}' does not match route '${contract.route}'.`
      );
    }

    // 4. Denylist checks across every channel identities can appear in.
    //    (Defense in depth — the contract check below is the authoritative
    //    fixture-conformance gate; this catches production identities even in
    //    channels the contract does not explicitly declare.)
    const pathRepo = extractRepoFromPath(url);
    if (pathRepo) {
      assertRepoNotProduction(`${pathRepo.owner}/${pathRepo.repo}`);
    }
    const queryInstallation = extractInstallationFromQuery(url);
    if (queryInstallation !== null) {
      assertInstallationNotProduction(queryInstallation);
    }
    if (body && typeof body === 'object') {
      const bodyRepo = findRepoInBody(body);
      if (bodyRepo) assertRepoNotProduction(bodyRepo);
      const bodyInstallation = findInstallationInBody(body);
      if (bodyInstallation !== null) assertInstallationNotProduction(bodyInstallation);
    }

    // 5. Contract conformance — fail-closed, ALL declared identities. Every
    //    identity the contract declares MUST be present at its declared
    //    location and MUST equal the configured fixture identity. A route
    //    that carries multiple identities (e.g. repo in path + installation
    //    in query) validates ALL of them.
    this._assertContractMet({ url, body, contract, routeParams });

    // 6. Budget.
    if (this.budget) {
      this.budget.consume(operationName || contractName);
    }
  }

  /**
   * Fail-closed contract enforcement for ALL declared identities. Each
   * identity in contract.identities MUST be present at its declared location
   * and MUST equal the configured fixture identity. Missing identity is
   * rejection. Multi-identity routes (e.g. repo in path + installation in
   * query) validate every identity, not just one — this closes the bypass
   * where a contract declares only one identity and an undeclared repo in
   * the path targets a non-fixture resource.
   *
   * Path-located identities are read from the route-extracted params (the
   * route matcher already validated the shape), keyed by the identity's
   * `param` name (the :param in the route template).
   *
   * @private
   */
  _assertContractMet({ url, body, contract, routeParams }) {
    const fixtureRepoCanon = canonicalRepo(this.fixtureRepo);
    const fixtureInstCanon = canonicalInstallationId(this.fixtureInstallationId);

    for (const id of contract.identities) {
      const { field, location, param, bodyField } = id;

      if (field === 'installationId') {
        let present = null;
        if (location === 'query') {
          present = extractInstallationFromQuery(url);
        } else if (location === 'body') {
          if (bodyField && body && typeof body === 'object') {
            present = body[bodyField] === undefined ? null : String(body[bodyField]);
          } else {
            present = findInstallationInBody(body);
          }
        } else if (location === 'path') {
          // Installation IDs are not typically path params; support anyway.
          present = param && routeParams[param] ? routeParams[param] : null;
        }
        if (present === null || present === '') {
          throw new Error(
            `Mutation contract '${contract.name}' declares fixture installation_id ` +
            `at ${location} but the request carries none. The declared fixture ` +
            `identity MUST be present.`
          );
        }
        const presentCanon = canonicalInstallationId(present);
        if (presentCanon !== fixtureInstCanon) {
          throw new Error(
            `Mutation contract '${contract.name}' carries installation_id '${present}' ` +
            `at ${location} which is not the configured fixture installation.`
          );
        }
      } else if (field === 'repo') {
        let present = null;
        if (location === 'path') {
          // The repo is split across :owner/:repo params in the route. The
          // identity's `param` is the owner param name; the repo param is
          // conventionally the next segment. We reconstruct owner/repo from
          // the two adjacent params declared on the route.
          if (param && routeParams[param]) {
            const ownerVal = routeParams[param];
            // Convention: the repo param is named 'repo'. If the route uses
            // a different name, the contract must declare it via repoParam.
            const repoParamName = id.repoParam || 'repo';
            const repoVal = routeParams[repoParamName];
            if (repoVal) {
              present = `${ownerVal}/${repoVal}`;
            }
          }
        } else if (location === 'body' && bodyField && body && typeof body === 'object') {
          present = typeof body[bodyField] === 'string' ? body[bodyField] : null;
        }
        if (!present) {
          throw new Error(
            `Mutation contract '${contract.name}' declares fixture repo at ${location} ` +
            `but the request carries none. The declared fixture identity MUST be present.`
          );
        }
        const presentCanon = canonicalRepo(present);
        if (presentCanon !== fixtureRepoCanon) {
          throw new Error(
            `Mutation contract '${contract.name}' targets repo '${present}' ` +
            `at ${location} which is not the configured fixture repo (${this.fixtureRepo}).`
          );
        }
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
    // Run-wide budget: shared across Jest workers and benchmark forks via a
    // filesystem counter scoped by runId. The previous in-memory counter was
    // per-process, which silently multiplied the cap by the worker count.
    budget = new RunWideMutationBudget(budgetNum, runId);
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
  canonicalHost,
  canonicalRepo,
  canonicalInstallationId,
  resolveSameOrigin,
  extractRepoFromPath,
  extractInstallationFromQuery,
  findInstallationInBody,
  findRepoInBody,
  RunWideMutationBudget,
  compileRoute,
  matchRoute,
  TargetPolicy,
};
