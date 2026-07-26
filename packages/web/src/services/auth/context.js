// src/services/auth/context.js
//
// Canonical server-derived auth context (Wave 2 / issue #94).
//
// Every authenticated HTTP request receives a server-derived context on
// `req.auth` (the HTTP transport). Background execution paths receive an
// equivalent immutable `WorkerAuthContext`. Neither is ever derived from
// a client-supplied header or payload field.
//
// These are plain data objects (JSDoc-typed). They are constructed ONLY by
// the identity resolvers (principalResolver / sessionResolver / etc.), never
// by routes or workers from request input.

/**
 * @typedef {Object} AuthContext
 * @property {string} principalId        - UUID of the resolved principal
 * @property {string} principalType      - 'user' | 'service' | 'installation' | 'system' | 'legacy-key'
 * @property {string|null} sessionId     - UUID of the auth session (human/session paths), else null
 * @property {string|null} credentialId  - UUID of the credential (api_key/service paths), else null
 * @property {string} authenticationMethod - 'api_key' | 'session' | 'github_oauth' | 'webhook_hmac'
 * @property {string} assuranceLevel     - 'level1' (frozen; future levels extend)
 * @property {number} authEpoch          - the principal's auth_epoch at resolution time
 * @property {number|null} installationId- GitHub installation id when in scope, else null
 * @property {string|null} githubUserId  - github_user_id for type='user', else null
 */

/**
 * Build an immutable AuthContext. All fields explicit; nullable fields are
 * passed as null rather than omitted (issue #94: "Nullable fields must be
 * explicit rather than omitted unpredictably").
 *
 * @param {AuthContext} ctx
 * @returns {Readonly<AuthContext>}
 */
export function createContext(ctx) {
  return Object.freeze({
    principalId: ctx.principalId,
    principalType: ctx.principalType,
    sessionId: ctx.sessionId ?? null,
    credentialId: ctx.credentialId ?? null,
    authenticationMethod: ctx.authenticationMethod,
    assuranceLevel: ctx.assuranceLevel ?? "level1",
    authEpoch: ctx.authEpoch,
    installationId: ctx.installationId ?? null,
    githubUserId: ctx.githubUserId ?? null,
  });
}

/**
 * The unauthenticated sentinel context — used when no principal could be
 * resolved. authorize() will return UNAUTHENTICATED for this context.
 * (Returned as a fresh frozen object so callers cannot mutate a shared ref.)
 */
export function unauthenticatedContext(method = "unauthenticated") {
  return createContext({
    principalId: null,
    principalType: "anonymous",
    sessionId: null,
    credentialId: null,
    authenticationMethod: method,
    assuranceLevel: "level1",
    authEpoch: 0,
    installationId: null,
    githubUserId: null,
  });
}

/**
 * @typedef {Object} Resource
 * @property {string} type                - resource type token (e.g. 'repository', 'installation')
 * @property {number|null} installationId - GitHub installation id
 * @property {number|null} repositoryId   - GitHub repository id (github_id)
 * @property {string|null} organization   - owner login
 * @property {string|null} repository     - repo name
 * @property {string|null} resourceId     - resource-specific id (e.g. issue number)
 */

/**
 * @typedef {Object} AuthorizationDecision
 * @property {boolean} allowed
 * @property {string} code                - a DecisionCode value
 * @property {string|null} principalId
 * @property {string} permission
 * @property {Resource} resource
 * @property {string|null} matchedAssignmentId - UUID of the auth_principal_roles row, else null
 * @property {string|null} matchedScopeType     - 'fleet' | 'organization' | 'repository' | null
 * @property {string} policyVersion
 * @property {string|null} authenticationMethod
 * @property {object|null} detail              - extra diagnostic (never secrets)
 */

/**
 * Build an immutable AuthorizationDecision.
 * @param {AuthorizationDecision} d
 * @returns {Readonly<AuthorizationDecision>}
 */
export function createDecision(d) {
  return Object.freeze({
    allowed: !!d.allowed,
    code: d.code,
    principalId: d.principalId ?? null,
    permission: d.permission,
    resource: Object.freeze({
      type: d.resource?.type ?? "unknown",
      installationId: d.resource?.installationId ?? null,
      repositoryId: d.resource?.repositoryId ?? null,
      organization: d.resource?.organization ?? null,
      repository: d.resource?.repository ?? null,
      resourceId: d.resource?.resourceId ?? null,
    }),
    matchedAssignmentId: d.matchedAssignmentId ?? null,
    matchedScopeType: d.matchedScopeType ?? null,
    policyVersion: d.policyVersion ?? "level1",
    authenticationMethod: d.authenticationMethod ?? null,
    detail: d.detail ? Object.freeze({ ...d.detail }) : null,
  });
}
