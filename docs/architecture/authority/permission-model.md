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

### Bootstrap state machine

Bootstrap has two states:

| State | Meaning | How to reach |
|-------|---------|-------------|
| `enabled` | Bootstrap endpoint is mounted and accepts the operational secret | Initial state (fresh deploy with no admins); or `disabled` → `enabled` when application detects `auth_bootstrap_allow` marker |
| `disabled` | Bootstrap endpoint is removed from the route table | After successful bootstrap; marker consumed |

**State transitions:**
1. Fresh deployment starts in `enabled` (zero admin principals).
2. Successful bootstrap → `disabled` (admin created, endpoint unmounted,
   marker consumed).
3. If all admins are disabled (lockout), an operator with production DB
   credentials inserts into `auth_bootstrap_allow(consumer_secret_hash,
   created_by_db_session, created_at)`.
4. The application detects the marker on startup/health check and
   transitions to `enabled` via the stored function.
5. On successful bootstrap, the stored function transitions to `disabled`
   and consumes (deletes) the marker in the same transaction.

**Privilege boundary:**
- **Operator DB role:** can INSERT into `auth_bootstrap_allow`. Cannot
  authenticate to the application API.
- **Application DB role:** cannot INSERT/UPDATE/DELETE
  `auth_bootstrap_allow` or `auth_bootstrap_state` directly. All
  transitions go through stored functions:
  - `transition_bootstrap_state(new_state text)` — accepts `'enabled'`
    or `'disabled'`. When transitioning to `'enabled'`, it verifies a
    marker exists in `auth_bootstrap_allow`. When transitioning to
    `'disabled'` after bootstrap, it deletes the marker in the same
    transaction.
  - The application calls `transition_bootstrap_state('enabled')` when
    it detects a marker, and `transition_bootstrap_state('disabled')`
    after successful bootstrap.
  - Neither function accepts arbitrary SQL; they are SECURITY DEFINER
    functions owned by the operator DB role.

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
│   ├── reconciliation_run
│   └── webhook_delivery
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
| **Installation-scoped** | repository and all its children; policy, waiver, gate, rollout, queue, maintainer settings; decision_log; repair_proposal_events; managed_actions; rollback_events; policy_repo_configs; reconciliation_runs; config_validation_results; pipeline_events; test_results; gate_evaluations; backend_isolation_evidence; action_reconciliation_log | Tenant-scoped |
| **Identity-scoped** | auth_principal, auth_role, auth_credential, auth_delegation, auth_resource_grant, auth_bootstrap_allow | System-scoped; not tenant-filtered |
| **System-scoped** | audit_trail_entry, audit_export, compliance_report, system configuration; queue/job targets | Fleet-wide |
| **Worker-internal** | execution_receipts, source_snapshots, patch_artifacts, fix_attempts, ai_reviews, duplicate_signals, dependency_manifests, dependency_update_batches, vulnerability_advisories, flaky_tests, issue_embeddings, members, repo_collaborators, branch_rules | Installation-scoped (child of repository or installation) |

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
| `read` | View a specific resource | All |
| `list` | Enumerate resources (list endpoints) | All |
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
- `fleet` — all installation-scoped resources across all installations (admin only).
- `system` — **system-scoped resources only** (identity, audit, configuration, queues). A principal needing both fleet and system authority must receive both explicitly. `system` scope does NOT match installation-scoped resources.

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
| `service:diagnosis-worker` | `update` on repair_proposal_event; `enqueue` patch | installation (via delegation) | P-4 diagnosis worker — scope is installation because it mutates installation-scoped records; delegation provides the installation context |
| `service:patch-worker` | `update` on patch_artifact, repair_proposal_event; `enqueue` verification | installation (via delegation) | P-4 patch worker — same reasoning |
| `service:verification-worker` | `github:read` on repository; `create` on execution_receipts, source_snapshots | installation (read-only) | P-4 verification worker |
| `service:critic-worker` | `update` on repair_proposal_event | installation (via delegation) | P-4 critic worker — mutates installation-scoped records |
| `service:sync-worker` | `create` + `update` on installations, repositories, issues, pull_requests, ci_runs, members, collaborators, branch_rules; `github:read` | fleet | P-2 sync worker |
| `service:maintainer-worker` | `github:act` on repository; `update` on maintainer_actions, maintainer_settings | installation | P-4 maintainer worker |
| `service:issue-fix-worker` | `github:act` on repository; `update` on fix_attempts, managed_actions | installation | P-4 issue fix worker |
| `service:merge-queue-worker` | `github:act` on repository (merge); `update` on merge_queue_entries, rollback_events | installation | P-4 phase2 worker |
| `service:policy-worker` | `github:act` on repository; `update` on policy_repo_configs, dependency_*, flaky_tests, vulnerability_advisories | installation | P-4 phase3 dependency/scan worker |
| `service:fleet-reconciler` | `github:act` on repository (branch protection, labels, repo settings); `update` on policy_repo_configs, reconciliation_runs | fleet | P-4 phase3 fleet reconciler (separated from dependency worker) |
| `service:review-worker` | `github:act` on repository (reviews, check-runs); `update` on ai_reviews, audit_exports | installation | P-4 phase4 worker |
| `service:reconciler` | `read` on managed_actions, heal_prs; `update` on managed_actions reconciliation fields only | fleet | `setInterval` reconciliation timer — operates on installation-scoped tables, so scope is `fleet` not `system` |
| `installation` | (webhook ingress) `enqueue` to all worker queues; `create` on `webhook_delivery` | installation | P-3 GitHub App installation (HMAC-verified webhook) |
| `system:scheduler` | (scheduled jobs) `enqueue` on all worker queues; triggers sync, reconciliation, dependency scan, graduation, audit export | fleet | Cron timers that initiate fleet-wide scheduled operations |
| `system` | (migration/bootstrap) `manage` on identity resources during migration; `create` on auth_principal during bootstrap; `manage` on auth_bootstrap_state transitions | system | Migration runner, bootstrap mechanism |
| `service:executor` | (executor-service) no DB, no GitHub, no network egress. Executes allowlisted npm commands in isolated container. Returns results to caller. | none (no resource access) | P-6 executor-service |
| `service:bot` | `read` on repositories, issues, activity; `enqueue` fix/triage triggers | installation (linked-user-scoped) | Telegram bot |
| `legacy-key` | `read` + `create` + `update` + `enqueue` on installation-scoped resources; **no** `manage`, `approve`, `revoke`, `audit:export` | installation (explicitly mapped) only — **no automatic fleet default**; unmapped keys are rejected | Existing shared-key clients |

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

