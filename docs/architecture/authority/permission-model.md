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
| **Installation-scoped** | repository and all its children; policy_definition, policy_waiver, quality_gate, policy_rollout_plan, maintainer_setting; decision_log; repair_proposal_events; managed_action; rollback_event; policy_repo_config; reconciliation_run; config_validation_result; pipeline_event; test_result; gate_evaluation; backend_isolation_evidence; action_reconciliation_log | Tenant-scoped |
| **Identity-scoped** | auth_principal, auth_role, auth_credential, auth_delegation, auth_resource_grant, auth_bootstrap_allow | System-scoped; not tenant-filtered |
| **System-scoped** | audit_trail_entry, audit_export, compliance_report, system configuration | Fleet-wide |
| **Transport-scoped** | queue_job | Not a tenant resource — see queue authority model below |
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
- `:id` body/path params → resource by ID (e.g., `repair_proposal`, `policy_waiver`).
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
| `approve` | Authorize a governed workflow step | policy_rollout_plan, repair_proposal |
| `revoke` | Revoke or invalidate a governed artifact | policy_waiver, auth_credential, auth_delegation |
| `manage` | Administrative lifecycle (create/disable principals, roles, grants) | auth_principal, auth_role, auth_credential |
| `audit:read` | Read the canonical audit trail | audit_trail_entry |
| `audit:export` | Generate audit exports | audit_export |

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
- `policy_rollout_plan:approve`

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
| `operator` | `read` + `create` + `update` + `github:act` + `enqueue` on `repository`; `read` on `policy_definition`, `policy_waiver`, `quality_gate` | installation | Human operators |
| `reviewer` | `read` + `approve` on `policy_rollout_plan`, `repair_proposal`, `quality_gate` | installation | Human reviewers |
| `viewer` | `read` only | installation | Human viewers |
| `service:webhook-worker` | `create` + `update` on installation, repository | ceiling | P-4 webhook worker |
| `service:triage-worker` | `github:act` on repository; `update` on issue, managed_action, decision_log | ceiling | P-4 triage worker |
| `service:heal-worker` | `github:act` on repository; `update` on ci_run, heal_pr, managed_action | ceiling | P-4 CI heal worker |
| `service:evidence-worker` | `update` on repair_proposal; `queue_job:enqueue` (diagnosis chain) | ceiling | P-4 evidence worker |
| `service:diagnosis-worker` | `update` on repair_proposal_event; `queue_job:enqueue` (patch chain) | ceiling | P-4 diagnosis worker |
| `service:patch-worker` | `create` on patch_artifact; `update` on repair_proposal_event; `queue_job:enqueue` (verification chain) | ceiling | P-4 patch worker |
| `service:verification-worker` | `github:read` on repository; `create` on execution_receipt, source_snapshot | ceiling | P-4 verification worker |
| `service:critic-worker` | `update` on repair_proposal_event | ceiling | P-4 critic worker |
| `service:sync-worker` | `create` + `update` on installation, repository, issue, pull_request, ci_run, member, repo_collaborator, branch_rule; `github:read` | ceiling | P-2 sync worker |
| `service:maintainer-worker` | `github:act` on repository; `create` on maintainer_action; `update` on maintainer_setting | ceiling | P-4 maintainer worker |
| `service:issue-fix-worker` | `github:act` on repository; `update` on fix_attempt, managed_action | ceiling | P-4 issue fix worker |
| `service:merge-queue-worker` | `github:act` on repository (merge); `update` on merge_queue_entry; `create` on rollback_event | ceiling | P-4 phase2 worker |
| `service:policy-worker` | `github:act` on repository; `update` on policy_repo_config, dependency_manifest, dependency_update_batch, flaky_test, vulnerability_advisory | ceiling | P-4 phase3 dependency/scan worker |
| `service:fleet-reconciler` | `github:act` on repository (branch protection, labels, repo settings); `update` on policy_repo_config; `read` on reconciliation_run | ceiling | P-4 phase3 fleet reconciler |
| `service:review-worker` | `github:act` on repository (reviews, check-runs); `create` on ai_review, audit_export | ceiling | P-4 phase4 worker |
| `service:reconciler` | `read` on managed_action, heal_pr; `update` on managed_action reconciliation fields only | fleet | `setInterval` reconciliation timer — operates on installation-scoped tables, so scope is `fleet` not `system` |
| `installation` | (webhook ingress) `installation:enqueue`, `repository:enqueue`; `create` on `webhook_delivery` | installation | P-3 GitHub App installation (HMAC-verified webhook) |
| `system:scheduler` | (scheduled jobs) `installation:enqueue` (fleet-wide); triggers sync, reconciliation, dependency scan, graduation, audit export | fleet | Cron timers that initiate fleet-wide scheduled operations |
| `system` | (migration/bootstrap) `manage` on identity resources during migration; `create` on auth_principal during bootstrap; `manage` on auth_bootstrap_state transitions | system | Migration runner, bootstrap mechanism |
| `service:executor` | (executor-service) no DB, no GitHub, no network egress. Executes allowlisted npm commands in isolated container. Returns results to caller. | none (no resource access) | P-6 executor-service |
| `service:bot` | `read` on `repository`, `issue`; `repository:enqueue`, `installation:enqueue` (fix/triage triggers) | installation (linked-user-scoped) | Telegram bot |
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

The algorithm evaluates a request through five steps. Steps 1-3 handle
authentication, scope derivation, and gateway installation. Step 4
evaluates the operation policy expression tree via `evaluate_leaf`,
which performs all resource/target resolution internally. Step 5 issues
the decision.
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
Each leaf is evaluated exactly once via `evaluate_leaf(leaf, context)`
(see below). `all_of` denies if any child denies (first
denial reason returned). `any_of` allows if any child allows; denies
with `operation_policy_denied` if all children deny. Leaves are memoized
so a permission appearing in multiple branches is evaluated once.

### evaluate_leaf(leaf, context)

Each leaf carries `resource_type`, `action`, and `selector`. The selector
defines how the **normalized target** is resolved. Every leaf resolves
exactly one target with the following shape:

```text
NormalizedTarget {
  selector:       'instance' | 'list' | 'create' | 'route-root' | 'inherited'
  resource_type:  canonical token from §17 registry
  instance_id:    text NULL    -- the specific resource ID (NULL for list/create)
  container_type: text NULL    -- parent/container resource type for create/list
  container_id:   text NULL    -- parent/container instance ID for create/list
  installation_id: bigint NULL -- ownership path: installation
  repository_id:   bigint NULL -- ownership path: repository (NULL if installation-scoped only)
}
```

