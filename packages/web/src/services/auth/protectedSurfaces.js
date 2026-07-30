// src/services/auth/protectedSurfaces.js
//
// Protected-surface declaration registry (Wave 2 / issue #94).
//
// Every protected HTTP route, worker, scheduled task, Telegram action, and
// mutation-producing execution path MUST declare:
//   - required permission
//   - resource resolver
//   - principal source
//   - authentication method
//   - observe-only decision handling
//
// This module is the machine-testable registry of those declarations. The
// protected-surface completeness check (issue #94 §5) asserts that every
// known surface is registered with all required fields. Unclassified or
// undeclared protected surfaces fail the check.

/**
 * @typedef {Object} ProtectedSurface
 * @property {string} id            - stable id (e.g. 'route:POST:/api/maintainer/:owner/:repo/collaborators')
 * @property {string} kind          - 'route' | 'worker' | 'scheduled' | 'telegram' | 'webhook'
 * @property {string} permission    - required permission token
 * @property {string} resourceType  - resource type resolved by the surface
 * @property {string} principalSource - 'req.auth' | 'worker-context' | 'webhook-installation'
 * @property {string} authMethod    - 'api_key' | 'session' | 'webhook_hmac' | 'system'
 * @property {string} observeHandling - 'record' | 'record-and-block' (Wave 2: record only)
 * @property {string} [notes]
 */

/** @type {Map<string, ProtectedSurface>} */
const REGISTRY = new Map();

/**
 * Register a protected surface. Throws on duplicate id or missing required
 * fields (fail-closed — surfaces must be fully declared).
 * @param {ProtectedSurface} surface
 */
export function declareProtectedSurface(surface) {
  if (!surface || !surface.id) {
    throw new Error("declareProtectedSurface: surface.id is required");
  }
  const required = ["kind", "permission", "resourceType", "principalSource", "authMethod", "observeHandling"];
  for (const field of required) {
    if (!surface[field]) {
      throw new Error(`declareProtectedSurface: ${surface.id} missing required field '${field}'`);
    }
  }
  if (REGISTRY.has(surface.id)) {
    throw new Error(`declareProtectedSurface: duplicate surface id '${surface.id}'`);
  }
  REGISTRY.set(surface.id, Object.freeze({ ...surface }));
}

/**
 * Bulk-register protected surfaces (convenience for the declaration file).
 * @param {ProtectedSurface[]} surfaces
 */
export function declareProtectedSurfaces(surfaces) {
  for (const s of surfaces) declareProtectedSurface(s);
}

/**
 * Look up a declared surface by id.
 * @param {string} id
 * @returns {ProtectedSurface|undefined}
 */
export function getProtectedSurface(id) {
  return REGISTRY.get(id);
}

/**
 * Return all registered surfaces (sorted by id) for the completeness check.
 * @returns {ProtectedSurface[]}
 */
export function listProtectedSurfaces() {
  return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The completeness check: assert every surface in the expected set is
 * registered with all required fields. Returns { ok, missing, incomplete }.
 *
 * @param {string[]} expectedIds - the canonical set of protected-surface ids
 *   that must exist (derived from the route/worker inventory).
 * @returns {{ok: boolean, missing: string[], incomplete: string[], registered: number}}
 */
export function assertProtectedSurfaceCompleteness(expectedIds) {
  const missing = [];
  const incomplete = [];
  for (const id of expectedIds) {
    const s = REGISTRY.get(id);
    if (!s) {
      missing.push(id);
      continue;
    }
    // All fields non-empty (declareProtectedSurface enforced at registration;
    // this is the independent verification).
    if (!s.permission || !s.resourceType || !s.principalSource || !s.authMethod || !s.observeHandling) {
      incomplete.push(id);
    }
  }
  return {
    ok: missing.length === 0 && incomplete.length === 0,
    missing,
    incomplete,
    registered: REGISTRY.size,
  };
}