The algorithm evaluates a request through eleven steps. Each step either
returns `DENY_AND_RECORD` with a deterministic reason or continues. The
first applicable `DENY_AND_RECORD` terminates evaluation. **Every denial
produces a decision record** with a `decision_id`, just as allows do —
the record includes the step that denied, the reason code, and all inputs
evaluated up to that point.

### Compound operation policies

A route's operation policy compiles to **one permission expression** whose
leaves are evaluated exactly once. The expression is a tree of `all_of`
and `any_of` nodes over concrete `<resource_type>:<action>` leaves.

```
-- Example: operator can update config if they have read AND update
all_of([
  repository:read,
  repository:update
])

-- Example: approve via reviewer role OR admin role
any_of([
  all_of([policy_rollout_plan:read, policy_rollout_plan:approve]),
  auth_principal:manage
])
```

**Evaluation:** the evaluator walks the expression tree depth-first.
Each leaf is evaluated exactly once through steps 5-9 (role permission,
deny, credential, grant). `all_of` denies if any child denies (first
denial reason returned). `any_of` allows if any child allows; denies
with `operation_policy_denied` if all children deny. Leaves are memoized
so a permission appearing in multiple branches is evaluated once.

```
STEP 1: Authenticate principal
  authenticated_principal = authenticate(token_or_session_or_hmac)
  if not authenticated_principal:
    return DENY_AND_RECORD(reason=no_authenticated_principal)

STEP 2: Derive tenant scope (single structured value)
  -- Active roles: revoked_at IS NULL, expired roles excluded.
  active_roles = SELECT * FROM auth_principal_roles
    WHERE principal_id = authenticated_principal.id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())

  -- Build scope from active roles.
  scope = { installation_ids: Set(), repository_ids: Set(),
            fleet: false, system: false }

  for role in active_roles:
    if role.scope_type == 'fleet': scope.fleet = true
    if role.scope_type == 'system': scope.system = true
    if role.scope_type == 'installation': scope.installation_ids.add(role.scope_id)
    if role.scope_type == 'repository':
      scope.repository_ids.add(role.scope_id)
      -- Also add the repo's parent installation to installation scope
      parent_inst = resolve_parent_installation(role.scope_id)
      scope.installation_ids.add(parent_inst)

  -- Credential narrows at every level (intersection, never expansion).
  if credential restricts installations:
    scope.installation_ids = scope.installation_ids ∩ credential.installation_ids
    scope.repository_ids = scope.repository_ids ∩ repos_in(credentials.installation_ids)
  if credential restricts repositories:
    scope.repository_ids = scope.repository_ids ∩ credential.repository_ids
  if credential denies fleet:
    scope.fleet = false
  if credential denies system:
    scope.system = false

  -- Fail-closed: no visible scope at all.
  if scope.installation_ids is empty AND scope.repository_ids is empty
     AND not scope.fleet AND not scope.system:
    return DENY_AND_RECORD(reason=no_installation_scope)

STEP 3: Install data-access boundary
  -- The query gateway receives the full scope object.
  -- For installation-scoped tables: WHERE installation_id = ANY(scope.installation_ids)
  --   OR (scope.fleet IS TRUE) — no installation filter.
  -- For repository-scoped queries: additionally WHERE repo_id = ANY(scope.repository_ids)
  --   when scope.repository_ids is non-empty.
  -- For system/identity tables: WHERE TRUE only if scope.system IS TRUE.
  query_gateway.set_scope(scope)

STEP 4: Resolve resource within boundary
  resource = resolve_resource(route_params, resource_type)
  -- The resolver runs through the query gateway, so resources outside
  -- the principal's tenant scope are invisible (not found, not denied).
  -- For list/create actions (no :id param), resource_id is NULL;
  -- the resource_type is known from the route, and the query
  -- gateway handles scoping. No resource_not_found for list/create.
  if resource_type is installation-scoped AND action not in ('list', 'create'):
    if resource not found:
      return DENY_AND_RECORD(reason=resource_not_found)

STEP 5: Load active, non-expired roles (matching the resolved resource)
  roles = SELECT FROM auth_principal_roles
    WHERE principal_id = authenticated_principal.id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
    AND scope matches resource:
      - scope_type='fleet' → matches installation-scoped and fleet resources
      - scope_type='system' → matches ONLY system/identity-scoped resources
      - scope_type='installation' → matches if resource.installation_id = scope_id
      - scope_type='repository' → matches if resource.repository_id = scope_id
      -- For list/create (resource_id IS NULL): fleet matches all;
      -- installation matches scope_id in candidate_installation_ids;
      -- repository matches scope_id in candidate_repo_ids.
  if roles is empty:
    return DENY_AND_RECORD(reason=no_active_role)

STEP 6: Compute role permission set and check action
  role_perms = union of all role.permissions for each role in roles
  if action not in role_perms:
    return DENY_AND_RECORD(reason=role_permission_missing)

STEP 7: Check explicit denies
  denies = SELECT FROM auth_resource_grants
    WHERE principal_id = authenticated_principal.id
    AND resource_type matches (considering inheritance)
    AND effect = 'deny'
  if any deny matches (resource_type, action):
    return DENY_AND_RECORD(reason=explicit_deny)

STEP 8: Check credential scope
  if credential.scopes is not empty AND action not in credential.scopes:
    return DENY_AND_RECORD(reason=credential_scope_denied)
  if credential.resource_restriction does not include resource:
    return DENY_AND_RECORD(reason=credential_resource_restricted)
  if credential.environment_restriction != current_environment:
    return DENY_AND_RECORD(reason=wrong_environment)
  if credential.expired:
    return DENY_AND_RECORD(reason=expired)

STEP 9: Check resource grants (explicit allows — required for ALL scopes)
  grants = SELECT FROM auth_resource_grants
    WHERE principal_id = authenticated_principal.id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
    AND resource_type matches (exact match OR parent type via inheritance)
    AND effect = 'allow'
    AND (action = required_action OR action = '*')
    AND (
      -- Specific resource grant
      (resource_id IS NOT NULL AND resource_id = target.id)
      OR
      -- Scoped wildcard: all resources of this type within an allowed scope
      (resource_id IS NULL
       AND scope_type matches (scope.installation_ids contains scope_id
                                OR scope.fleet AND scope_type = 'fleet'
                                OR scope.system AND scope_type = 'system'))
    )
  if no allow grant matches:
    -- An explicit allow grant is required at every scope level.
    -- This makes resource_grants part of EVERY authorization intersection.
    return DENY_AND_RECORD(reason=resource_grant_missing)

STEP 10: Check operation policy (compound if needed)
  for each required permission in operation_policy:
    run steps 5-9 for that permission
    apply all_of / any_of composition
  if compound policy denies:
    return DENY_AND_RECORD(reason=operation_policy_denied)
  if operation_policy requires re-authorization (sensitive operation):
    re-read roles and grants from DB (do not use cached session claims)
    if any step 5-9 check fails on re-read:
      return DENY_AND_RECORD(reason=reauthorization_failed)

STEP 11: Issue decision
  decision_id = generate UUID
  record decision with all inputs, evaluated policy versions, and decision_id
  return ALLOW(decision_id)
```