The `installation_id` and `repository_id` fields carry the **complete
ownership path** derived from either the resolved instance (for
`instance`/`route-root`/`inherited`) or the destination container (for
`create`/`list`). Grant matching uses these fields to prove the principal
has authority over the exact destination — not just a wildcard scope.

| Selector | instance_id | container | When used |
|----------|-------------|-----------|-----------|
| `instance` | non-NULL (from `:id` route param) | n/a | Read/update/delete a specific resource |
| `list` | NULL | the scoping parent (installation or repository from route) | Enumerate resources within a scope |
| `create` | NULL | the destination parent (installation or repository from route/body) | Insert a new record |
| `route-root` | route-dependent | n/a | The resource identified by the route itself (e.g., installation from webhook) |
| `inherited` | parent's ID | n/a | Resource resolved via parent inheritance chain |

```
function evaluate_leaf(leaf, context):
  -- Resolve the normalized target based on selector.
  -- ALL resource resolution happens here — there is no global
  -- resolution step in the main algorithm. The leaf evaluator is the
  -- single authority for target resolution.
  target = resolve_target(leaf, context)
  if target is INVALID: return DENY(resource_not_found)

  -- Role permission check
  roles = context.active_roles WHERE scope matches target and leaf.resource_type
  if roles is empty: return DENY(no_active_role)
  if leaf.action not in union(roles.permissions): return DENY(role_permission_missing)

  -- Explicit deny (identical filters to allow)
  denies = SELECT FROM auth_resource_grants
    WHERE principal_id = context.principal.id
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    AND resource_type matches (exact OR parent via inheritance)
    AND effect = 'deny'
    AND (action = leaf.action OR action = '*')
    AND grant_matches_target(resource_id, target, scope)
  if denies is not empty: return DENY(explicit_deny)

  -- Credential scope + expiry + environment
  if credential.expired: return DENY(expired)
  if credential.environment != current_environment: return DENY(wrong_environment)
  if credential.scopes not empty AND leaf.action not in credential.scopes:
    return DENY(credential_scope_denied)
  if target.instance_id is not NULL AND credential restricts to resources not including target:
    return DENY(credential_resource_restricted)
  -- For create: the credential must also permit the destination container.
  if leaf.selector == 'create' AND credential restricts to installations/repos
     not including target.installation_id / target.repository_id:
    return DENY(credential_resource_restricted)

  -- Explicit allow (identical filters to deny, minus effect)
  allows = SELECT FROM auth_resource_grants
    WHERE principal_id = context.principal.id
    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    AND resource_type matches (exact OR parent via inheritance)
    AND effect = 'allow'
    AND (action = leaf.action OR action = '*')
    AND grant_matches_target(resource_id, target, scope)
  if allows is empty: return DENY(resource_grant_missing)

  return ALLOW
```

**`resolve_target(leaf, context)` — the single target resolver:**

```
function resolve_target(leaf, context):
  -- All resolution runs through the query gateway (tenant-scoped).
  if leaf.selector == 'instance':
    inst = context.resolve_by_id(leaf.resource_type, route_params)
    if inst is NULL: return INVALID
    return NormalizedTarget {
      selector: 'instance',
      resource_type: leaf.resource_type,
      instance_id: inst.id,
      container_type: NULL, container_id: NULL,
      installation_id: inst.installation_id,
      repository_id: inst.repository_id
    }

  if leaf.selector == 'create':
    -- CREATE resolves the DESTINATION CONTAINER before insertion.
    -- The container is the parent installation or repository into
    -- which the new record will be inserted. This is derived from the
    -- route context (e.g., POST /api/installations/:id/repositories
    -- → container is installation :id).
    container = context.resolve_create_container(leaf.resource_type, route_params, body)
    if container is NULL:
      return INVALID  -- cannot determine destination → fail-closed
    -- Verify the container is within the principal's tenant scope.
    if not scope_contains(scope, container.installation_id, container.repository_id):
      return INVALID  -- destination outside tenant boundary
    return NormalizedTarget {
      selector: 'create',
      resource_type: leaf.resource_type,
      instance_id: NULL,
      container_type: container.type,    -- 'installation' or 'repository'
      container_id: container.id,
      installation_id: container.installation_id,
      repository_id: container.repository_id
    }

  if leaf.selector == 'list':
    -- LIST resolves the scoping parent (container), same as create
    -- but without the create-specific destination check.
    container = context.resolve_list_scope(leaf.resource_type, route_params)
    if container is NULL:
      return NormalizedTarget {
        selector: 'list', resource_type: leaf.resource_type,
        instance_id: NULL, container_type: NULL, container_id: NULL,
        installation_id: NULL, repository_id: NULL
      }
    return NormalizedTarget {
      selector: 'list', resource_type: leaf.resource_type,
      instance_id: NULL,
      container_type: container.type, container_id: container.id,
      installation_id: container.installation_id,
      repository_id: container.repository_id
    }

  if leaf.selector == 'route-root':
    inst = context.resolve_route_root(leaf.resource_type)
    if inst is NULL: return INVALID
    return NormalizedTarget { selector: 'route-root', ... inst fields ... }

  if leaf.selector == 'inherited':
    inst = context.resolve_inherited(leaf.resource_type)
    if inst is NULL: return INVALID
    return NormalizedTarget { selector: 'inherited', ... inst fields ... }
```

**`grant_matches_target(resource_id, target, scope)` resolution:**

| Selector | resource_id IS NOT NULL (specific grant) | resource_id IS NULL (wildcard grant) |
|----------|------------------------------------------|--------------------------------------|
| `instance` | `resource_id = target.instance_id` | scope_type matches scope AND target within scope |
| `list` | never matches | scope_type matches scope AND target.container within scope |
| `create` | never matches | scope_type matches scope AND **target.container_id within scope** |
| `route-root` | `resource_id = target.instance_id` | scope_type matches scope |
| `inherited` | `resource_id = target.instance_id OR parent matches` | scope_type matches scope |

**Critical difference from prior version:** for `create` and `list`, the
wildcard grant (`resource_id IS NULL`) is no longer sufficient by itself.
The grant's scope must ALSO contain the resolved `container_id`
(`target.installation_id` / `target.repository_id`). This proves the
principal has authority over the **exact destination** — not just any
wildcard scope. A principal with an installation-scoped wildcard grant
on installation 42 cannot create a resource in installation 99, even
though both are "wildcard within installation scope."

For `create`, `resolve_create_container` MUST return a valid container
before any grant check. If the destination cannot be determined or is
outside the tenant boundary, the leaf returns `resource_not_found`
(fail-closed: no ambiguous insertion).
```

Step 4 in the main algorithm calls `evaluate_expression(root, context)`
which traverses the tree and calls `evaluate_leaf` for each leaf. There
is no separate "rerun steps 5-9 for each permission" loop.

```
STEP 1: Authenticate principal
  authenticated_principal = authenticate(token_or_session_or_hmac)
  if not authenticated_principal:
    return DENY_AND_RECORD(reason=no_authenticated_principal)

