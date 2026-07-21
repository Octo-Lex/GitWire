# Canonical Permission and Resource Model (W0-B)

> **Wave 0 design document.** This is a proposal, not an implementation.
> It references findings from [`current-state-inventory.md`](./current-state-inventory.md)
> by ID (F-01 through F-15). It does not change runtime behavior.

## Table of contents

1. [Design principles](#1-design-principles)
2. [Principal model](#2-principal-model)
3. [Resource hierarchy and inheritance](#3-resource-hierarchy-and-inheritance)
4. [Actions and permissions](#4-actions-and-permissions)
5. [Role composition](#5-role-composition)
6. [Evaluation algebra](#6-evaluation-algebra)
7. [Default-deny and explicit-deny semantics](#7-default-deny-and-explicit-deny-semantics)
8. [Tenant and repository boundaries](#8-tenant-and-repository-boundaries)
9. [Ownership, creation, and delegation](#9-ownership-creation-and-delegation)
10. [Service-account scope](#10-service-account-scope)
11. [Break-glass and emergency access](#11-break-glass-and-emergency-access)
12. [Decision context and denial reasons](#12-decision-context-and-denial-reasons)
13. [Compatibility treatment for existing paths](#13-compatibility-treatment-for-existing-paths)
14. [Job-authorization capability (F-06 closure)](#14-job-authorization-capability-f-06-closure)
15. [Finding resolution matrix](#15-finding-resolution-matrix)

---

## 1. Design principles

1. **Intersection, never union.** Effective authority is the intersection of
   role permissions, credential scopes, resource grants, and operation
   policy. No factor can expand another factor.
2. **Default deny.** Every request is denied unless an explicit allow rule
   matches. The absence of a policy is a denial.
3. **Named principals.** Every authenticated request resolves to a named
   principal. The shared-key model is a compatibility bridge, not the
   target architecture.
4. **Resource-boundary enforcement at the data layer.** Tenant scoping is
   enforced by a query-building interceptor, not by individual route
   handlers remembering to pass `installation_id`. A route that forgets
   to scope its query gets an empty result set, not a data leak.
5. **Separation of identity and authority.** Authentication determines who
   the principal is. Authorization determines what they can do. These are
   evaluated as separate stages with separate inputs.
6. **Auditable decisions.** Every authorization decision (allow or deny)
   produces a structured decision record with a unique `decision_id` and
   deterministic denial codes.
7. **Credential narrowing.** A credential can only reduce authority. A
   service token scoped to one repo cannot access another, even if the
   service's role would permit it.
8. **Creation is not authority.** The principal that creates a resource
   (e.g., a sync worker importing a repository) is its `created_by`, but
   does not gain ownership authority over it. Tenant assignment and
   authorization grants are separate from creation provenance.

---

## 2. Principal model

### Principal types

| Type | Description | GitHub binding | Used by |
|------|-------------|----------------|---------|
| `user` | Human operator. Authenticated via GitHub App OAuth or bootstrap admin. | `github_user_id` (immutable, unique) | Dashboard users, operators |
| `service` | Machine identity. Authenticated via scoped API credential. | None — must not carry GitHub identity. | Workers, executor-service, bot |
| `installation` | GitHub App installation identity. Authenticated via HMAC-verified webhook. | `installation_id` | Webhook ingress path |
| `system` | Internal process identity with no external authentication. | None | `setInterval` reconciliation timer, migration runner |
| `legacy-key` | Temporary bridge principal. One per shared API key fingerprint. | None | Existing dashboard/API clients during migration |

### Principal record

```text
auth_principals
  id              UUID primary key
  principal_type  ENUM('user', 'service', 'installation', 'system', 'legacy-key')
  display_name    text
  status          ENUM('active', 'disabled')
  github_user_id  bigint UNIQUE NULL  -- only for type='user'
  github_login    text NULL           -- only for type='user'
  installation_id bigint NULL         -- for type='installation'
  auth_epoch      bigint              -- incremented to invalidate all sessions
  created_at      timestamptz
  updated_at      timestamptz
```

**Constraints:**
- `principal_type='user'` may have `github_user_id`; all others must not.
- `principal_type='service'` must not have `github_user_id` or `installation_id`.
- `principal_type='installation'` must have `installation_id`.
- `principal_type='system'` has no external identity.
- `github_user_id` is unique — one principal per GitHub user.
- Disabled principals cannot authenticate.
- `auth_epoch` increments on credential revocation, role revocation, or
  admin-forced session invalidation.

### Bootstrap administration

A bootstrap mechanism creates the first named administrator:
1. Enabled only when zero active `admin`-role principals exist.
2. Requires a short-lived secret injected operationally (env var or
   sealed file, never in the repository).
3. Creates the first `user` principal with `admin` role.
4. The bootstrap endpoint is permanently disabled (removed from the
   route table) after successful use — not merely feature-flagged.
5. **Re-enable during lockout:** if all administrators are disabled,
   bootstrap can be re-enabled only by:
   - Direct database access by an operator with production DB credentials.
   - The operator inserts a bootstrap-allow marker into a controlled
     table (`auth_bootstrap_allow`), which is consumed exactly once.
   - This marker cannot be created via the API; it requires DB-level
     access that the application does not hold.
   - The re-enable action is logged in `auth_bootstrap_allow` with the
     operator's DB session identity.
6. Produces a canonical audit event with `bootstrap` context.

---

## 3. Resource hierarchy and inheritance

### Complete resource taxonomy

```
system (fleet-wide)
├── installation
│   ├── repository
│   │   ├── pull_request
│   │   ├── issue
│   │   ├── ci_run
│   │   ├── branch_rule
│   │   ├── repo_config
│   │   ├── heal_pr
│   │   ├── repair_proposal
│   │   ├── patch_artifact
│   │   ├── execution_receipt
│   │   ├── source_snapshot
│   │   ├── ai_review
│   │   ├── duplicate_signal
│   │   ├── dependency_manifest
│   │   ├── vulnerability_advisory
│   │   ├── flaky_test
│   │   ├── fix_attempt
│   │   └── managed_action
│   ├── policy_definition
│   ├── policy_waiver
│   ├── policy_rollout_plan
│   ├── quality_gate
│   ├── feedback_rule
│   ├── merge_queue_entry
│   ├── merge_queue_config
│   ├── maintainer_setting
│   └── reconciliation_run
├── auth_principal
├── auth_role
├── auth_credential
├── auth_delegation
├── auth_resource_grant
├── audit_trail_entry
├── audit_export
└── compliance_report
```

### Resource types

| Category | Resources | Scope |
|----------|-----------|-------|
| **Installation-scoped** | repository and all its children; policy, waiver, gate, rollout, queue, maintainer settings | Tenant-scoped |
| **Identity-scoped** | auth_principal, auth_role, auth_credential, auth_delegation, auth_resource_grant | System-scoped; not tenant-filtered |
| **System-scoped** | audit_trail_entry, audit_export, compliance_report, system configuration | Fleet-wide |

### Inheritance rules

- A grant on `installation` applies to all repositories and installation-scoped
  resources within it.
- A grant on `repository` applies to all child resources within it.
- A grant on a specific resource (e.g., a single `repair_proposal`) applies
  only to that resource.
- Identity-scoped and system-scoped resources do not inherit from
  installation. They require explicit fleet-level or system-level grants.
- **Denials do not inherit upward.** A denial at the repository level does
  not deny access to the installation. Denial flows downward only.

### Resource resolution

Every request resolves its target resource from the route:
- `:owner/:repo` path params → `repository` resource.
- `:id` body/path params → resource by ID (e.g., `repair_proposal`, `waiver`).
- List endpoints (no `:owner/:repo`) → query scoped by the principal's
  resource grants. The resource type is known from the route; the
  principal's grants determine which instances are visible.

---

## 4. Actions and permissions

### Complete action vocabulary

| Action | Description | Applicable resources |
|--------|-------------|---------------------|
| `read` | View data, list queries | All |
| `create` | Create a new resource instance | All creatable |
| `update` | Modify an existing resource | All mutable |
| `delete` | Remove or deactivate a resource | All deletable |
| `github:act` | Perform a GitHub API mutation (branch protection, PR merge, label, collaborator) | repository |
| `github:read` | Perform a GitHub API read (fetch PR, list commits) | repository |
| `enqueue` | Submit a background job | repository, installation |
| `approve` | Authorize a governed workflow step | rollout_plan, repair_proposal |
| `revoke` | Revoke or invalidate a governed artifact | waiver, credential, session, delegation |
| `manage` | Administrative lifecycle (create/disable principals, roles, grants) | auth_principal, auth_role, auth_credential |
| `audit:read` | Read the canonical audit trail | audit_trail_entry, audit_export |
| `audit:export` | Generate compliance reports and exports | compliance_report |

### Permission naming convention

```
<resource-type>:<action>
```

Examples:
- `repository:read`
- `repository:update`
- `repository:github:act`
- `policy_waiver:revoke`
- `auth_principal:manage`
- `audit_trail_entry:audit:read`
- `rollout_plan:approve`

**No undeclared verbs.** Every permission uses an action from the table
above. `github:act` and `github:read` are separate actions — the previous
`github:mutate (read-only)` was self-contradictory and is removed.

### Scope modifiers

Each permission carries a scope:
- `own` — only resources the principal has an explicit grant on.
- `installation` — resources within the principal's installation grant(s).
- `fleet` — all installations (admin only).
- `system` — system-scoped resources (identity, audit, configuration).

---

## 5. Role composition

### Built-in roles

| Role | Key permissions | Scope | Principals |
|------|----------------|-------|------------|
| `admin` | all actions on all resources, including `manage` and `audit:export` | fleet + system | Human administrators |
| `operator` | `read` + `create` + `update` + `github:act` + `enqueue` on repositories; `read` on policy/waiver/gate | installation | Human operators |
| `reviewer` | `read` + `approve` on rollouts, repairs, gates | installation | Human reviewers |
| `viewer` | `read` only | installation | Human viewers |
| `service:webhook-worker` | `create` + `update` on installations, repositories | installation | P-4 webhook worker |
| `service:triage-worker` | `github:act` on repository; `update` on issues, managed_actions, decision_log | installation | P-4 triage worker |
| `service:heal-worker` | `github:act` on repository; `update` on ci_runs, heal_prs, managed_actions | installation | P-4 CI heal worker |
| `service:evidence-worker` | `update` on repair_proposals; `enqueue` diagnosis | installation | P-4 evidence worker |
| `service:diagnosis-worker` | `update` on repair_proposal_events; `enqueue` patch | none (no GitHub) | P-4 diagnosis worker |
| `service:patch-worker` | `update` on patch_artifacts, repair_proposal_events; `enqueue` verification | none (no GitHub) | P-4 patch worker |
| `service:verification-worker` | `github:read` on repository; `create` on execution_receipts, source_snapshots | installation (read-only) | P-4 verification worker |
| `service:critic-worker` | `update` on repair_proposal_events | none (no GitHub) | P-4 critic worker |
| `service:sync-worker` | `create` + `update` on installations, repositories, issues, pull_requests, ci_runs, members, collaborators, branch_rules; `github:read` | fleet | P-2 sync worker |
| `service:maintainer-worker` | `github:act` on repository; `update` on maintainer_actions, maintainer_settings | installation | P-4 maintainer worker |
| `service:issue-fix-worker` | `github:act` on repository; `update` on fix_attempts, managed_actions | installation | P-4 issue fix worker |
| `service:merge-queue-worker` | `github:act` on repository (merge); `update` on merge_queue_entries, rollback_events | installation | P-4 phase2 worker |
| `service:policy-worker` | `github:act` on repository; `update` on policy_repo_configs, dependency_*, flaky_tests, vulnerability_advisories | installation + fleet | P-4 phase3 worker |
| `service:review-worker` | `github:act` on repository (reviews, check-runs); `update` on ai_reviews, audit_exports | installation | P-4 phase4 worker |
| `service:reconciler` | `github:read` on repository; `update` on managed_actions, heal_prs | system | `setInterval` reconciliation timer |
| `service:bot` | `read` on repositories, issues, activity; `enqueue` fix/triage triggers | installation (linked-user-scoped) | Telegram bot |
| `legacy-key` | `read` + `create` + `update` + `enqueue` on installation-scoped resources; **no** `manage`, `approve`, `revoke`, `audit:export` | installation (mapped) or fleet (if unmapped, fail-closed) | Existing shared-key clients |

### Role assignment

```text
auth_principal_roles
  principal_id    UUID FK → auth_principals
  role_id         UUID FK → auth_roles
  scope_type      ENUM('installation', 'repository', 'fleet', 'system')
  scope_id        bigint NULL  -- installation_id or repo github_id; NULL for fleet/system
  granted_at      timestamptz
  granted_by      UUID FK → auth_principals
  expires_at      timestamptz NULL
  revoked_at      timestamptz NULL
  revoked_by      UUID FK NULL → auth_principals
  revocation_reason text NULL
```

Role assignments are durable — revocation sets `revoked_at`, never deletes.

---

## 6. Evaluation algebra

### Inputs

| Input | Source | Description |
|-------|--------|-------------|
| `principal` | Authentication stage | Resolved principal with active roles |
| `credential` | Authentication stage | The credential used (token, session, HMAC delivery) |
| `resource_type` | Route definition | The resource class being accessed |
| `resource_id` | Route params or body | The specific instance (NULL for list/create) |
| `action` | Route → operation policy | The required action verb |
| `operation_policy` | Route registry | Route-level required permissions and classification |

### Evaluation algorithm (deterministic)

```
STEP 1: Resolve principal
  authenticated_principal = authenticate(token_or_session_or_hmac)
  if not authenticated_principal:
    return DENY(reason=no_authenticated_principal)

STEP 2: Resolve resource
  resource = resolve_resource(route_params, resource_type)
  if resource_type is installation-scoped and resource not found:
    return DENY(reason=resource_not_found)

STEP 3: Load active roles
  roles = SELECT FROM auth_principal_roles
    WHERE principal_id = authenticated_principal.id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
    AND scope matches resource:
      - scope_type='fleet' or 'system' → matches all
      - scope_type='installation' → matches if resource.installation_id = scope_id
      - scope_type='repository' → matches if resource.repository_id = scope_id
  if roles is empty:
    return DENY(reason=no_active_role)

STEP 4: Compute role permission set
  role_perms = union of all role.permissions for each role in roles
  if action not in role_perms:
    return DENY(reason=role_permission_missing)

STEP 5: Check explicit denies
  denies = SELECT FROM auth_resource_grants
    WHERE principal_id = authenticated_principal.id
    AND resource_type matches (or parent resource matches via inheritance)
    AND effect = 'deny'
  if any deny matches (resource_type, action):
    return DENY(reason=explicit_deny)

STEP 6: Check credential scope
  if credential.scopes is not empty AND action not in credential.scopes:
    return DENY(reason=credential_scope_denied)
  if credential.resource_restriction does not include resource:
    return DENY(reason=credential_resource_restricted)
  if credential.environment_restriction != current_environment:
    return DENY(reason=wrong_environment)
  if credential.expired:
    return DENY(reason=expired)

STEP 7: Check resource grants (explicit allows)
  grants = SELECT FROM auth_resource_grants
    WHERE principal_id = authenticated_principal.id
    AND resource_type matches
    AND effect = 'allow'
  if no allow grant matches AND action requires explicit grant:
    -- 'own' scope actions require an explicit allow grant on the resource
    -- 'installation' scope actions are satisfied by role + installation match
    return DENY(reason=resource_grant_missing)

STEP 8: Check operation policy
  if action requires re-authorization (sensitive operation):
    re-read roles and grants from DB (do not use cached session claims)
    if any step 3-7 check fails on re-read:
      return DENY(reason=reauthorization_failed)

STEP 9: Issue decision
  decision_id = generate UUID
  record decision with all inputs and the decision_id
  return ALLOW(decision_id)
```

### Resource grant canonical shape

```text
auth_resource_grants
  id              UUID primary key
  principal_id    UUID FK → auth_principals
  resource_type   text          -- e.g., 'repository', 'policy_waiver'
  resource_id     bigint NULL   -- NULL = all resources of this type within scope
  scope_type      ENUM('installation', 'repository', 'fleet', 'system')
  scope_id        bigint NULL
  action          text          -- from the action vocabulary; or '*' for all
  effect          ENUM('allow', 'deny')
  granted_at      timestamptz
  granted_by      UUID FK → auth_principals
  expires_at      timestamptz NULL
  revoked_at      timestamptz NULL
  revoked_by      UUID FK NULL → auth_principals
  revocation_reason text NULL
```

**Grant specificity:** a grant on a specific `resource_id` is more specific
than a grant on `resource_id IS NULL` (all instances). Deny at a more
specific level overrides allow at a less specific level. Allow at a more
specific level does not override deny at a less specific level.

### Decision record

Every evaluation produces a decision with a unique `decision_id`:

```json
{
  "decision_id": "uuid-v4",
  "decision": "allow|deny",
  "principal_id": "...",
  "credential_id": "...",
  "resource_type": "repository",
  "resource_id": 12345,
  "action": "repository:update",
  "route": "PUT /api/config/:owner/:repo",
  "reason_code": "...",
  "role_permissions_version": "hash of active roles",
  "credential_scopes_evaluated": true,
  "resource_grants_evaluated": true,
  "operation_policy_version": "hash of route registry",
  "timestamp": "..."
}
```

The `decision_id` is referenced by delegations (§9) to bind a worker's
execution to the specific authorization decision that permitted it.

---

## 7. Default-deny and explicit-deny semantics

- **Default deny:** if no allow rule matches at any layer, the decision is
  `DENY` with reason `no_matching_allow`.
- **Explicit deny precedence:** an explicit deny grant overrides any allow
  from role, credential, or resource grant. Denial reason: `explicit_deny`.
- **Evaluation order for denies:** explicit deny is checked at step 5,
  before credential and resource-grant evaluation. If deny matches, the
  result is immediately deny regardless of other factors.
- **Deny specificity:** a deny on a specific resource overrides an allow on
  the parent resource. An allow on a specific resource does NOT override a
  deny on the parent.
- **No implicit allow from authentication:** being authenticated is
  necessary but not sufficient. The principal must also have an allow rule
  for the specific resource+action.

---

## 8. Tenant and repository boundaries

### Current defect (F-09)

List endpoints default to global scope — all installations' data in one
response. No `installation_id` filter unless the caller provides
`:owner/:repo`.

### Proposed fail-closed model

Tenant isolation is enforced by a **query-building interceptor**, not by
individual route handlers. The interceptor:

1. Reads `req.auth.installationIds` (populated by the authorization stage).
2. Injects `WHERE installation_id = ANY($granted_installations)` into every
   query that touches installation-scoped tables.
3. If the route is a list endpoint and `req.auth.installationIds` is empty,
   returns an empty result set (not an error — the principal simply has no
   visible installations).
4. If the route targets a specific `:owner/:repo`, the interceptor verifies
   the resolved repository's `installation_id` is in the granted set.

**This is fail-closed:** a route handler that forgets to request tenant
filtering gets nothing, because the interceptor applies to all queries
against installation-scoped tables. The route cannot bypass it by omitting
a parameter. The interceptor is registered at the database-access layer
(e.g., a query builder wrapper or Postgres RLS policy), not at the route
layer.

### Worker scope

Workers receive installation scope from the job payload, but the job's
authorization is validated at enqueue time via the job-authorization
capability (§14). A queue-injected job without a valid capability token
is rejected.

---

## 9. Ownership, creation, and delegation

### Separation of creation and authority

**Creation is provenance, not authority.** The `created_by` field records
which principal created a resource for audit purposes. It does NOT grant
the creator any authorization over the resource.

Examples:
- The sync worker creates `repository` rows by importing from GitHub.
  The worker is `created_by`, but it does not "own" the repository in an
  authorization sense. The repository's tenant assignment comes from its
  `installation_id`, not from the creator.
- A human operator creates a `policy_waiver`. The operator is `created_by`.
  The waiver belongs to the installation, not to the operator personally.

### Resource ownership

Governed resources have:
- `created_by` — the principal that created the record (provenance only).
- `installation_id` — the tenant the resource belongs to (for
  installation-scoped resources).
- Authorization grants — explicit `auth_resource_grants` entries that
  determine who can access the resource (separate from creation).

### Delegation model

A principal can delegate a subset of their authority to a worker via a
durable delegation record:

```text
auth_delegations
  id                        UUID primary key
  initiating_principal_id   UUID FK → auth_principals
  worker_service_principal_id UUID FK → auth_principals
  operation                 text        -- e.g., 'verify-proposal', 'heal-run'
  resource_type             text
  resource_id               bigint NULL
  authorization_decision_id UUID        -- links to the decision that approved this delegation
  plan_hash                 text NULL   -- for immutable approved plans
  created_at                timestamptz
  expires_at                timestamptz
  execution_status          ENUM('pending', 'executing', 'completed', 'cancelled', 'denied')
  revoked_at                timestamptz NULL
  revoked_by                UUID FK NULL → auth_principals
  revocation_reason         text NULL
```

### Delegation chains

Delegations are not limited to human → worker. The full chain includes:

| Initiator | Worker | Operation | Example |
|-----------|--------|-----------|---------|
| `user` (operator) | `service:heal-worker` | `heal-run` | Operator triggers heal from dashboard |
| `installation` (webhook) | `service:webhook-worker` | `webhook-dispatch` | GitHub webhook → queue dispatch |
| `system` (scheduler) | `service:sync-worker` | `full-sync` | Cron timer → sync job |
| `system` (scheduler) | `service:policy-worker` | `policy-reconcile-fleet` | Cron timer → fleet reconciliation |
| `service:patch-worker` | `service:verification-worker` | `verify-proposal` | Worker-to-worker chain |
| `service:verification-worker` | `service:critic-worker` | `critic-review` | Worker-to-worker chain |

Each link in the chain creates its own delegation record. The
`authorization_decision_id` links to the specific decision that authorized
this delegation.

### Revocation-after-enqueue

**Sensitive operations** (policy promotion, credential management, branch
deletion, merge) require the initiating principal's authority to be
non-revoked at execution time. If the principal is disabled or their grant
is revoked between enqueue and execution, the job is cancelled.

**Immutable approved plans** may complete even if the initiating principal
is later disabled, provided:
- The plan was explicitly approved (separate decision).
- The approved artifact is immutable and hash-bound.
- The delegation has not been explicitly revoked.
- The execution window has not expired.

---

## 10. Service-account scope

### All 14 workers + reconciliation mapped

See §5 role table. Every worker from the W0-A inventory (§6.1) has a
dedicated service role. The reconciliation timer (not a BullMQ worker)
maps to `service:reconciler` with `system` scope.

### Credential lifecycle

| Aspect | Specification |
|--------|---------------|
| **Proof** | HMAC-SHA-256 with a server-side pepper. Token = `<display_prefix>.<random_lookup_id>.<random_secret>`. Store only `HMAC(secret, pepper_version)`. |
| **Storage** | Raw token never persisted. Only the HMAC hash and the lookup ID are stored. Pepper is in a separate config source (env var or sealed file). |
| **Rotation** | New credentials use the current pepper version. Active credentials reference their hash version. Old peppers remain available until no active credential references them. A pepper is removed only after verified zero dependents. |
| **Revocation** | Immediate: set `auth_credentials.revoked_at`. Session/cache invalidation via `auth_epoch` increment. |
| **Audience** | Each credential declares its intended consumer (e.g., `gitwire-app`, `executor-service`, `bot`). A credential presented to the wrong audience is rejected. |
| **Verification** | Lookup by `lookup_id` (full random, collision-resistant). Compare `HMAC(received_secret, pepper_version)` to stored hash. Constant-time comparison. |
| **Environment binding** | Credentials may be restricted to `production`, `staging`, or `isolated`. A production credential used in staging is rejected. |
| **Session token treatment** | Session tokens are not stored raw in Redis. `HMAC(session_token, session_pepper_version)` is the Redis key. Only the derived lookup value is stored. |

---

## 11. Break-glass and emergency access

### Break-glass principal

- A dedicated `break_glass` role with fleet-wide + system permissions.
- Activated only through a separate audited mechanism (not a normal login).
- Break-glass sessions have short absolute expiry (e.g., 30 minutes).
- Every action is tagged `break_glass` in the audit log.
- Break-glass triggers an alert to all active administrators.

### Bootstrap re-enable authority

If all administrators are locked out, bootstrap is re-enabled by direct
database access (§2). The operator:
1. Has production DB credentials (separate from application credentials).
2. Inserts a row into `auth_bootstrap_allow(consumer_secret_hash, created_by_db_session, created_at)`.
3. The application checks this table on startup and during health checks.
4. The marker is consumed exactly once (deleted after successful bootstrap).
5. This is the ONLY way to re-enable bootstrap — there is no API route for it.

### Legacy-key fail-closed

Fleet-wide shared keys that cannot be mapped to a specific installation:
- Default to `fleet` scope with `legacy-key` role (read + create + update +
  enqueue on installation-scoped resources).
- **Fail-closed:** if a legacy key is neither installation-mapped nor
  explicitly assigned fleet scope, it is rejected with
  `denied:unmapped_legacy_key`.
- Each legacy key carries an expiry date. After expiry, the key is rejected
  regardless of scope.
- Migration tracking: each key links to a migration ticket. Alerts fire as
  expiry approaches.

---

## 12. Decision context and denial reasons

### Denial reason codes

| Code | Step | Meaning |
|------|------|---------|
| `no_authenticated_principal` | 1 | No valid credential presented |
| `resource_not_found` | 2 | Resource does not exist or is not visible |
| `no_active_role` | 3 | Principal has no active role assignments matching this resource |
| `role_permission_missing` | 4 | The required action is not in any of the principal's role permissions |
| `explicit_deny` | 5 | An explicit deny grant matched this resource + action |
| `credential_scope_denied` | 6 | The credential's scope does not include this action |
| `credential_resource_restricted` | 6 | The credential is restricted to different resources |
| `wrong_environment` | 6 | The credential is restricted to a different environment |
| `expired` | 6 | The credential, role, or grant has expired |
| `resource_grant_missing` | 7 | No explicit allow grant on this resource (required for 'own' scope) |
| `reauthorization_failed` | 8 | Sensitive operation re-check failed (principal/grant changed) |
| `missing_job_authorization` | Worker | Job lacks a valid authorization capability (F-06) |
| `unmapped_legacy_key` | Legacy | Legacy key has no installation or fleet mapping |
| `disabled` | Any | Principal or credential is disabled |

### External error responses

Externally, all denials return `403 Forbidden` with
`{"error": "insufficient_permissions"}`. Detailed reason codes appear only
in internal audit events.

---

## 13. Compatibility treatment for existing paths

### Legacy shared-key bridge

The current `API_KEY`/`API_KEYS` model maps to `legacy-key` principals.
Each key fingerprint is registered as a temporary principal:

- **Allowed:** `read` + `create` + `update` + `enqueue` on
  installation-scoped resources.
- **Denied:** `manage`, `approve`, `revoke`, `audit:export`, `audit:read`.
- **Scope:** installation-mapped if possible; fleet if explicitly assigned;
  fail-closed if unmapped.
- **Migration ticket:** each key has an expiry date and linked ticket.
- **Usage inventory:** every use records credential fingerprint, route,
  operation, repository, source address, user agent, timestamp.

### Anonymous paths

| Path | Current | Proposed |
|------|---------|----------|
| `GET /health` | Anonymous | Remains anonymous. Liveness signal only. |
| `POST /webhooks/github` | HMAC | Remains HMAC. Authenticates as `installation` principal. |
| `POST /api/auth/login` | Key exchange | Anonymous (resolves to principal after identity check). |
| `POST /api/auth/logout` | Cookie | Anonymous (session destruction). |
| `GET /api/auth/check` | Session probe | Anonymous (returns session validity only). |

### GitHub comment commands (F-07 resolution)

The `/gitwire fix`, `/gitwire close` etc. commands issued via GitHub issue
comments are NOT a Telegram linked-user flow. They arrive via the webhook
ingress path:

1. GitHub issue-comment webhook arrives with HMAC verification.
2. `commentRouter.js:27` checks `authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}`.
3. The role check is currently **discarded** at queue time — the queued job
   carries only `authorLogin`.

**Proposed resolution:** the queued job carries the verified GitHub user
identity (resolved from the webhook, not from client input). The worker
creates or resolves a `user` principal from `github_user_id`. The action
is evaluated using:

```text
initiating user's permissions
  ∩ installation scope
  ∩ operation policy
```

The role is NOT discarded. If the user's GitHub role was OWNER at webhook
time but the webhook payload is replayed after the user is demoted, the
delegation's `expires_at` and one-time consumption (§14) prevent replay.

---

## 14. Job-authorization capability (F-06 closure)

### Capability token

Every job enqueued into BullMQ carries a signed capability token:

```json
{
  "version": 1,
  "decision_id": "<UUID of the authorization decision>",
  "initiating_principal_id": "<UUID>",
  "worker_service_principal_id": "<UUID>",
  "operation": "heal-run",
  "queue_name": "ci-healing",
  "job_name": "heal-run",
  "installation_id": 12345,
  "repository_id": null,
  "payload_hash": "sha256:<hash of the immutable job payload>",
  "issuer": "gitwire-app",
  "audience": "ci-healing-worker",
  "key_id": "<which signing key was used>",
  "issued_at": "2026-07-21T12:00:00Z",
  "expires_at": "2026-07-21T13:00:00Z",
  "jti": "<unique token ID for one-time consumption>"
}
```

### Binding properties

- **Payload hash:** the token is bound to `sha256` of the job's immutable
  payload. If the payload is modified after enqueue, the hash mismatches
  and the token is rejected.
- **Queue and job name:** the token specifies which queue and job name it
  is valid for. A token issued for `ci-healing:heal-run` cannot be used
  for `verification:verify-proposal`.
- **Installation/repository identity:** the token binds to specific
  installation and repository IDs. A token for installation A cannot be
  replayed for installation B.
- **Issuer:** the principal that created the token (typically `gitwire-app`).
- **Audience:** the worker service principal that is authorized to consume
  this token.
- **Key ID:** identifies which signing key was used, supporting key rotation.
- **JTI (JWT ID):** a unique token identifier for one-time consumption.
  The worker records the JTI in Redis with a TTL matching `expires_at`.
  A replayed JTI is rejected.
- **One-time consumption:** after the worker processes the job, the JTI is
  marked consumed. Any replay attempt is denied.

### Worker verification

At dequeue time, the worker:
1. Extracts the capability token from `job.data.__capability`.
2. Verifies the signature using the identified key.
3. Checks `audience` matches its own service principal ID.
4. Checks `expires_at` has not passed.
5. Checks `payload_hash` matches `sha256(job.data)` (excluding the token itself).
6. Checks `queue_name` and `job_name` match the current queue and job.
7. Checks `jti` has not been consumed (Redis lookup).
8. Marks `jti` as consumed.
9. If all checks pass, executes with the delegated authority.

If any check fails, the job is rejected with `denied:missing_job_authorization`.

### Signing key management

- The capability signing key is separate from the API key and the
  executor-service token.
- Stored as an env var (`GITWIRE_CAPABILITY_SIGNING_KEY`) or derived from
  a master key.
- Key rotation: the `key_id` field identifies which key signed the token.
  Old keys remain valid until all tokens signed with them have expired.
  New tokens use the current key.

---

## 15. Finding resolution matrix

How the proposed model addresses each W0-A finding:

| Finding | Severity | Resolution |
|---------|----------|------------|
| **F-01** | CRITICAL | `GITHUB_WEBHOOK_SECRET` defaults to `"dev-secret"` in any environment (`config/index.js:170`). **Not yet fixed** — PR #40 hardened `API_KEY` fail-closed, not the webhook secret. Model requires production startup to fail-closed on unset `GITHUB_WEBHOOK_SECRET`, same pattern as `API_KEY`. |
| **F-02** | HIGH | `revokeWaiver(id)` has no tenant filter. Model requires resource-scoped authorization. Waiver revocation checks `installation_id` via the query interceptor (§8). Legacy-key bridge narrows to installation scope. |
| **F-03** | HIGH | Audit-attribution forgery. Model attaches authenticated `principal_id` to every request. Actor fields derived from `req.auth.principalId`, not from client-supplied headers. |
| **F-04** | LOW | Non-constant-time executor-service compare. Model specifies constant-time comparison for all credential checks (§10). Low priority — private-network boundary. |
| **F-05** | HIGH | Webhook replay. Model requires delivery-dedupe BEFORE side effects. The capability token (§14) binds the job to the specific verified delivery via `payload_hash` and one-time `jti`. |
| **F-06** | HIGH | Trust-the-payload worker model. Capability token (§14) signed at enqueue time, verified at dequeue with payload hash binding, audience check, one-time consumption. Job without valid token is rejected. |
| **F-07** | HIGH | GitHub comment-command authority discard (not Telegram). The `/gitwire` comment commands arrive via webhook. Role is verified at webhook ingress and carried in the capability token — not discarded at queue time. Delegation binds to the verified GitHub user identity. |
| **F-08** | MEDIUM | Auto-generated key logged. Production fail-closed for `API_KEY` (fixed in PR #40). Model requires explicit credential provisioning — no auto-generation in production. |
| **F-09** | HIGH | List endpoints global by default. Query-building interceptor (§8) enforces installation scoping at the data-access layer. Fail-closed: missing scope = empty result, not data leak. |
| **F-10** | HIGH | Fleet reconciler has no pillar gate. Model requires explicit operation policy on every scheduled job. The reconciler's operation policy declares its required permissions and resource scope. The `reconcile_skip` DB column remains as a per-repo opt-out, but the operation itself must pass the authorization evaluation. |
| **F-11** | MEDIUM | Audit hash chain race-fork. Model specifies synchronized chain computation (transactional SELECT-then-INSERT or equivalent). PR 5 of the identity plan repairs the ledger. |
| **F-12** | MEDIUM | `audit_exports` phantom file. Model requires audit exports to either write the file or not claim a path. Design debt — tracked separately from the authority model. |
| **F-13** | LOW | SQL syntax bug. Not an authority-model issue. Separated into issue #79. |
| **F-14** | LOW | `Set.has` non-constant-time. Model specifies constant-time comparison (§10). Low priority. |
| **F-15** | LOW | Local private key on disk. Operator hygiene. `.gitignore` coverage is the control. Not changed by the authority model. |

---

## What this model does NOT do

- Does not implement runtime authorization enforcement.
- Does not create database migrations.
- Does not modify the frozen P2 stress engine.
- Does not introduce a new identity provider beyond the existing GitHub App.
- Does not define the schema in SQL (that is W0-C).
- Does not define the validation plan (that is W0-D).
- Does not record ADRs (that is W0-D).

The next checkpoint (W0-C) will translate this model into a no-execution
schema migration plan. W0-D will record the ADRs and validation plan.