### Resource grant canonical shape

```text
auth_resource_grants
  id              UUID primary key
  principal_id    UUID FK → auth_principals
  resource_type   text          -- e.g., 'repository', 'policy_waiver'
  resource_id     text NULL     -- bigint or UUID as string; NULL = all resources of this type within scope
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
- **Evaluation order for denies:** explicit deny is checked at step 7,
  after role permissions (step 6) and before credential scope (step 8).
  If deny matches, the result is immediately deny regardless of other factors.
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

### Proposed fail-closed model (two-phase evaluation)

Tenant isolation requires a two-phase sequence to avoid a resolution cycle:

**Phase A: Derive tenant scope (before resource resolution)**
1. Authenticate the principal.
2. Query `auth_principal_roles` for active role assignments to derive
   `candidate_installation_ids` (step 2 of the evaluation algebra).
3. Intersect with credential resource restrictions.

**Phase B: Install the data-access boundary**
4. The **mandatory query gateway** is the normative enforcement boundary.
   It is a Node.js query-builder wrapper that intercepts every SQL query
   against installation-scoped tables and injects
   `WHERE installation_id = ANY($candidate_installation_ids)`.
5. Resource resolution (step 4) runs through this gateway — resources
   outside the principal's tenant scope are invisible.
6. Operation policy evaluation (steps 5-11) then proceeds within the
   already-scoped boundary.

**PostgreSQL RLS is NOT the chosen boundary.** The mandatory query gateway
is the normative enforcement mechanism because:
- It is testable in CI without a production Postgres configuration.
- It handles dynamic per-request scope changes (per-credential restrictions).
- It provides structured denial reasons, not silent row filtering.

RLS may be added as defense-in-depth later, but the query gateway is the
authoritative boundary.

**Fail-closed behavior:** if `candidate_installation_ids` is empty AND
the principal has no fleet/system role, the gateway returns empty result
sets for all installation-scoped queries. A route that forgets to request
tenant filtering gets nothing — the gateway applies unconditionally to
all queries against installation-scoped tables.

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
  resource_id               text NULL
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
| `system:scheduler` | `service:sync-worker` | `full-sync` | Cron timer → sync job |
| `system:scheduler` | `service:fleet-reconciler` | `policy-reconcile-fleet` | Cron timer → fleet reconciliation |
| `service:patch-worker` | `service:verification-worker` | `verify-proposal` | Worker-to-worker chain |
| `service:verification-worker` | `service:critic-worker` | `critic-review` | Worker-to-worker chain |

Each link in the chain creates its own delegation record. The
`authorization_decision_id` links to the specific decision that authorized
this delegation.

### Worker role model: durable permission ceiling

Worker service roles are **durable, fleet-scoped permission ceilings**.
They define what actions the worker is *capable* of performing. The
**resource boundary** (which installations, repositories, and specific
resources the worker may touch) comes from the delegation, not from the
worker's role assignment.

```text
worker_role = durable permission ceiling (what actions the worker can do)
delegation  = resource boundary (which resources for this specific job)
```

Workers are NOT assigned installation-scoped roles. Instead:
- `auth_principal_roles` for workers uses `scope_type='fleet'` with the
  permission ceiling (e.g., `service:heal-worker` can do `repository:github:act`).
- The delegation record specifies the installation, repository, and
  resource_id that bound this specific execution.
- The query gateway is configured from the delegation's resource boundary,
  not from the worker's role scope.

### Two-principal intersection: two independent evaluations

When a worker executes under delegation, **two independent evaluations**
must both return `ALLOW` for the same operation and resource:

**Evaluation A: Initiating principal's delegated permission**
```
Does the initiating principal have a valid delegation for this
worker, operation, resource_type, and resource_id?
- Check auth_delegations for matching delegation
- Check not revoked, not expired, execution_status is pending/executing
- Check the authorization_decision that created it was valid at creation time
```

**Evaluation B: Worker service principal's role ceiling**
```
Does the worker's durable service role include the required action
for this resource type?
- Check auth_principal_roles for the worker principal
- Check role.permissions includes the action
- Check not revoked, not expired
```

Both must independently allow. If either denies, the result is deny.
The worker cannot exceed its ceiling (Evaluation B) or the initiator's
delegated scope (Evaluation A).

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
maps to `service:reconciler` with `fleet` scope (operates on
installation-scoped tables, not system-scoped identity resources).

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
- **No automatic fleet default.** A legacy key with no explicit scope
  assignment is rejected with `denied:unmapped_legacy_key`.
- Temporary fleet access requires an explicit, audited, expiring
  assignment recorded in `auth_principal_roles` with `scope_type='fleet'`,
  a `granted_by` principal, and an `expires_at`.
- Installation-mapped keys are scoped to that installation only.
- Each legacy key carries an expiry date. After expiry, the key is
  rejected regardless of scope assignment.
- Migration tracking: each key links to a migration ticket. Alerts fire
  as expiry approaches.

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
ingress path and are resolved entirely at ingress — not at dequeue time.

**Current defect:** `commentRouter.js:27` checks
`authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}` at ingress, but the
role is discarded at queue time — the job carries only `authorLogin`.

**Proposed resolution:** see §14 "F-07 resolution" for the complete
model. Summary:
- Identity resolved at webhook ingress (not dequeue).
- Command-specific, repository-bound, expiring delegation created at ingress.
- Every mutating command rechecks GitHub `authorAssociation` at execution.
- The verified GitHub permission is modeled as a **bounded external
  attestation** (see below), not an implicit role bypass.

### Bounded external attestation

A GitHub user's `authorAssociation` on a repository is an external
permission that GitWire cannot revoke but must verify. It is modeled
as a transient, operation-specific attestation:

```text
auth_external_attestations
  id              UUID primary key
  principal_id    UUID FK → auth_principals
  provider        text          -- 'github'
  repository_id   bigint        -- GitHub repo ID
  permission      text          -- 'OWNER', 'MEMBER', 'COLLABORATOR'
  verified_at     timestamptz
  expires_at      timestamptz  -- short (e.g., 5 minutes)
  delegation_id   UUID FK → auth_delegations