STEP 2: Derive tenant scope (closed product algebra)
  -- Active roles: revoked_at IS NULL, expired roles excluded.
  active_roles = SELECT * FROM auth_principal_roles
    WHERE principal_id = authenticated_principal.id
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())

  -- Each dimension is tri-state: ALL (unrestricted) | NONE (empty) | SET(ids)
  -- DEFAULT IS NONE — a principal with no tenant roles gets no visibility.
  scope = {
    installation: NONE,  -- default: no installations visible
    repository:  NONE,   -- default: no repositories visible
    fleet:       false,  -- default: no fleet-wide visibility
    system:      false   -- default: no system-scoped access
  }

  -- PHASE 1: Accumulate role-derived domains.
  -- Roles only WIDEN authority (within their declared dimension). They
  -- never narrow another role's contribution. Union semantics within
  -- each dimension.
  role_inst_ids = Set()
  role_repo_ids = Set()
  has_fleet_role = false
  has_system_role = false
  for role in active_roles:
    if role.scope_type == 'fleet':
      has_fleet_role = true
    if role.scope_type == 'system':
      has_system_role = true
    if role.scope_type == 'installation':
      role_inst_ids.add(role.scope_id)
    if role.scope_type == 'repository':
      role_repo_ids.add(role.scope_id)
      -- A repository role implicitly includes its parent installation
      -- in the installation domain (the repo lives there).
      role_inst_ids.add(resolve_parent_installation(role.scope_id))

  -- PHASE 2: Derive the role-domain scope (before credential intersection).
  -- The installation dimension is the UNION of fleet (ALL), explicit
  -- installation roles, and parent installations of repository roles.
  -- The repository dimension is the UNION of fleet (ALL) and explicit
  -- repository roles. Installation roles do NOT widen the repository
  -- dimension to ALL — they widen it to the repos within those
  -- installations (ALL_WITHIN_INSTALLATIONS), represented here as a
  -- finite SET computed at evaluation time.
  if has_fleet_role:
    scope.fleet = true
    scope.installation = ALL
    scope.repository = ALL
  else:
    if role_inst_ids is not empty:
      scope.installation = SET(role_inst_ids)
    if role_repo_ids is not empty:
      scope.repository = SET(role_repo_ids)
    elif role_inst_ids is not empty and role_repo_ids is empty:
      -- Installation role with no explicit repo role and no fleet:
      -- repositories are ALL_WITHIN those installations.
      scope.repository = SET(repos_within(role_inst_ids))
  scope.system = has_system_role

  -- PHASE 3: Credential intersection (narrows BOTH dimensions together).
  -- Credentials CANNOT create authority. A finite credential restriction
  -- narrows the relevant dimension AND its co-dimension so the gateway
  -- never receives mismatched installation/repository domains.
  -- Tri-state intersection rules:
  --   NONE ∩ ANY  = NONE  (no authority cannot be expanded)
  --   ALL  ∩ SET  = SET   (unrestricted narrowed to finite)
  --   SET  ∩ SET  = SET(a ∩ b)  — empty result stays as empty SET, not NONE
  --
  -- IMPORTANT: an empty intersection (SET ∩ SET = ∅) is represented as
  -- a SET with zero elements, which the gateway treats identically to
  -- NONE for filtering. This is distinct from NONE (no role authority at
  -- all): it records that the principal HAD authority that the credential
  -- narrowed to nothing, which is a different audit signal.

  if credential has finite installation restriction:
    cred_inst = SET(credential.installation_ids)
    scope.installation = tri_intersect(scope.installation, cred_inst)
    scope.fleet = false  -- finite credential collapses fleet
    -- NARROW CO-DIMENSION: a finite installation restriction also
    -- constrains the repository dimension to repos within the surviving
    -- installations. This prevents the gateway from seeing repos whose
    -- parent installation was just excluded.
    if scope.repository == ALL:
      scope.repository = SET(repos_within(as_set(scope.installation)))
    elif scope.repository is SET:
      scope.repository = scope.repository ∩ SET(repos_within(as_set(scope.installation)))

  if credential has finite repository restriction:
    cred_repo = SET(credential.repository_ids)
    scope.repository = tri_intersect(scope.repository, cred_repo)
    scope.fleet = false
    -- NARROW CO-DIMENSION: a finite repository restriction also
    -- constrains the installation dimension to the parent installations
    -- of the surviving repositories. This runs unconditionally (even
    -- when scope.installation was ALL) so that fleet + repo-restriction
    -- does not leave installation=ALL while repository is finite.
    repo_parents = SET(parent installations of cred_repo)
    if scope.installation == ALL:
      scope.installation = repo_parents
    elif scope.installation is SET:
      scope.installation = scope.installation ∩ repo_parents
    -- If the repo restriction empties the installation dimension, that
    -- is correct: no surviving repos means no surviving installations.

  if credential denies fleet: scope.fleet = false
  if credential denies system: scope.system = false

  -- PHASE 4: Fail-closed check. A principal must have SOME non-empty
  -- dimension to proceed. An empty SET (from intersection) counts as
  -- no visibility, same as NONE.
  inst_visible = (scope.installation is SET and scope.installation is not empty)
                 or scope.installation == ALL or scope.fleet
  repo_visible = (scope.repository is SET and scope.repository is not empty)
                 or scope.repository == ALL or scope.fleet
  if not inst_visible AND not repo_visible AND not scope.system:
    return DENY_AND_RECORD(reason=no_installation_scope)

  -- Helper: tri-state intersection
  function tri_intersect(dim, cred_set):
    if dim == NONE: return NONE              -- NONE ∩ SET = NONE
    if dim == ALL:  return cred_set          -- ALL  ∩ SET = SET
    return dim ∩ cred_set                    -- SET  ∩ SET = SET(a ∩ b)
  function as_set(dim):
    if dim == ALL:  return ALL_INSTALLATIONS -- materialize for co-dim narrowing
    if dim == NONE: return empty Set()
    return dim

### Scope product algebra — normative truth table

The table below is the closed specification of STEP 2. Every combination
of role domain × credential restriction MUST produce the listed scope.
Notation: `A` = a finite SET of installation IDs; `R` = a finite SET of
repository IDs; `R(A)` = repos within installations A; `P(R)` = parent
installations of repos R; `∅` = empty SET (zero elements).

