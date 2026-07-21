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
9. [Ownership and delegation](#9-ownership-and-delegation)
10. [Service-account scope](#10-service-account-scope)
11. [Break-glass and emergency access](#11-break-glass-and-emergency-access)
12. [Decision context and denial reasons](#12-decision-context-and-denial-reasons)
13. [Compatibility treatment for existing paths](#13-compatibility-treatment-for-existing-paths)
14. [Finding resolution matrix](#14-finding-resolution-matrix)

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
4. **Resource-boundary enforcement.** Resource hierarchy (installation →
   repository) is enforced at the data-access layer, not only at the
   route handler. List queries are scoped by the principal's resource
   grants.
5. **Separation of identity and authority.** Authentication determines who
   the principal is. Authorization determines what they can do. These are
   evaluated as separate stages with separate inputs.
6. **Auditable decisions.** Every authorization decision (allow or deny)
   produces a structured decision record with deterministic denial codes.
7. **Credential narrowing.** A credential can only reduce authority. A
   service token scoped to one repo cannot access another, even if the
   service's role would permit it.

---

## 2. Principal model

### Principal types

| Type | Description | GitHub binding |
|------|-------------|----------------|
| `user` | Human operator. Authenticated via GitHub App OAuth or bootstrap admin. | `github_user_id` (immutable, unique) |
| `service` | Machine identity. Authenticated via scoped API credential. | None — service principals must not carry GitHub identity fields. |
| `legacy-key` | Temporary bridge principal. One per shared API key fingerprint. | None. |

### Principal record

```text
auth_principals
  id              UUID primary key
  principal_type  ENUM('user', 'service', 'legacy-key')
  display_name    text
  status          ENUM('active', 'disabled')
  github_user_id  bigint UNIQUE NULL  -- only for type='user'
  github_login    text NULL           -- only for type='user'
  auth_epoch      bigint              -- incremented to invalidate all sessions
  created_at      timestamptz
  updated_at      timestamptz
```

**Constraints:**
- `principal_type='user'` may have GitHub identity; `principal_type='service'`
  must not.
- `github_user_id` is unique — one principal per GitHub user.
- Disabled principals cannot authenticate.
- `auth_epoch` increments on credential revocation, role revocation, or
  admin-forced session invalidation. All sessions bind to their epoch;
  stale-epoch sessions are rejected.

### Bootstrap administration

A one-time bootstrap mechanism creates the first named administrator:
1. Enabled only when zero active administrators exist.
2. Requires a short-lived secret injected operationally.
3. Creates the first `user` principal with `admin` role.
4. Permanently disables itself after successful use.
5. Produces a canonical audit event.

---

## 3. Resource hierarchy and inheritance

```
installation
├── repository
│   ├── pull_request
│   ├── issue
│   ├── ci_run
│   ├── branch_rule
│   ├── config
│   ├── heal_pr
│   ├── repair_proposal
│   └── ...
├── policy
├── waiver
├── rollout_plan
└── quality_gate
```

### Inheritance rules

- A grant on `installation` applies to all repositories within it.
- A grant on `repository` applies to all child resources within it.
- A grant on a specific resource (e.g., a single `repair_proposal`) applies
  only to that resource.
- **Denials do not inherit upward.** A denial at the repository level does
  not deny access to the installation. Denial flows downward only.

### Resource resolution

Every request resolves its target resource from the route:
- `:owner/:repo` path params → `repository` resource.
- `:id` body params → resource by ID (e.g., `repair_proposal`, `waiver`).
- List endpoints (no `:owner/:repo`) → the query is scoped to the
  principal's installation grants. **This closes F-09** — no more global
  default scope.

---

## 4. Actions and permissions

### Action taxonomy

| Action | Description | Examples |
|--------|-------------|----------|
| `read` | View data | GET endpoints, list queries |
| `write` | Create or modify governed state | POST/PUT/PATCH/DELETE on config, policies, gates |
| `github:mutate` | Perform a GitHub API mutation | branch protection, PR merge, label, collaborator |
| `queue:enqueue` | Submit a background job | sync, heal, fix, maintainer triggers |
| `approve` | Authorize a governed workflow step | rollout approval, critic review |
| `manage:identity` | Create/disable principals, roles, credentials | admin-only |
| `admin` | Bootstrap, recovery, break-glass | admin-only |

### Permission naming

```
<resource-type>:<action>
```

Examples:
- `repository:read`
- `repository:write`
- `repository:github:mutate`
- `policy:write`
- `waiver:revoke`
- `rollout:approve`
- `identity:manage`

### Scope modifiers

Each permission carries an optional scope:
- `own` — only resources the principal owns or is granted.
- `installation` — resources within the principal's installation(s).
- `fleet` — all installations (admin only).

---

## 5. Role composition

### Built-in roles

| Role | Permissions | Scope |
|------|------------|-------|
| `admin` | all actions on all resources | fleet |
| `operator` | read + write + github:mutate + queue:enqueue on repositories; policy:read; waiver:read | installation |
| `reviewer` | read + approve on rollouts, repairs, gates | installation |
| `viewer` | read only | installation |
| `service:repair-worker` | write on repair_proposals, patch_artifacts; queue:enqueue on verification, critic | installation (worker-scoped) |
| `service:heal-worker` | github:mutate on repository; write on heal_prs, managed_actions | installation (worker-scoped) |
| `service:sync-worker` | write on installations, repositories; github:mutate (read-only) | fleet (worker-scoped) |
| `bot` | read on repositories, issues, activity; write on fix/issue triggers | installation (linked-user-scoped) |
| `legacy-key` | read + write (no manage:identity, no admin, no approve) | installation (mapped) |

### Role assignment

```text
auth_principal_roles
  principal_id    UUID FK
  role_id         UUID FK
  scope_type      ENUM('installation', 'repository', 'fleet')
  scope_id        bigint NULL  -- installation_id or repo github_id; NULL for fleet
  granted_at      timestamptz
  granted_by      UUID FK (principal)
  expires_at      timestamptz NULL
  revoked_at      timestamptz NULL
  revoked_by      UUID FK NULL
  revocation_reason text NULL
```

Role assignments are durable — revocation sets `revoked_at`, never deletes.
This preserves audit history. Active roles are those where `revoked_at IS NULL`
and (`expires_at IS NULL` OR `expires_at > now()`).

---

## 6. Evaluation algebra

For every request:

```text
effective_permission =
  role_permissions(principal, resource)
  ∩ credential_scopes(credential)
  ∩ resource_grants(principal, resource)
  ∩ operation_policy(route)
```

### Evaluation order

1. **Authenticate** → resolve principal + credential.
2. **Resolve resource** → determine the target resource from route params.
3. **Load active roles** → query `auth_principal_roles` for the principal,
   filtered by scope matching the resource.
4. **Compute role permissions** → union of all active role permission sets.
5. **Intersect with credential scopes** → the credential can only narrow.
6. **Intersect with resource grants** → explicit allow/deny on the specific
   resource.
7. **Apply operation policy** → route-level required permissions.
8. **Return decision** → allow + audit, or deny + structured reason.

### Re-authorization for sensitive operations

For operations classified as sensitive (policy promotion, credential
management, role/grant changes, branch deletion, merge, repository
transfer), the evaluator re-reads current roles and grants at decision
time rather than trusting cached session claims. This closes the
"session stale after revocation" gap.

---

## 7. Default-deny and explicit-deny semantics

- **Default deny:** if no allow rule matches, the decision is `DENY` with
  reason `no_matching_allow`.
- **Explicit deny:** an explicit deny on a resource overrides any allow
  from role or credential. Denial reason: `explicit_deny`.
- **Deny precedence:** explicit deny > credential scope > resource grant
  > role permission. If any layer denies, the result is deny.
- **No implicit allow from authentication:** being authenticated is
  necessary but not sufficient. The principal must also have an allow
  rule for the specific resource+action.

---

## 8. Tenant and repository boundaries

### Current defect (F-09)

List endpoints default to global scope — all installations' data in one
response. No `installation_id` filter unless the caller provides
`:owner/:repo`.

### Proposed model

- Every query that reads installation-scoped data must include a
  `WHERE installation_id IN (<principal's granted installations>)` clause.
- The principal's installation grants are loaded at step 6 of the
  evaluation algebra.
- Route handlers receive `req.auth.installationIds` (an array) and pass
  it to their service-layer queries.
- `:owner/:repo` routes additionally verify that the resolved repository
  belongs to one of the principal's granted installations.

### Worker scope

Workers receive installation scope from the job payload, but the job's
authorization is validated at enqueue time (see §9). A queue-injected job
(**F-06**) is mitigated by a separate job-authorization token bound to the
enqueueing principal and verified at dequeue time. Full resolution of F-06
requires the queue-authorization mechanism from PR 9 of the identity
modernization plan.

---

## 9. Ownership and delegation

### Resource ownership

- Every governed resource has an `owner_principal_id` (the principal that
  created it).
- The owner implicitly has `read` + `write` on their own resources.
- Transfer of ownership is a `manage` operation.

### Delegation model

A human principal can delegate a subset of their authority to a worker:

```text
auth_delegations
  id                UUID primary key
  initiating_principal_id  UUID FK
  worker_service_principal_id UUID FK
  operation         text        -- e.g., 'verify-proposal', 'heal-run'
  resource_type     text        -- e.g., 'repair_proposal', 'repository'
  resource_id       bigint NULL
  authorization_decision_id UUID FK
  plan_hash         text NULL   -- for immutable approved plans
  created_at        timestamptz
  expires_at        timestamptz
  execution_status  ENUM('pending', 'executing', 'completed', 'cancelled', 'denied')
  revoked_at        timestamptz NULL
```

- The delegation records what authority was granted, to which worker, for
  which operation and resource.
- Sensitive operations require re-authorization (§6) — the delegation is
  checked for non-revocation before execution.
- Immutable approved plans may complete even if the initiating principal is
  later disabled, provided the plan was explicitly approved and the
  delegation is not explicitly revoked.

### Queue-authorization token (F-06 mitigation)

Every job carries a signed authorization token binding:
- The initiating principal ID.
- The worker service principal ID.
- The operation and resource.
- The authorization decision ID.
- An expiry timestamp.

The worker verifies the token before executing. A queue-injected job
without a valid token is rejected with `denied:missing_job_authorization`.

---

## 10. Service-account scope

### Service principals

Each worker is a named service principal with a narrow role:
- `service:repair-worker` — can write repair data, cannot manage identity.
- `service:heal-worker` — can perform GitHub mutations, cannot approve
  rollouts.
- `service:sync-worker` — can upsert installation/repo data fleet-wide.

### Credential scoping

A service principal may have multiple credentials, each with independent:
- Scope restrictions (subset of the service's role permissions).
- Repository restrictions (subset of installations).
- Environment restriction (e.g., `production` vs `isolated`).
- Expiry.
- Ingress restrictions (network allowlist).

### Bot authorization (F-07 resolution)

The Telegram bot authenticates as a `bot` service principal. Each action
is evaluated using:

```text
bot service permissions
  ∩ linked user's permissions
  ∩ linked user's resource grants
  ∩ operation policy
```

The linked user's roles are re-read at decision time — the comment-command
role check is no longer discarded at queue time. If the linked user's
authority has been revoked, the action is denied.

---

## 11. Break-glass and emergency access

### Break-glass principal

- A dedicated `break_glass` role with fleet-wide `admin` permissions.
- Activated only through a separate audited mechanism (not a normal login).
- Every action is distinctly tagged in the audit log as `break_glass`.
- Break-glass sessions have short absolute expiry (e.g., 30 minutes).
- Break-glass actions trigger an alert to other administrators.

### Emergency bootstrap

If all administrators are locked out:
1. The bootstrap mechanism is re-enabled.
2. Requires the operational secret.
3. Creates a temporary admin principal.
4. Records a canonical audit event with `bootstrap` context.

---

## 12. Decision context and denial reasons

### Decision record

Every authorization evaluation produces:

```json
{
  "decision": "allow|deny",
  "principal_id": "...",
  "credential_id": "...",
  "resource_type": "repository",
  "resource_id": 12345,
  "action": "repository:write",
  "route": "PUT /api/config/:owner/:repo",
  "reason_code": "no_matching_allow|explicit_deny|credential_scope_denied|resource_grant_denied|operation_policy_denied|expired|disabled|wrong_environment|reauthorization_required",
  "role_permissions_evaluated": true,
  "credential_scopes_evaluated": true,
  "resource_grants_evaluated": true,
  "timestamp": "..."
}
```

### Denial reason codes

| Code | Meaning |
|------|---------|
| `no_matching_allow` | Default deny — no rule permitted this action |
| `explicit_deny` | An explicit deny rule matched |
| `credential_scope_denied` | The credential's scope does not include this action |
| `resource_grant_denied` | The principal has no grant for this resource |
| `operation_policy_denied` | The route's operation policy requires a permission the principal lacks |
| `expired` | The credential, role, or grant has expired |
| `disabled` | The principal or credential is disabled |
| `wrong_environment` | The credential is restricted to a different environment |
| `reauthorization_required` | Sensitive operation requires fresh role/grant re-read; cached session claims insufficient |
| `missing_job_authorization` | Worker received a job without a valid authorization token (F-06) |

### External error responses

Externally, all denials return a generic `403 Forbidden` with
`{"error": "insufficient_permissions"}`. Detailed reason codes appear only
in internal audit events.

---

## 13. Compatibility treatment for existing paths

### Legacy shared-key bridge (F-02, F-08)

The current `API_KEY`/`API_KEYS` model maps to `legacy-key` principals.
Each key fingerprint is registered as a temporary `legacy-key` principal
with:

- **Allowed scopes:** read + write on installation-scoped resources.
- **Denied scopes:** `manage:identity`, `admin`, `approve`.
- **Migration ticket:** each legacy key carries an expiry date and a linked
  migration ticket.
- **Usage inventory:** every use records the credential fingerprint, route,
  operation, repository, source address, user agent, and timestamp.

Legacy keys cannot:
- Create or expand principals, credentials, roles, or grants.
- Access bootstrap or recovery endpoints.
- Approve rollouts or promote policies.

### Anonymous paths

Current anonymous paths and their treatment:

| Path | Current | Proposed |
|------|---------|----------|
| `GET /health` | Anonymous | Remains anonymous. Liveness signal only. No governed data exposed beyond deployment metadata. |
| `POST /webhooks/github` | HMAC-verified | Remains HMAC-verified. Webhook handler authenticates as the `installation` principal (P-3), not as a human. |
| `POST /api/auth/login` | Anonymous (key exchange) | Remains anonymous. Login resolves to a `user` principal after identity verification. |
| `POST /api/auth/logout` | Anonymous (cookie) | Remains anonymous. Session destruction. |
| `GET /api/auth/check` | Anonymous (session probe) | Remains anonymous. Returns only whether a session is valid — no governed data. |

### Dashboard session migration

Dashboard users currently authenticate with the shared API key via cookie
session. Migration path:
1. GitHub App OAuth flow creates a `user` principal and session.
2. During the migration period, both OAuth and legacy-key sessions coexist.
3. Legacy-key login is disabled only after all dashboard users have
   migrated (PR 14 of the identity modernization plan).

---

## 14. Finding resolution matrix

How the proposed model addresses each W0-A finding:

| Finding | Severity | Resolution |
|---------|----------|------------|
| **F-01** | CRITICAL | Webhook secret defaults to `dev-secret`. Production startup check (already fixed in PR #40). Model requires all production secrets to be explicitly set. |
| **F-02** | HIGH | `revokeWaiver(id)` has no tenant filter. Model requires resource-scoped authorization on all mutations. Waiver revocation checks `installation_id` ownership. Legacy-key bridge narrows this to installation-scoped only. |
| **F-03** | HIGH | Audit-attribution forgery. Model attaches authenticated principal ID to every request. Actor fields are derived from `req.auth.principalId`, not from client-supplied headers. |
| **F-04** | LOW | Non-constant-time executor-service compare. Model specifies constant-time comparison for all credential checks. Low priority due to private-network boundary. |
| **F-05** | HIGH | Webhook replay. Model requires delivery-dedupe BEFORE side effects, not after. Queue-authorization token (§9) binds the job to the verified delivery. |
| **F-06** | HIGH | Trust-the-payload worker model. Queue-authorization token (§9) signed at enqueue time, verified at dequeue. Job without valid token is rejected. |
| **F-07** | HIGH | Comment-command authority discard. Bot authorization (§10) re-reads linked user's roles at decision time. Role is not discarded at queue time. |
| **F-08** | MEDIUM | Auto-generated key logged. Production fail-closed (already fixed in PR #40). Model requires explicit credential provisioning. |
| **F-09** | HIGH | List endpoints global by default. Model requires installation-scoped queries (§8). Principal's installation grants filter every list query. |
| **F-10** | HIGH | Fleet reconciler has no pillar gate. Model requires explicit operation policy on every route, including scheduled jobs. The reconciler's operation policy must declare its required permissions and resource scope. |
| **F-11** | MEDIUM | Audit hash chain race-fork. Model specifies synchronized chain computation (transactional SELECT-then-INSERT or equivalent). PR 5 of the identity plan repairs the ledger. |
| **F-12** | MEDIUM | `audit_exports` phantom file. Model requires audit exports to either write the file or not claim a path. Design debt, not authority model. |
| **F-13** | LOW | SQL syntax bug. Not an authority-model issue. Separated into issue #79. |
| **F-14** | LOW | `Set.has` non-constant-time. Model specifies constant-time comparison for credential validation. Low priority. |
| **F-15** | LOW | Local private key on disk. Operator hygiene. Model does not change this; `.gitignore` coverage is the control. |

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