```

- Created at ingress when the webhook carries a verified
  `authorAssociation`.
- Bound to a specific delegation and command.
- Checked at execution for every mutating command (re-queried from
  GitHub API, not trusted from the stored attestation).
- Expires quickly — a stale attestation is not sufficient.
- Does NOT create a durable role or resource grant. The user has no
  standing authority beyond this specific attestation's scope.

---

## 14. Job-authorization capability (F-06 closure)

### Capability token

Every job enqueued into BullMQ carries a signed capability token:

```json
{
  "version": 1,
  "decision_id": "<UUID of the authorization decision>",
  "delegation_id": "<UUID referencing auth_delegations.id>",
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

### Worker verification (reservation protocol)

At dequeue time, the worker:
1. Extracts the capability token from `job.data.__capability`.
2. Verifies the Ed25519 signature using the identified public key.
   - Failure: `capability_invalid_signature`.
3. Checks `audience` matches its own service principal ID.
   - Failure: `capability_audience_mismatch`.
4. Checks `expires_at` has not passed.
   - Failure: `capability_expired`.
5. Checks `payload_hash` matches the canonical hash of the job payload.
   - Failure: `capability_payload_mismatch`.
6. Checks `queue_name` and `job_name` match the current queue and job.
   - Failure: `capability_queue_mismatch`.
7. **Acquires the JTI lease atomically:** see JTI consumption protocol
   (owner-bound lease with attempt_id, atomic Lua takeover for stale
   reservations).
   - If `"consumed"`: reject with `capability_jti_consumed`.
   - If stale lease (age > heartbeat_timeout): attempt atomic takeover.
   - If active lease (age ≤ heartbeat_timeout): reject with
     `capability_jti_in_use`.
   - If key expired: reject with `capability_jti_expired`.
   - If `"released"`: re-acquire via SET NX (clean failure, safe retry).
8. Resolves the delegation via `delegation_id` (checks not revoked,
   not expired, execution_status pending). Reject with
   `capability_delegation_invalid` if invalid.
9. Executes the job under the delegated authority (two independent
   evaluations, §9). The query gateway is configured from the
   delegation's resource boundary.
10. On completion: finalize JTI to `"consumed"` (owner-bound atomic).
    On failure: finalize JTI to `"released"` (owner-bound atomic).

**Retry semantics:** BullMQ retries carry the same JTI and delegation_id.
See the JTI consumption protocol for the complete state machine.

### Signing architecture

Capabilities use **asymmetric signing (Ed25519)** to ensure consuming
workers cannot forge capabilities:

- The **issuer** (gitwire-app) holds the private key and signs all tokens.
- **Consumers** (workers) hold only the public key and verify signatures.
- A worker with the public key cannot mint a valid token for another worker.
- Key rotation: new key pair generated periodically. `key_id` identifies
  which public key to use for verification. Old public keys remain
  available until all tokens signed with them have expired.

**No symmetric MAC alternative.** Per-audience MAC keys would allow any
consumer holding the shared key to forge capabilities for other audiences.
Asymmetric signing is the only architecture; there is no MAC fallback.

### JTI consumption protocol (owner-bound lease)

Capabilities use an **owner-bound lease** with atomic compare-and-swap
takeover. This supports safe retry after crashes without permitting
concurrent execution.

**Protocol:**

1. **Acquire lease:** worker attempts to set the JTI with its own
   unique attempt ID:
   ```text
   SET gitwire:jti:{jti} "{attempt_id}" NX EX {ttl_seconds}
   ```
   - `NX` ensures atomic first-acquire (no race window).
   - The value is the worker's unique attempt ID (UUID), binding the
     reservation to this specific execution attempt.

2. **Execute:** the worker processes the job.

3. **Finalize:** on completion:
   ```text
   -- Atomic: only the lease owner can finalize
   Lua: if GET(key) == attempt_id then SET(key, "consumed", EX, retention)
   ```
   On failure:
   ```text
   Lua: if GET(key) == attempt_id then SET(key, "released", EX, cleanup)
   ```

**Retry takeover (after crash):**
A retry attempt whose predecessor crashed (JTI still `"reserved"` with
a stale attempt_id) can take over:
```text
-- Atomic compare-and-swap: only if the old value is a stale reservation
-- whose TTL has been running longer than a worker heartbeat timeout.
Lua: if GET(key) == stale_attempt_id AND age(key) > heartbeat_timeout then
       SET(key, "{new_attempt_id}", EX, ttl)
```
This is atomic — two concurrent retry attempts cannot both succeed because
`GETSET` is not used; the Lua script is single-threaded in Redis.

**States:**
- `"{attempt_id}"` — leased by a specific attempt; takeover allowed after heartbeat timeout
- `"consumed"` — execution completed; all retries rejected with `capability_jti_consumed`
- `"released"` — execution failed cleanly; retry may re-acquire via SET NX
- Key expired — retry rejected with `capability_expired`

### Delegation binding

The capability token includes `delegation_id` (UUID referencing
`auth_delegations.id`). The worker resolves the delegation record to
obtain:
- The initiating principal ID (for Evaluation A, §9).
- The resource boundary (for the query gateway).
- The operation and plan_hash (for immutability verification).

If the delegation is revoked, expired, or in `denied` execution_status,
the capability is rejected with `capability_delegation_invalid`.

### Payload canonicalization

The `payload_hash` is computed over the **canonical JSON serialization**
of the job payload (excluding the capability token field):

```text
canonical = stable_stringify(job_data_without_capability)
payload_hash = "sha256:" + sha256(canonical)
```

`stable_stringify` produces RFC 8785 canonical JSON (sorted object keys,
no insignificant whitespace, UTF-8 encoding). This is deterministic across
Node.js versions and implementations.

### Deterministic capability denial codes

| Code | Meaning |
|------|---------|
| `capability_invalid_signature` | Signature verification failed |
| `capability_expired` | `expires_at` has passed |
| `capability_audience_mismatch` | Token audience does not match this worker |
| `capability_payload_mismatch` | `payload_hash` does not match the job payload |
| `capability_queue_mismatch` | Token queue/job name does not match current queue |
| `capability_jti_consumed` | JTI is already in `"consumed"` state |
| `capability_jti_expired` | JTI key has expired (TTL elapsed) |
| `capability_key_not_found` | `key_id` references an unknown signing key |

### F-07 resolution: command-specific expiring delegation with GitHub recheck

GitHub comment commands (`/gitwire fix`, `/gitwire close`) are mutating
operations triggered by a GitHub user on a specific repository. The
authority model resolves and binds this at webhook ingress — not at
dequeue time.

**At webhook ingress:**
1. `commentRouter.js:27` verifies
   `authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}`.
2. The webhook payload's GitHub user identity is resolved to a `user`
   principal via `github_user_id` lookup (created if absent).
3. **No durable installation-wide role is auto-assigned.** Instead, a
   **command-specific, repository-bound, expiring delegation** is created:
   - `operation`: the specific command (e.g., `fix-issue`, `close-issue`).
   - `resource_type`: `repository`, `resource_id`: the repo's github_id.
   - `expires_at`: short (e.g., 5 minutes from ingress).
   - `authorization_decision_id`: the decision that verified the
     GitHub `authorAssociation` at this moment.
4. The capability token binds this delegation. The verified GitHub role
   is part of the decision record, not discarded.

**At dequeue (worker execution):**
5. The worker verifies the capability (signature, audience, payload hash,
   JTI reservation).
6. For **every mutating command**, the worker rechecks the GitHub API
   for the user's current `authorAssociation` on the repository:
   - If still `OWNER`/`MEMBER`/`COLLABORATOR`: proceed.
   - If demoted or removed: reject with `reauthorization_failed`.
   This is NOT limited to "sensitive operations" — every `/gitwire`
   mutating command rechecks, because GitHub association can change
   between enqueue and execution.
7. The delegation expires after its short TTL. A replayed capability
   after expiry is rejected with `capability_expired`.

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

---

## 16. Decision-example matrix

Normative examples showing how the evaluation algebra resolves common
scenarios. Each example specifies the principal, resource, action, and
expected decision with reason code.

### Positive examples (allow)

| # | Principal | Resource | Action | Why allowed |
|---|-----------|----------|--------|-------------|
| P1 | `user` with `operator` role on installation 42 | repository octo-lex/gitwire (in installation 42) | `repository:update` | Role includes `update`; credential unrestricted; resource grant allows installation-scoped; operation policy permits |
| P2 | `service:heal-worker` with capability token for `heal-run` on repo X, explicit allow grant on repository X | repository X | `repository:github:act` | Capability token verified; delegation valid; service role includes `github:act`; step 9 resource grant matches |
| P3 | `user` with `admin` role (fleet) | auth_principal (any) | `auth_principal:manage` | Admin role has fleet+system scope; includes `manage` action; system grant allows |
| P4 | `installation` principal (HMAC-verified webhook), explicit allow grant on `webhook_delivery` | `webhook_delivery` (via webhook payload) | `webhook_delivery:create` | Installation principal role includes `create` on `webhook_delivery`; step 9 resource grant (allow, scope=installation) matches |
| P5 | `legacy-key` mapped to installation 42 | policy_waiver in installation 42 | `policy_waiver:read` | Legacy-key role includes `read`; installation-mapped to 42; grant allows |

### Negative examples (deny)

| # | Principal | Resource | Action | Denial reason |
|---|-----------|----------|--------|---------------|
| N1 | `user` with `operator` role on installation 42 | repository in installation 99 | `repository:read` | `resource_not_found` (outside tenant scope via query gateway) |
| N2 | `user` with `viewer` role | repository X | `repository:update` | `role_permission_missing` (viewer has `read` only) |
| N3 | `service:heal-worker` without capability token | repository X | `repository:github:act` | `missing_job_authorization` |
| N4 | `legacy-key` unmapped (no installation assignment) | any installation-scoped resource | any | `unmapped_legacy_key` |
| N5 | `user` with `operator` role, explicit deny grant on repository X | repository X | `repository:update` | `explicit_deny` (step 7: deny grant matched before credential scope at step 8) |
| N6 | `service:patch-worker` (no GitHub identity) | repository X | `repository:github:act` | `role_permission_missing` (patch-worker role lacks `github:act`) |
| N7 | `user` with expired credential | repository X | `repository:read` | `expired` (credential expired at step 8) |
| N8 | Worker job with consumed JTI (replay attempt) | any | any | `missing_job_authorization` (JTI already consumed) |
| N9 | `legacy-key` with fleet role + `manage` action | auth_principal | `auth_principal:manage` | `role_permission_missing` (legacy-key role excludes `manage`) |
| N10 | `user` with `viewer` role, compound any_of policy requiring approve permission | policy_rollout_plan | `rollout_plan:approve` | `operation_policy_denied` (compound any_of: no alternative allowed; reason is operation_policy_denied per §6 deterministic failure rule) |

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