| # | Role domain | Credential restriction | scope.installation | scope.repository | scope.fleet |
|---|-------------|----------------------|--------------------|------------------|-------------|
| T1 | fleet | none | ALL | ALL | true |
| T2 | fleet | installation A | A | R(A) | false |
| T3 | fleet | repository R | P(R) | R | false |
| T4 | installation I | none | {I} | R({I}) | false |
| T5 | installation I | installation A (I ∈ A) | {I} ∩ A | R({I} ∩ A) | false |
| T6 | installation I | installation A (I ∉ A) | ∅ | ∅ | false → deny (no_installation_scope) |
| T7 | installation I | repository R (repos in I) | {I} ∩ P(R) | R({I}) ∩ R | false |
| T8 | installation I | repository R (repos NOT in I) | {I} ∩ P(R) = ∅ | ∅ | false → deny |
| T9 | repository R (parent I) | none | {I} | R | false |
| T10 | repository R (parent I) | installation A (I ∈ A) | {I} ∩ A | R ∩ R(A) | false |
| T11 | repository R (parent I) | installation A (I ∉ A) | ∅ | ∅ | false → deny |
| T12 | repository R (parent I) | repository R' (R ∩ R' ≠ ∅) | {I} ∩ P(R') | R ∩ R' | false |
| T13 | repository R (parent I) | repository R' (R ∩ R' = ∅) | {I} ∩ P(R') = ∅ | ∅ | false → deny |
| T14 | none (no tenant roles) | any | NONE | NONE | false → deny |
| T15 | system only | any tenant | NONE | NONE | false (system=true, proceeds for system resources) |

**Key invariants enforced by this table:**

1. **Co-dimension narrowing is unconditional.** T2, T3, T7, T10, T12 all
   show the credential restriction narrowing BOTH dimensions. The gateway
   never receives `installation=ALL` with `repository=SET` (T3) or
   `installation=SET` with a repository domain that spans excluded
   installations (T7, T10, T12).

2. **Empty intersection = deny.** T6, T8, T11, T13 produce an empty SET
   in both dimensions, which fails the Phase 4 visibility check. This is
   the fail-closed behavior: a credential that narrows authority to
   nothing denies, even if the roles alone would have granted access.

3. **Fleet collapse.** Any finite credential restriction (T2, T3) sets
   `scope.fleet = false`. Only an unrestricted credential preserves
   fleet authority (T1).

4. **System is orthogonal.** T15 shows system-only principals have no
   tenant dimensions but proceed for system-scoped resources. System
   authority is never widened by tenant roles or narrowed by tenant
   credentials.

STEP 3: Install data-access boundary
  -- The query gateway receives the full scope object.
  -- Tri-state interpretation:
  --   ALL  → no filter for this dimension
  --   SET  → WHERE id = ANY(scope.installation SET)
  --   NONE → no rows visible (empty result, fail-closed)
  -- For installation-scoped tables:
  --   fleet=true → no installation filter at all
  --   fleet=false → filter by scope.installation tri-state
  -- For repository-scoped queries:
  --   filter by scope.repository tri-state
  -- For system/identity tables: WHERE TRUE only if scope.system IS TRUE.
  query_gateway.set_scope(scope)

STEP 4: Evaluate operation policy expression
  -- The route's operation policy is compiled to a permission expression tree.
  -- evaluate_expression walks the tree, calling evaluate_leaf (defined above)
  -- for each unique leaf. Memoization prevents re-evaluation of the same leaf.
  -- ALL resource resolution happens inside evaluate_leaf via resolve_target;
  -- there is no separate global resolution step. The query gateway installed
  -- in STEP 3 ensures any resource outside the principal's tenant scope is
  -- invisible (resolve_target returns INVALID → resource_not_found).
  result = evaluate_expression(operation_policy_tree, context)
  if result is DENY:
    return DENY_AND_RECORD(reason=result.reason)
  if operation_policy requires re-authorization (sensitive operation):
    -- Re-read roles and grants from DB; re-evaluate the expression.
    fresh_context = rebuild_context_from_db(authenticated_principal)
    result2 = evaluate_expression(operation_policy_tree, fresh_context)
    if result2 is DENY:
      return DENY_AND_RECORD(reason=reauthorization_failed)

STEP 5: Issue decision
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
- **Evaluation order for denies:** explicit deny is checked inside
  `evaluate_leaf`, after the role permission check and before the
  credential scope check. If deny matches, the result is immediately
  deny regardless of other factors.
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
   `scope` (step 2 of the evaluation algebra).
   Intersect with credential resource restrictions.

**Phase B: Install the data-access boundary**
3. The **mandatory query gateway** is the normative enforcement boundary.
   It receives the full tri-state `scope` object from step 2 and applies
   it to every SQL query against installation-scoped tables.
4. Operation policy evaluation (step 4 of the main algorithm) then
   proceeds within the already-scoped boundary. All resource/target
   resolution occurs inside `evaluate_leaf` via `resolve_target`, which
   runs through this gateway — resources outside the principal's tenant
   scope are invisible (returned as `resource_not_found`).

**PostgreSQL RLS is NOT the chosen boundary.** The mandatory query gateway
is the normative enforcement mechanism because:
- It is testable in CI without a production Postgres configuration.
- It handles dynamic per-request scope changes (per-credential restrictions).
- It provides structured denial reasons, not silent row filtering.

RLS may be added as defense-in-depth later, but the query gateway is the
authoritative boundary.

**Fail-closed behavior:** if `scope` is all-NONE with no fleet/system,
the principal has no fleet/system role, the gateway returns empty result
sets for all installation-scoped queries. A route that forgets to request
tenant filtering gets nothing — the gateway applies unconditionally to
all queries against installation-scoped tables.

### Worker scope

Workers do NOT receive tenant scope from the job payload. The payload's
`installation_id` and `repository_id` are **comparison claims**, not
authority sources (§9). The worker's gateway scope is derived **solely**
from the validated delegation's resource boundary:

1. The worker verifies the capability token (§14): signature, audience,
   payload hash, JTI consumption, delegation validity.
2. The worker resolves the delegation record to obtain the resource
   boundary (`resource_type`, `resource_id`, `installation_id`).
3. The gateway scope is constructed from the delegation's boundary —
   never from the payload's claimed IDs directly. The payload IDs are
   compared against the delegation's boundary as a consistency check;
   a mismatch indicates tampering and the job is rejected.

This means a worker's data access is bounded by what the initiating
principal was authorized to delegate, not by what the payload asserts.
A queue-injected job without a valid capability token is rejected before
any data access occurs.

### Queue authority model

`queue_job` is a **transport-scoped resource**, not a tenant resource.
It is not installation-scoped or system-scoped in the data-access sense
— it has no `installation_id` column and is backed by Redis, not
PostgreSQL. The query gateway does not filter it. Instead, enqueue
authority is enforced at two distinct points with distinct semantics:

**1. Initiating enqueue authority (who can trigger a job).**

A principal enqueues a job by performing an `enqueue` action on the
**target operation's resource** (the repository or installation the job
will operate on), not on a queue resource. The permission is
`<resource_type>:enqueue` (e.g., `repository:enqueue`,
`installation:enqueue`). This is evaluated by `evaluate_leaf` against
the initiating principal's roles, grants, and scope — exactly like any
other action. The `enqueue` action in the §4 vocabulary applies to
`repository` and `installation` because those are the resources whose
tenant boundary the job will operate within.

**2. Worker ceiling for downstream enqueue (which workers can chain jobs).**

When a worker enqueues a downstream job (e.g., patch-worker enqueues
verification), it acts under its delegation. The worker's ceiling in
`auth_worker_ceilings` must include `queue_job:enqueue` — the transport
permission to submit to the queue. This ceiling permission is
system-scoped (transport infrastructure), independent of the tenant
resource the downstream job will touch. The downstream job's tenant
boundary comes from a **new delegation** created by the worker under
its own delegated authority (§9 delegation chains).

**Why `queue_job` is not in the tenant evaluator:**

The installation principal (`scope=installation`) and the scheduler
(`scope=fleet`) can initiate enqueues because they hold
`<resource_type>:enqueue` on their respective tenant resources — NOT
because they have authority over a system-scoped queue resource. The
`queue_job` token exists in the registry only to represent the worker
ceiling permission for downstream chaining. This cleanly separates
"who can trigger a job" (tenant-scoped, evaluated by the normal
algorithm) from "which workers can submit to queues" (transport-scoped
ceiling, evaluated against `auth_worker_ceilings`).

**Registry classification:** `queue_job` is listed under
"Transport-scoped" in §3 and in the system-scoped registry table (§17)
because the registry has no separate transport category — but its
narrative classification is transport, and it is never passed through
the query gateway's tenant filter.

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

### Worker role model: separate ceiling assignments

Worker service roles use a **separate assignment kind** — `auth_worker_ceilings` —
not `auth_principal_roles`. This prevents `scope_type='fleet'` from simultaneously
meaning "global tenant visibility" (for human principals) and "action-only ceiling"
(for workers).

```text
auth_worker_ceilings
  id              UUID primary key
  principal_id    UUID FK → auth_principals (type='service')
  role_name       text          -- e.g., 'service:heal-worker'
  permissions     text[]        -- action ceiling, e.g., ['repository:github:act', 'managed_action:update']
  granted_at      timestamptz
  granted_by      UUID FK
  revoked_at      timestamptz NULL
```

Worker ceilings are **never consulted during tenant scope derivation** (step 2).
They are consulted only during worker evaluation (below), after delegation
validation provides the resource boundary.

**Worker evaluation order:**

```text
1. Authenticate worker (capability token)
2. Validate capability: signature, audience, payload hash, JTI lease
3. Validate delegation: not revoked, not expired, execution_status pending
4. Derive gateway scope SOLELY from the delegation's resource boundary
5. Evaluate worker action ceiling: does auth_worker_ceilings for this
   worker include the required action? (does NOT use auth_principal_roles)
6. Evaluate initiating authority: does the delegation authorize this
   specific operation + resource?
Both 5 and 6 must independently ALLOW.
```

The worker principal has no `auth_principal_roles` entries at all. Its
authority comes exclusively from `auth_worker_ceilings` (action ceiling)
and `auth_delegations` (resource boundary). This cleanly separates the
two concerns and prevents the fleet-scope ambiguity.

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

**Evaluation B: Worker action ceiling**
```
Does the worker's ceiling in auth_worker_ceilings include the
required action for this resource type?
- Check auth_worker_ceilings for the worker principal
- Check permissions includes the action
- Check not revoked
```

Both must independently allow. The worker cannot exceed its ceiling
(Evaluation B) or the initiator's delegated scope (Evaluation A).
Payload installation and repository IDs are claims compared against
the signed capability and delegation — never authority sources.

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

| Code | Where evaluated | Meaning |
|------|----------------|---------|
| `no_authenticated_principal` | Algorithm step 1 | No valid credential presented |
| `no_installation_scope` | Algorithm step 2 | Principal has no tenant scope after role+credential intersection |
| `resource_not_found` | evaluate_leaf (resolve_target) | Resource does not exist or is not visible within scope |
| `no_active_role` | evaluate_leaf | Principal has no active role assignments matching this resource |
| `role_permission_missing` | evaluate_leaf | The required action is not in any of the principal's role permissions |
| `explicit_deny` | evaluate_leaf | An explicit deny grant matched this resource + action |
| `credential_scope_denied` | evaluate_leaf | The credential's scope does not include this action |
| `credential_resource_restricted` | evaluate_leaf | The credential is restricted to different resources |
| `wrong_environment` | evaluate_leaf | The credential is restricted to a different environment |
| `expired` | evaluate_leaf | The credential, role, or grant has expired |
| `resource_grant_missing` | evaluate_leaf | No explicit allow grant on this resource |
| `operation_policy_denied` | Algorithm step 4 | Compound operation policy expression evaluated to deny |
| `reauthorization_failed` | Algorithm step 4 | Sensitive operation re-check failed (principal/grant changed) |
| `attestation_not_found` | evaluate_attestation_leaf | No valid attestation exists for this principal/repo/command/delegation |
| `attestation_revoked_on_github` | evaluate_attestation_leaf | GitHub API recheck shows user no longer has required role |
| `attestation_permission_changed` | evaluate_attestation_leaf | GitHub role changed since attestation was created |
| `capability_jti_consumed` | Worker verification | JTI permanently consumed; replay rejected |
| `capability_delegation_in_use` | Worker verification | Delegation execution claim held by another attempt; concurrent execution blocked |
| `capability_delegation_invalid` | Worker verification | Delegation revoked, expired, or denied |
| `capability_invalid_signature` | Worker verification | Ed25519 signature verification failed |
| `capability_audience_mismatch` | Worker verification | Token audience does not match this worker |
| `capability_expired` | Worker verification | Token `expires_at` has passed |
| `capability_payload_mismatch` | Worker verification | `payload_hash` does not match job payload |
| `capability_queue_mismatch` | Worker verification | Token queue/job name does not match current queue |
| `capability_delivery_mismatch` | Worker verification | `delivery_id` does not match the verified webhook delivery (when present) |
| `capability_key_not_found` | Worker verification | `key_id` references an unknown signing key |
| `unmapped_legacy_key` | Algorithm step 1 | Legacy key has no installation mapping |
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

### Bounded external attestation (transient authority source)

A GitHub user's `authorAssociation` on a repository is an external
permission that GitWire cannot revoke but must verify. For
GitHub-comment-command routes (`/gitwire fix`, `/gitwire close`), the
attestation is the **primary authority source** — not evidence attached
to standing role/grant authority that does not exist for a newly
resolved GitHub user.

**Attestation record:**
```text
auth_external_attestations
  id              UUID primary key
  principal_id    UUID FK → auth_principals
  provider        text          -- 'github'
  subject         text          -- GitHub user login
  subject_id      bigint        -- GitHub user ID
  repository_id   bigint        -- GitHub repo ID
  permission      text          -- 'OWNER', 'MEMBER', 'COLLABORATOR'
  command         text          -- 'fix-issue', 'close-issue'
  delegation_id   UUID FK → auth_delegations
  verified_at     timestamptz
  expires_at      timestamptz  -- short (e.g., 5 minutes)
```

**How it authorizes F-07:**

GitHub-comment-command routes compile to an expression where the
attestation leaf IS the authority — not an additional factor alongside
role and grant leaves that would deny for a user with no standing
authority:

```text
-- F-07 route expression: attestation is the SOLE authority source
attestation:github_attestation(command='fix-issue', repository=route.repo)
```

This leaf evaluates via a **dedicated evaluation path** that does NOT
require role permissions or resource grants:

```text
function evaluate_attestation_leaf(leaf, context):
  attestation = SELECT FROM auth_external_attestations
    WHERE provider = 'github'
    AND subject_id = context.principal.github_user_id
    AND repository_id = context.resource.repository_id
    AND command = leaf.command
    AND delegation_id = context.delegation.id
    AND expires_at > now()
  if attestation is empty:
    return DENY(attestation_not_found)

  -- Re-verify GitHub permission at execution time.
  current_role = github.get_author_association(
    context.principal.github_login,
    context.resource.owner, context.resource.name
  )
  if current_role not in ('OWNER', 'MEMBER', 'COLLABORATOR'):
    return DENY(attestation_revoked_on_github)
  if current_role != attestation.permission:
    return DENY(attestation_permission_changed)

  return ALLOW
```

The `delegation_id` filter ensures the attestation authorizes only the
specific delegation that created it. A valid attestation cannot be
reused for a different delegation, even within its TTL.

This is a **concrete transient authority source** — it replaces
role+grant for the specific case of GitHub comment commands. The
attestation is created at ingress (when the webhook carries a verified
`authorAssociation`), is operation-specific (has `command`), is
repository-bound, is short-lived, and is rechecked against GitHub at
every execution.

**F-07 decision examples:**

| # | Scenario | Result | Reason |
|---|----------|--------|--------|
| F07-P1 | GitHub OWNER issues `/gitwire fix` on repo X; attestation created at ingress | ALLOW | Attestation valid; current GitHub role = OWNER |
| F07-N1 | GitHub NONE (demoted after ingress) issues `/gitwire fix`; attestation exists but GitHub recheck fails | DENY | `attestation_revoked_on_github` |
| F07-N2 | Attestation expired (6 minutes passed) | DENY | `attestation_not_found` (expired) |
| F07-N3 | User issues `/gitwire fix` on repo Y (different from attestation's repo X) | DENY | `attestation_not_found` (repository mismatch) |

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
  "jti": "<unique token ID for one-time consumption>",
  "delivery_id": "<GitHub webhook delivery ID, if originating from a webhook — NULL for direct triggers>"
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
- **Delivery binding:** for webhook-originated jobs, the token carries
  `delivery_id` (the GitHub webhook delivery ID verified at ingress).
  At dequeue, the worker verifies this matches the recorded delivery.
  This prevents a replayed capability from being attached to a payload
  originating from a different webhook delivery. For direct triggers
  (not from a webhook), `delivery_id` is NULL and this check is skipped.
- **Issuer:** the principal that created the token (typically `gitwire-app`).
- **Audience:** the worker service principal that is authorized to consume
  this token.
- **Key ID:** identifies which signing key was used, supporting key rotation.
- **JTI (JWT ID):** a unique token identifier for one-time consumption.
  The worker records the JTI in Redis with a TTL matching `expires_at`.
  A replayed JTI is rejected.
- **One-time consumption:** the JTI is permanently consumed before
  execution begins. After the worker processes the job, the JTI remains
  marked consumed. Any replay attempt is denied.

### Worker verification (true at-most-once)

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
7. **Delivery binding:** if `delivery_id` is present (webhook-originated
   job), verifies it matches the GitHub webhook delivery ID recorded at
   ingress. This binds the capability to the specific verified delivery,
   preventing a replayed capability from being attached to a different
   delivery's payload. If `delivery_id` is NULL (direct trigger), this
   check is skipped.
   - Failure: `capability_delivery_mismatch`.
8. **Consumes the JTI permanently:** `SET gitwire:jti:{jti} "consumed" NX EX {retention_ttl}`
   — see JTI consumption protocol (true at-most-once).
   - If SET succeeds: JTI is permanently consumed; proceed.
   - If SET fails (key exists): reject with `capability_jti_consumed`.
9. Resolves the delegation via `delegation_id` (checks not revoked,
   not expired). Reject with `capability_delegation_invalid` if invalid.
10. **Acquires the delegation execution claim:** atomically transitions
    `execution_status` from `pending` to `executing`. If another attempt
    already holds the claim (`execution_status = 'executing'`), reject
    with `capability_delegation_in_use`. See JTI consumption protocol
    for the two-layer exclusion rationale.
11. Executes the job under the delegated authority (two independent
    evaluations, §9). The query gateway is configured from the
    delegation's resource boundary.
12. **Finalizes:** on completion (success or failure), transitions
    `execution_status` to `completed` or `cancelled`, releasing the
    execution claim so a fresh capability can proceed if needed.

**Retry semantics:** BullMQ retries carry the same JTI. Since the JTI
is permanently consumed before execution, all retries are rejected with
`capability_jti_consumed`. The caller must re-enqueue with a fresh
capability if the job crashes. See the JTI consumption protocol below
for the execution-claim rule that prevents a fresh capability from
overlapping a paused original attempt.

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

### JTI consumption protocol (true at-most-once)

The model chooses **true at-most-once**: once a job begins processing,
its JTI is permanently consumed. No takeover, no retry of an acquired
job. If the worker crashes mid-execution, the job is lost (BullMQ's
own retry mechanism is disabled for capability-gated jobs). The caller
must re-enqueue with a fresh capability if needed.

**Two-layer exclusion.** JTI consumption alone prevents reuse of the
same capability, but does not prevent a fresh capability (new JTI) for
the same delegation from overlapping a paused original process. To close
this gap, the protocol uses a **delegation-level execution claim** in
addition to JTI consumption:

**Protocol:**

1. **Acquire JTI (atomic, permanent):**
   ```text
   SET gitwire:jti:{jti} "consumed" NX EX {retention_ttl}
   ```
   - `NX` ensures only the first attempt acquires.
   - The value is immediately `"consumed"` — there is no intermediate
     `"reserved"` or `"active"` state.
   - If SET fails: the JTI is already consumed → reject with
     `capability_jti_consumed`.

2. **Acquire delegation execution claim (atomic):**
   ```text
   UPDATE auth_delegations
     SET execution_status = 'executing'
     WHERE id = :delegation_id
       AND execution_status IN ('pending', 'completed', 'cancelled', 'denied')
   -- Returns affected_rows = 1 on success, 0 if another execution
   -- holds the claim (execution_status = 'executing').
   ```
   - This prevents a fresh capability for the same delegation from
     beginning execution while a previous attempt is still in
     `executing` state.
   - If affected_rows = 0: another attempt holds the claim → reject
     with `capability_delegation_in_use`.

3. **Execute:** the worker processes the job. No lease, no deadline,
   no heartbeat.

4. **Finalize:** on completion (success or failure), set
   `execution_status = 'completed'` (or `'cancelled'`). This releases
   the execution claim, allowing a fresh capability to proceed if the
   job crashed and must be re-enqueued.

**Fresh-capability-after-crash rule.** When a job crashes mid-execution:
- The JTI remains `"consumed"` (permanent). The crashed capability can
  never be reused.
- The delegation's `execution_status` remains `'executing'` until the
  crash is detected and the status is finalized. A fresh capability for
  the same delegation CANNOT proceed until the previous execution is
  confirmed terminated (status transitions out of `'executing'`).
- Crash detection: the system marks `execution_status = 'cancelled'`
  after a configurable staleness threshold (e.g., no heartbeat/progress
  signal for N minutes, or process supervisor reports exit). Only then
  can a fresh capability acquire the claim.
- This prevents a paused/stuck original process from overlapping a
  fresh re-enqueued job. The two-layer exclusion (JTI + execution
  claim) guarantees that at most one process executes under a given
  delegation at any time.

**Side-effect safety:** because the JTI is consumed and the execution
claim is acquired before execution, no two attempts can ever execute
the same job or delegation concurrently. If the worker crashes after
some side effects but before completion, those side effects are partial.
The caller must handle this:
- For database mutations: transaction-based (commit atomically).
- For GitHub mutations: each mutation carries a unique operation
  identifier (e.g., branch name with request_id suffix) so a
  re-enqueued job can detect prior partial execution.
- For queue mutations (enqueue downstream): the downstream job's
  capability references a fresh delegation (not the crashed worker's
  delegation), so the execution claim does not block legitimate
  downstream chaining.

**Why true at-most-once instead of takeover or fencing tokens:**
- **Takeover** allows a paused old worker to resume and overlap with
  the new attempt — unsafe without fencing at every mutable sink.
- **Fencing tokens** require every mutable sink (including GitHub API)
  to validate a monotonic counter — impractical.
- **True at-most-once** with delegation execution claims is the
  simplest model that guarantees no concurrent execution — both of the
  same capability (JTI) and of the same delegation (execution claim).
  The cost is that a crashed job must be re-enqueued after confirmed
  termination, but this is acceptable for the job sizes involved
  (seconds to minutes) and the operational visibility it provides
  (the crash is observable, not silently retried).

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
| `capability_delegation_in_use` | Delegation execution claim held by another active attempt |
| `capability_key_not_found` | `key_id` references an unknown signing key |
| `capability_delegation_invalid` | Referenced delegation is revoked, expired, or denied |
| `capability_delivery_mismatch` | `delivery_id` does not match the verified webhook delivery (when present) |

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
   delivery_id binding, JTI consumption, delegation execution claim).
6. For **every mutating command**, the worker evaluates the attestation
   leaf (`evaluate_attestation_leaf`), which rechecks the GitHub API
   for the user's current `authorAssociation` on the repository:
   - If still `OWNER`/`MEMBER`/`COLLABORATOR` and unchanged: proceed.
   - If demoted or removed: reject with `attestation_revoked_on_github`.
   - If changed to a different valid role: reject with
     `attestation_permission_changed`.
   - If no valid attestation record exists: reject with
     `attestation_not_found`.
   This is NOT limited to "sensitive operations" — every `/gitwire`
   mutating command rechecks, because GitHub association can change
   between enqueue and execution. The denial codes are the
   attestation-specific codes from §12, NOT `reauthorization_failed`
   (which applies only to sensitive-operation rechecks of standing
   role/grant authority).
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
| P2 | `service:heal-worker` with capability token + valid delegation for `heal-run` on repo X | repository X | `repository:github:act` | Capability verified; delegation valid; worker ceiling includes `github:act`; initiating authority permits this repo |
| P3 | `user` with `admin` role (fleet) | auth_principal (any) | `auth_principal:manage` | Admin role has fleet+system scope; includes `manage` action; system grant allows |
| P4 | `installation` principal (HMAC-verified webhook), explicit allow grant on `webhook_delivery` | `webhook_delivery` (via webhook payload) | `webhook_delivery:create` | Installation principal role includes `create` on `webhook_delivery`; create target resolves to the webhook's installation; resource grant (allow, scope=installation) matches the destination container |
| P5 | `legacy-key` mapped to installation 42 | policy_waiver in installation 42 | `policy_waiver:read` | Legacy-key role includes `read`; installation-mapped to 42; grant allows |

### Negative examples (deny)

| # | Principal | Resource | Action | Denial reason |
|---|-----------|----------|--------|---------------|
| N1 | `user` with `operator` role on installation 42 | repository in installation 99 | `repository:read` | `resource_not_found` (outside tenant scope via query gateway) |
| N2 | `user` with `viewer` role | repository X | `repository:update` | `role_permission_missing` (viewer has `read` only) |
| N3 | `service:heal-worker` without capability token | repository X | `repository:github:act` | `capability_invalid_signature` (no valid capability to verify) |
| N4 | `legacy-key` unmapped (no installation assignment) | any installation-scoped resource | any | `unmapped_legacy_key` |
| N5 | `user` with `operator` role, explicit deny grant on repository X | repository X | `repository:update` | `explicit_deny` (deny grant matched inside evaluate_leaf before credential scope check) |
| N6 | `service:patch-worker` (no GitHub identity) | repository X | `repository:github:act` | `role_permission_missing` (patch-worker role lacks `github:act`) |
| N7 | `user` with expired credential | repository X | `repository:read` | `expired` (credential expired, checked inside evaluate_leaf) |
| N8 | Worker job with consumed JTI (replay attempt) | any | any | `capability_jti_consumed` (JTI permanently consumed before execution) |
| N9 | `legacy-key` with fleet role + `manage` action | auth_principal | `auth_principal:manage` | `role_permission_missing` (legacy-key role excludes `manage`) |
| N10 | `user` with `viewer` role, compound any_of policy requiring approve permission | `policy_rollout_plan` | `policy_rollout_plan:approve` | `operation_policy_denied` (compound any_of: no alternative allowed; reason is operation_policy_denied per §6 deterministic failure rule) |

---

## 17. Canonical resource registry

Every resource token used in roles, grants, delegations, operation
policies, examples, and findings MUST appear in this registry.
Every resource token used in roles, grants, delegations, operation
policies, examples, and findings MUST appear in this registry (45
installation-scoped + 12 system-scoped = 57 total).
Tokens are singular. The hierarchy and category lists in §3 are
derived from this table.

### Installation-scoped resources

| Token | Parent | Identifier type | Backing table(s) | Actions |
|-------|--------|----------------|-------------------|---------|
| `installation` | — | bigint | `installations` | read, create, update |
| `repository` | `installation` | bigint (github_id) | `repositories` | read, create, update, github:act, github:read, enqueue |
| `pull_request` | `repository` | bigint | `pull_requests` | read, create, update |
| `issue` | `repository` | bigint | `issues` | read, create, update |
| `ci_run` | `repository` | bigint | `ci_runs` | read, create, update |
| `branch_rule` | `repository` | bigint | `branch_rules` | read, create, update |
| `repo_config` | `repository` | bigint | `repo_config`, `config_history` | read, update, delete |
| `config_validation_result` | `repository` | bigint | `config_validation_results` | read |
| `heal_pr` | `repository` | bigint | `heal_prs` | read, update |
| `repair_proposal` | `repository` | bigint | `repair_proposals` | read |
| `repair_proposal_event` | `repair_proposal` | bigint | `repair_proposal_events` | read, create, update |
| `patch_artifact` | `repair_proposal` | text (hash) | `patch_artifacts` | read, create |
| `execution_receipt` | `repair_proposal` | text (hash) | `execution_receipts` | read, create |
| `source_snapshot` | `repair_proposal` | text (hash) | `source_snapshots` | read, create |
| `backend_isolation_evidence` | `repair_proposal` | bigint | `backend_isolation_evidence` | read, create |
| `managed_action` | `repository` | bigint | `managed_actions` | read, create, update |
| `action_reconciliation_log` | `installation` | bigint | `action_reconciliation_log` | read |
| `decision_log` | `installation` | bigint | `decision_log` | read, create |
| `pipeline_event` | `installation` | bigint | `pipeline_events` | read |
| `fix_attempt` | `repository` | bigint | `fix_attempts` | read, create, update |
| `ai_review` | `repository` | bigint | `ai_reviews` | read, create |
| `duplicate_signal` | `repository` | bigint | `duplicate_signals` | read |
| `dependency_manifest` | `repository` | bigint | `dependency_manifests` | read |
| `dependency_update_batch` | `repository` | bigint | `dependency_update_batches` | read, create |
| `vulnerability_advisory` | `repository` | bigint | `vulnerability_advisories` | read, update |
| `flaky_test` | `repository` | bigint | `flaky_tests` | read, update |
| `test_result` | `repository` | bigint | `test_results` | read, create |
| `gate_evaluation` | `repository` | bigint | `gate_evaluations` | read |
| `issue_embedding` | `repository` | bigint | `issue_embeddings` | read |
| `member` | `installation` | bigint | `members` | read, create, update |
| `repo_collaborator` | `repository` | bigint | `repo_collaborators` | read, create, update |
| `policy_definition` | `installation` | bigint | `policy_definitions` | read, create, update, delete |
| `policy_waiver` | `installation` | bigint | `policy_waivers` | read, create, revoke |
| `policy_repo_config` | `repository` | bigint | `policy_repo_configs` | read, update |
| `reconciliation_run` | `installation` | bigint | `reconciliation_runs` | read |
| `policy_rollout_plan` | `installation` | bigint | `policy_rollout_plans` | read, create, update, approve |
| `quality_gate` | `repository` | bigint | `quality_gates` | read, create, delete |
| `feedback_rule` | `installation` | bigint | `feedback_rules` | read, create, update, delete |
| `merge_queue_entry` | `repository` | bigint | `merge_queue_entries` | read, create, update |
| `merge_queue_config` | `repository` | bigint | `merge_queue_config` | read, update |
| `rollback_event` | `installation` | bigint | `rollback_events` | read, create |
| `maintainer_setting` | `repository` | bigint | `maintainer_settings` | read, update |
| `maintainer_action` | `repository` | bigint | `maintainer_actions` | read, create |
| `webhook_delivery` | `installation` | text (delivery_id) | `webhook_deliveries` | read, create |
| `external_attestation` | `installation` | UUID | `auth_external_attestations` | read, create |

### System-scoped resources

| Token | Parent | Identifier type | Backing table(s) | Actions |
|-------|--------|----------------|-------------------|---------|
| `auth_principal` | — | UUID | `auth_principals` | read, manage |
| `auth_role` | — | UUID | `auth_roles` | read, manage |
| `auth_credential` | `auth_principal` | UUID | `auth_credentials` | read, manage, revoke |
| `auth_delegation` | — | UUID | `auth_delegations` | read, create, revoke |
| `auth_resource_grant` | — | UUID | `auth_resource_grants` | read, manage, revoke |
| `auth_worker_ceiling` | `auth_principal` | UUID | `auth_worker_ceilings` | read, manage |
| `auth_bootstrap_allow` | — | UUID | `auth_bootstrap_allow` | (operator DB only) |
| `auth_bootstrap_state` | — | text | `auth_bootstrap_state` | (stored function only) |
| `audit_trail_entry` | — | text (hash) | `audit_trail_entries` | read, create, audit:read |
| `audit_export` | — | bigint | `audit_exports` | read, create, audit:export |
| `compliance_report` | — | bigint | `compliance_reports` | read, create |
| `queue_job` | — | text | (Redis) | enqueue |

### Naming rules

- Permission tokens are always `<resource_type>:<action>` using the
  exact `Token` from the registry.
- `policy_rollout_plan` (not `rollout_plan`), `policy_waiver` (not
  `waiver`), `webhook_delivery` (not `webhook_deliveries`).
- Actions from the §4 vocabulary only: read, list, create, update,
  delete, github:act, github:read, enqueue, approve, revoke, manage,
  audit:read, audit:export.

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
