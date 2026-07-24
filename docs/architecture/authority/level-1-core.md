# Level 1 Authority Core (W0-C-R)

> **Permanent upstream security profile.** Level 1 is the default
> security posture for every GitWire installation. Most deployments
> should never need to leave it. Level 2 and Level 3 are optional
> deployment profiles for operators who need stronger assurance — they
> are not the expected upstream roadmap or end state.
>
> This document is the sole normative specification for the Level 1
> authority core. It implements issue #80 and supersedes the frozen
> W0-C draft on `lane-b/wave-0-authority-cartography` (research source
> only — not merged or copied).

## Table of contents

1. [Product position](#1-product-position)
2. [Threat model and trust boundaries](#2-threat-model-and-trust-boundaries)
3. [Server-owned identities](#3-server-owned-identities)
4. [Trusted request context](#4-trusted-request-context)
5. [Repository-scoped authorization](#5-repository-scoped-authorization)
6. [Immutable mutation commands](#6-immutable-mutation-commands)
7. [Append-only mutation events and receipts](#7-append-only-mutation-events-and-receipts)
8. [Central GitHub mutation executor](#8-central-github-mutation-executor)
9. [Prohibited direct-write paths](#9-prohibited-direct-write-paths)
10. [Self-management policy](#10-self-management-policy)
11. [Minimal additive schema](#11-minimal-additive-schema)
12. [Migration, cutover, and rollback order](#12-migration-cutover-and-rollback-order)
13. [Least-privilege roles](#13-least-privilege-roles)
14. [Level 2/3 extension seams](#14-level-23-extension-seams)
15. [Test matrix](#15-test-matrix)
16. [Retention](#16-retention)

---

## 1. Product position

**Level 1 is the permanent upstream GitWire security profile.**

It provides:

1. Server-owned human and service identities (no client-supplied
   principal headers).
2. Repository-scoped application authorization.
3. Immutable mutation commands with durable provenance.
4. A single central GitHub mutation executor (no scattered write paths).
5. Unique idempotency keys and CAS lifecycle transitions.
6. A small append-only command/event audit trail.
7. GitHub-native branch protection, required checks/reviews,
   CODEOWNERS, and protected deployment controls for self-authority
   changes.

Level 2 (optional) adds per-service database identity, capability
JTI, step-up approval. Level 3 (optional) adds cryptographic command
signing, external attestation, external audit ledger. These are
deployment-choice enrichments — not an upstream destination.

Upstream owns the stable extension seams. Deployments requiring
stronger assurance own the additional implementation and operational
cost.

---

## 2. Threat model and trust boundaries

### Threats Level 1 addresses

| Threat | Control |
|--------|---------|
| Client-supplied identity forgery (header spoofing) | Server-owned identities; principal derived from authenticated credential, never from request headers |
| Cross-repository mutation (acting on repo B with repo A's authority) | Repository-scoped authorization; every command binds exact installation/repo/resource |
| Concurrent duplicate execution (retries, redeliveries) | Idempotency keys; CAS lifecycle transitions |
| Unauthorized GitHub writes (scattered octokit calls) | Central executor is the sole write boundary; all other paths are read-only |
| Confused-deputy executor (forged commands admitted to queue) | Commands must be admitted by the trusted command-admission path; executor verifies the command's `admitted` state and `admitting_service`; ordinary application code cannot forge admission |
| Audit gaps (missing or forgeable attribution) | Append-only command/event trail; provenance recorded at command creation; event INSERT authority partitioned by source |
| Self-authority hijack (GitWire modifies its own security controls) | GitHub branch protection + required review; GitWire may propose but never autonomously merge |
| Stale authority (revoked credential still effective) | `auth_epoch` invalidation; credential revocation is immediate |
| Lifecycle tampering (arbitrary state jumps, version manipulation) | DB-enforced legal-transition trigger + CAS function; direct UPDATE blocked for lifecycle fields |

### Trust boundaries

```
[HTTP Client] → [Application Gateway] → [PostgreSQL] → [Workers]
                        ↓                      ↓
                  [Authorization]         [Command Store]
                        ↓                      ↓
                  [Command Admission]    [Central Executor] → [GitHub API]
                        ↓                      ↓
                  [Command Queue]        [Events + Receipts]
```

- **Client → Application:** untrusted. Client provides credentials; the
  application authenticates and derives the principal. Client headers
  are never authoritative.
- **Application → PostgreSQL:** trusted for identity derivation and
  authorization evaluation. The application runs under a shared
  database role (`gitwire_app`). The database does NOT authenticate
  individual workers behind this shared role.
- **PostgreSQL:** trusted for data invariants (FK, CHECK, immutability,
  CAS, legal transitions, append-only). NOT trusted to authenticate
  workers.
- **Command admission → Command queue:** the trusted admission path
  creates commands with `lifecycle_state = 'pending'` and
  `admitted = true`. Ordinary application code routes mutation requests
  through this path; it does not directly INSERT commands.
- **Executor → GitHub:** sole write boundary. The executor reads
  `admitted` commands, verifies installation/repository/payload binding,
  and executes. It does not evaluate authorization (that happened at
  admission time) but it does verify the command was properly admitted.

### Non-goals (Level 1)

- No database-level worker authentication (workers share the
  application DB role).
- No execution-attempt UUIDs treated as identity proof (they are
  concurrency tokens only).
- No delegation-claim authentication protocol (Level 2 concern).
- No cryptographic command signing (Level 3 concern).
- No external attestation implementation (Level 3 concern).
- No speculative archival subsystems (retain indefinitely or define
  privileged cleanup — see §16).
- No enterprise multi-party approval machinery (Level 2/3 concern).

---

## 3. Server-owned identities

### Principal types

Every authenticated request resolves to a server-owned principal
record. The application authenticates the user or service and derives
the principal from the authenticated credential — never from a
client-supplied header or UUID.

Level 1 supports the five principal types from accepted W0-B:

```text
auth_principals
  id              UUID PRIMARY KEY
  principal_type  text NOT NULL      -- 'user' | 'service' | 'installation' | 'system' | 'legacy-key'
  display_name    text NOT NULL
  status          text NOT NULL DEFAULT 'active'  -- 'active' | 'disabled'
  github_user_id  bigint             -- only for type='user' (nullable; bootstrap admin may lack it)
  installation_id bigint             -- only for type='installation'
  auth_epoch      bigint NOT NULL DEFAULT 0
  created_at      timestamptz NOT NULL DEFAULT now()
  updated_at      timestamptz NOT NULL DEFAULT now()
```

| Type | Binding | Used by |
|------|---------|---------|
| `user` | `github_user_id` (nullable for bootstrap admin) | Dashboard users, operators |
| `service` | None (no GitHub identity) | Workers, executor, bot |
| `installation` | `installation_id` (required) | Webhook ingress path |
| `system` | None | Schedulers, migration runner |
| `legacy-key` | None | Existing shared-key clients during migration |

The `auth_epoch` column increments on credential revocation, role
revocation, or admin-forced session invalidation. Sessions compare
their epoch against the principal's current epoch on every request.

### Credential resolution

The application resolves credentials as follows:

1. **API key:** `Authorization: Bearer <key>` → lookup by credential
   ID → HMAC-verify the secret → resolve to a principal.
2. **Session:** session token → Redis lookup → resolve to a principal.
3. **GitHub OAuth:** OAuth code → GitHub token exchange → resolve to
   a user principal via `github_user_id`.
4. **Webhook HMAC:** GitHub webhook signature verified → resolve to
   an `installation` principal via `installation_id`.

In all cases, the **principal ID is derived from the authenticated
credential, not from the request**.

---

## 4. Trusted request context

Every authorized request produces a **trusted request context** that
the application derives before evaluating authorization or creating
commands:

```text
RequestContext {
  principal: {
    id:              UUID     -- server-derived from authenticated credential
    type:            text     -- 'user' | 'service' | 'installation' | 'system' | 'legacy-key'
    auth_epoch:      bigint
  }
  requesting_service: {
    id:              UUID     -- the service component making the request
    name:            text     -- e.g., 'gitwire-app', 'executor-service'
  }
  authentication_method: text -- 'api_key' | 'session' | 'github_oauth' | 'webhook_hmac'
  target: {
    installation_id: bigint   -- stable GitHub installation ID
    repository_id:   bigint   -- stable GitHub repository ID (github_id)
    organization:    text
    repository:      text
    resource_type:   text
    resource_id:     text
  }
}
```

Neither the `principal.id` nor the `requesting_service.id` is
client-supplied. The application derives them from the authenticated
session/credential and the internal service registry.

---

## 5. Repository-scoped authorization

The application evaluates authorization before creating any mutation
command:

```js
authorize({
  principal,          // from RequestContext
  requestingService,  // from RequestContext
  operation,          // the operation being requested
  resource,           // { installation_id, repository_id, resource_type, resource_id }
});
```

### Authorization source

The application loads authorization data from the `auth_roles`,
`auth_role_permissions`, and `auth_principal_roles` tables (defined in
§11). These provide a minimal durable representation compatible with
the accepted W0-B model:

- **Roles** are named permission sets.
- **Permissions** are `<resource_type>:<action>` tokens from the W0-B
  57-resource registry.
- **Scope** is repository-scoped via `scope_type` and `scope_id`.
- **Default deny.** Every request is denied unless an explicit allow
  matches.

### Evaluation model

Authorization is an **application-layer** evaluation. It is NOT
deferred to PostgreSQL. The application:

1. Loads the principal's active role assignments (non-expired,
   non-revoked, role `status = 'active'`).
2. Computes the permission set from the active roles.
3. Checks whether the principal has the required permission for the
   operation on the target resource.
4. Checks repository scope: the principal's scope must encompass the
   target repository.
5. Produces an **authorization result** (allow/deny + reason + policy
   version + evaluated-input snapshot).

The authorization result is recorded as part of the mutation command's
provenance (§6). The database does not re-run the authorization engine.

---

## 6. Immutable mutation commands

Every GitHub mutation originates as an **immutable mutation command**.
Once created, the command's identity, operation, target, payload, and
attribution cannot change. Only lifecycle state transitions through
a CAS function.

### Minimum durable provenance

Every Level 1 command durably carries:

```text
MutationCommand {
  id:                    UUID PRIMARY KEY
  -- Identity and attribution (immutable)
  initiating_principal:  UUID NOT NULL
  requesting_service:    UUID NOT NULL
  authentication_method: text NOT NULL
  -- Target (immutable, using stable GitHub IDs)
  target_installation_id: bigint NOT NULL    -- stable GitHub installation ID
  target_repository_id:   bigint NOT NULL    -- stable GitHub repository ID
  target_organization:    text NOT NULL
  target_repository:      text NOT NULL
  target_resource_type:   text NOT NULL
  target_resource_id:     text
  -- Operation (immutable)
  operation:              text NOT NULL
  payload_hash:           text NOT NULL      -- sha256 of canonical payload
  payload_canonical:      jsonb NOT NULL     -- immutable canonical payload
  -- Authorization evidence (immutable)
  auth_result_snapshot:   jsonb NOT NULL
  auth_policy_version:    text NOT NULL
  assurance_profile:      text NOT NULL DEFAULT 'level1'
  -- Admission (set by trusted admission path, immutable after INSERT)
  admitted:               boolean NOT NULL DEFAULT true
  admitting_service:      UUID NOT NULL
  -- Concurrency
  idempotency_key:        text NOT NULL      -- unique per logical operation
  lifecycle_version:      bigint NOT NULL DEFAULT 0
  lifecycle_state:        text NOT NULL DEFAULT 'pending'
  -- Extension seam (immutable after creation in Level 1; see §14)
  extension:              jsonb
  -- Timestamps
  created_at:             timestamptz NOT NULL DEFAULT now()
  transitioned_at:        timestamptz
}
```

The `payload_canonical` field stores the immutable canonical payload
(RFC 8785 JSON). The executor uses this to construct the exact GitHub
API request. The `payload_hash` is `sha256(payload_canonical::text)`.

The idempotency constraint uses stable identity:
`UNIQUE (target_installation_id, target_repository_id, operation, idempotency_key)`.
This prevents collisions between same-named repos in different
installations and survives repository renames.

### Immutability

All fields except `lifecycle_state`, `lifecycle_version`, and
`transitioned_at` are immutable after INSERT. This includes `extension`
— in Level 1, the extension seam is write-once at creation time
(populated by Level 2/3 enrichment at the admission boundary, not
mutated afterward). A BEFORE UPDATE trigger enforces field-level
immutability.

### Lifecycle states and legal transitions

```text
pending → submitted → executing → completed
                                  ↘ failed
                       cancelled (from pending or submitted only)
```

Legal transitions enforced by a database trigger:

| From | Allowed to |
|------|-----------|
| `pending` | `submitted`, `cancelled` |
| `submitted` | `executing`, `cancelled` |
| `executing` | `completed`, `failed` |
| `completed` | (terminal) |
| `failed` | (terminal) |
| `cancelled` | (terminal) |

The trigger rejects all other transitions (e.g., `completed → pending`,
`pending → completed`, `executing → cancelled`). See §11 for the
trigger definition.

### CAS mutation

Lifecycle transitions use a SECURITY DEFINER function that performs
compare-and-swap on `(id, expected_state, expected_version)`. Direct
table UPDATE on lifecycle fields is blocked by column-level privilege:
only the function owner (a NOLOGIN role) can UPDATE lifecycle columns.
Both application and executor call the function; neither has direct
UPDATE on lifecycle fields.

---

## 7. Append-only mutation events and receipts

Every command execution produces append-only events. Each event
records the **actor and source** responsible for the append:

```text
MutationEvent {
  id:              UUID PRIMARY KEY
  command_id:      UUID NOT NULL REFERENCES mutation_commands(id)
  event_type:      text NOT NULL    -- 'admitted', 'submitted', 'started', 'succeeded', 'failed', 'cancelled', 'reconciled'
  actor_principal  UUID             -- who caused this event
  event_source     text NOT NULL    -- 'admission', 'executor', 'reconciler'
  event_data:      jsonb
  occurred_at:     timestamptz NOT NULL DEFAULT now()
}
```

### Partitioned INSERT authority

Event INSERT authority is partitioned by source to prevent forgery:

- **Admission events** (`admitted`, `submitted`, `cancelled`): the
  command-admission path (running as `gitwire_app`) may INSERT these.
  A CHECK constraint or trigger enforces `event_source = 'admission'`
  for these event types.
- **Execution events** (`started`, `succeeded`, `failed`, `reconciled`):
  only the executor (running as `gitwire_executor`) may INSERT these.
  A CHECK constraint enforces `event_source = 'executor'` for these
  event types.

The application (`gitwire_app`) has INSERT on events but only for
admission-type events. The executor (`gitwire_executor`) has INSERT
only for execution-type events. A BEFORE INSERT trigger on
`mutation_events` enforces this partition by checking
`current_user` against the `event_source`.

### GitHub receipts

Only the executor may INSERT receipts:

```text
ExecutionReceipt {
  id:              UUID PRIMARY KEY
  command_id:      UUID NOT NULL REFERENCES mutation_commands(id)
  github_endpoint: text NOT NULL
  github_status:   integer
  github_response: jsonb
  github_oid:      text
  executed_at:     timestamptz NOT NULL DEFAULT now()
}
```

The application has SELECT on receipts but **no INSERT**. Only
`gitwire_executor` has INSERT. This prevents the application from
forging GitHub response evidence.

---

## 8. Central GitHub mutation executor

### Executor independence

The executor is an independent security boundary, not a pass-through.
It verifies:

1. **Admission**: the command has `admitted = true` and a valid
   `admitting_service`. Commands without admission are rejected.
2. **Installation binding**: the command's `target_installation_id`
   matches the executor's GitHub installation context.
3. **Payload binding**: `payload_canonical` matches `payload_hash`.
4. **Repository binding**: `target_repository_id` resolves to a real
   repository in the target installation.
5. **Idempotency**: the command has not already been executed (checked
   via lifecycle state and event history).

The executor does NOT re-evaluate authorization (that happened at
admission time). But it verifies the command was properly admitted —
this prevents a compromised worker from manufacturing commands directly
in the queue.

### Executor contract

The executor:

1. Reads `admitted` commands with `lifecycle_state = 'submitted'`.
2. Transitions to `executing` via the CAS function.
3. Constructs the GitHub API request from `payload_canonical`.
4. Executes the request using its exclusive GitHub write credentials.
5. Records the receipt.
6. Transitions to `completed` or `failed` via the CAS function.

### Confused-deputy prevention

The combination of:
- Commands must be `admitted = true` (set only by the trusted admission
  path, which evaluates authorization).
- The application has no direct UPDATE on lifecycle fields (only the
  CAS function can transition).
- Event/receipt INSERT is partitioned by source.

...ensures a compromised worker cannot manufacture an authorized-looking
command, skip the admission path, or forge execution evidence. The
worker would need to call the admission API, which evaluates
authorization and records the authorizing principal.

---

## 9. Prohibited direct-write paths

**Ordinary routes, workers, schedulers, Telegram handlers, maintenance
tasks, and repair components must not call GitHub mutation APIs
directly.**

### Cutover sequence

1. **Observe-only** (default after migration): the existing direct-write
   path continues to perform GitHub mutations. The new admission path
   creates commands and **shadow-validates** them (checks authorization,
   constructs the would-be GitHub request, compares against the actual
   request the legacy path made) but does **NOT** execute a second
   mutation. This surfaces discrepancies without duplicate side effects.

2. **Enforce**: new mutations must go through the admission path and
   executor. The legacy direct-write path is blocked at the code level
   (the application gates writes on the enforcement state). No duplicate
   execution occurs — only the executor writes.

3. **Executor-only**: GitHub write credentials are revoked from the
   application and granted only to the executor.

4. **Legacy removal**: direct-write code is removed.

### What is NOT a direct write

- GitHub **read** APIs are not mutations.
- Workers creating commands (for the executor) are not performing
  direct writes.
- The executor calling GitHub APIs is the intended write path.

---

## 10. Self-management policy

GitWire's own authority-sensitive files require independent GitHub
controls:

### Authority-sensitive files

- `AGENTS.md`
- `docs/architecture/authority/`
- `.github/workflows/` (CI/CD)
- `CODEOWNERS`
- Branch protection rules
- Deployment environment configurations
- Database migration files (post-W0-E)

### Required GitHub controls

- **Protected branches**: `master` requires pull request review.
- **Required checks**: CI must pass before merge.
- **CODEOWNERS**: authority-sensitive files require designated-owner
  review.
- **Required human review**: at least one human approval.
- **Protected deployment environments**: production requires manual
  approval.

### GitWire may not autonomously

- Merge pull requests affecting its own authority-sensitive files.
- Deploy changes to production without human approval.
- Modify branch protection rules, CODEOWNERS, or CI workflows.
- Rotate or modify its own GitHub App credentials.

GitWire **may** prepare branches, commits, proposals, and pull
requests. It may not merge or deploy them.

---

## 11. Minimal additive schema

Level 1 adds a **small** set of tables to the existing schema. All
tables are additive — no existing tables are modified destructively.

### Schema and extensions

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS gitwire_auth;
REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC;
```

### Table: `gitwire_auth.auth_principals`

```sql
CREATE TABLE gitwire_auth.auth_principals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  text        NOT NULL CHECK (principal_type IN
                                ('user', 'service', 'installation', 'system', 'legacy-key')),
  display_name    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  github_user_id  bigint      UNIQUE,
  installation_id bigint,
  auth_epoch      bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_auth_principals_github_user_id
  ON gitwire_auth.auth_principals (github_user_id) WHERE github_user_id IS NOT NULL;
CREATE UNIQUE INDEX ux_auth_principals_installation_id
  ON gitwire_auth.auth_principals (installation_id) WHERE installation_id IS NOT NULL;
```

### Table: `gitwire_auth.auth_credentials`

```sql
CREATE TABLE gitwire_auth.auth_credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  lookup_id       text        NOT NULL UNIQUE,
  secret_hash     text        NOT NULL,
  pepper_version  integer     NOT NULL,
  audience        text        NOT NULL,
  environment     text        NOT NULL DEFAULT 'production',
  display_prefix  text        NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid        REFERENCES gitwire_auth.auth_principals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_auth_credentials_principal
  ON gitwire_auth.auth_credentials (principal_id)
  WHERE revoked_at IS NULL;
```

### Table: `gitwire_auth.auth_roles`

```sql
CREATE TABLE gitwire_auth.auth_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  description text,
  is_builtin  boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### Table: `gitwire_auth.auth_role_permissions`

```sql
CREATE TABLE gitwire_auth.auth_role_permissions (
  role_id     uuid        NOT NULL REFERENCES gitwire_auth.auth_roles(id),
  permission  text        NOT NULL,  -- '<resource_type>:<action>' token
  PRIMARY KEY (role_id, permission)
);
```

### Table: `gitwire_auth.auth_principal_roles`

```sql
CREATE TABLE gitwire_auth.auth_principal_roles (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  role_id         uuid        NOT NULL REFERENCES gitwire_auth.auth_roles(id),
  scope_type      text        NOT NULL CHECK (scope_type IN ('installation', 'repository', 'fleet', 'system')),
  scope_id        bigint,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  granted_by      uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT chk_scope_id_required
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  CONSTRAINT chk_scope_id_null_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);

CREATE INDEX ix_auth_principal_roles_active
  ON gitwire_auth.auth_principal_roles (principal_id)
  WHERE revoked_at IS NULL;
```

### Table: `gitwire_auth.mutation_commands`

```sql
CREATE TABLE gitwire_auth.mutation_commands (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Attribution (immutable)
  initiating_principal   uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  requesting_service     uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  authentication_method  text        NOT NULL CHECK (authentication_method IN
                                     ('api_key', 'session', 'github_oauth', 'webhook_hmac')),
  -- Target (immutable, stable IDs)
  target_installation_id bigint      NOT NULL,
  target_repository_id   bigint      NOT NULL,
  target_organization    text        NOT NULL,
  target_repository      text        NOT NULL,
  target_resource_type   text        NOT NULL,
  target_resource_id     text,
  -- Operation (immutable)
  operation              text        NOT NULL,
  payload_hash           text        NOT NULL,
  payload_canonical      jsonb       NOT NULL,
  -- Authorization evidence (immutable)
  auth_result_snapshot   jsonb       NOT NULL,
  auth_policy_version    text        NOT NULL,
  assurance_profile      text        NOT NULL DEFAULT 'level1',
  -- Admission (immutable after INSERT)
  admitted               boolean     NOT NULL DEFAULT true,
  admitting_service      uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  -- Concurrency
  idempotency_key        text        NOT NULL,
  lifecycle_version      bigint      NOT NULL DEFAULT 0,
  lifecycle_state        text        NOT NULL DEFAULT 'pending'
                                     CHECK (lifecycle_state IN
                                     ('pending', 'submitted', 'executing', 'completed', 'failed', 'cancelled')),
  -- Extension (immutable in Level 1; see §14)
  extension              jsonb,
  -- Timestamps
  created_at             timestamptz NOT NULL DEFAULT now(),
  transitioned_at        timestamptz,

  -- Idempotency using stable identity
  CONSTRAINT ux_mutation_commands_idempotency
    UNIQUE (target_installation_id, target_repository_id, operation, idempotency_key)
);
```

### Table: `gitwire_auth.mutation_events`

```sql
CREATE TABLE gitwire_auth.mutation_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid        NOT NULL REFERENCES gitwire_auth.mutation_commands(id),
  event_type      text        NOT NULL CHECK (event_type IN
                     ('admitted', 'submitted', 'started', 'succeeded', 'failed', 'cancelled', 'reconciled')),
  actor_principal uuid        REFERENCES gitwire_auth.auth_principals(id),
  event_source    text        NOT NULL CHECK (event_source IN ('admission', 'executor', 'reconciler')),
  event_data      jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_mutation_events_command
  ON gitwire_auth.mutation_events (command_id, occurred_at DESC);
```

### Table: `gitwire_auth.execution_receipts`

```sql
CREATE TABLE gitwire_auth.execution_receipts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid        NOT NULL REFERENCES gitwire_auth.mutation_commands(id),
  github_endpoint text        NOT NULL,
  github_status   integer,
  github_response jsonb,
  github_oid      text,
  executed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_execution_receipts_command
  ON gitwire_auth.execution_receipts (command_id, executed_at DESC);
```

### Table: `gitwire_auth.auth_sessions`

```sql
CREATE TABLE gitwire_auth.auth_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  session_hash    text        NOT NULL UNIQUE,
  pepper_version  integer     NOT NULL,
  auth_epoch      bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip_address      inet,
  user_agent      text
);

CREATE INDEX ix_auth_sessions_principal
  ON gitwire_auth.auth_sessions (principal_id)
  WHERE revoked_at IS NULL;
```

### Table: `gitwire_auth.auth_enforcement_state`

```sql
CREATE TABLE gitwire_auth.auth_enforcement_state (
  id          integer PRIMARY KEY DEFAULT 1,
  state       text NOT NULL DEFAULT 'observed'
              CHECK (state IN ('observed', 'enforce', 'executor_only', 'legacy_removed')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  evidence    text,
  CONSTRAINT chk_single_row CHECK (id = 1)
);

INSERT INTO gitwire_auth.auth_enforcement_state (id, state) VALUES (1, 'observed')
  ON CONFLICT (id) DO NOTHING;
```

Legal enforcement-state transitions (operator-controlled):
`observed → enforce → executor_only → legacy_removed`.
Reverse transitions (`legacy_removed → executor_only`, etc.) are
permitted for rollback. The operator records `updated_by` (session
identity) and `evidence` (reason/ticket reference) on each transition.

### Lifecycle legal-transition trigger

```sql
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_legal_lifecycle_transition()
RETURNS trigger AS $$
BEGIN
  -- Only lifecycle fields may change (immutability is separate trigger)
  -- Legal transitions:
  IF NOT (
    (OLD.lifecycle_state = 'pending'   AND NEW.lifecycle_state IN ('submitted', 'cancelled')) OR
    (OLD.lifecycle_state = 'submitted'  AND NEW.lifecycle_state IN ('executing', 'cancelled')) OR
    (OLD.lifecycle_state = 'executing'  AND NEW.lifecycle_state IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Illegal lifecycle transition: % → %',
      OLD.lifecycle_state, NEW.lifecycle_state;
  END IF;

  -- Version must increment exactly once
  IF NEW.lifecycle_version != OLD.lifecycle_version + 1 THEN
    RAISE EXCEPTION 'lifecycle_version must increment exactly once: expected %, got %',
      OLD.lifecycle_version + 1, NEW.lifecycle_version;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_legal_lifecycle_transition
  BEFORE UPDATE OF lifecycle_state, lifecycle_version ON gitwire_auth.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_legal_lifecycle_transition();
```

### Command immutability trigger

```sql
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_command_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.initiating_principal != OLD.initiating_principal
     OR NEW.requesting_service != OLD.requesting_service
     OR NEW.authentication_method != OLD.authentication_method
     OR NEW.target_installation_id != OLD.target_installation_id
     OR NEW.target_repository_id != OLD.target_repository_id
     OR NEW.target_organization != OLD.target_organization
     OR NEW.target_repository != OLD.target_repository
     OR NEW.target_resource_type != OLD.target_resource_type
     OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
     OR NEW.operation != OLD.operation
     OR NEW.payload_hash != OLD.payload_hash
     OR NEW.payload_canonical != OLD.payload_canonical
     OR NEW.auth_result_snapshot != OLD.auth_result_snapshot
     OR NEW.auth_policy_version != OLD.auth_policy_version
     OR NEW.idempotency_key != OLD.idempotency_key
     OR NEW.admitted IS DISTINCT FROM OLD.admitted
     OR NEW.admitting_service != OLD.admitting_service
     OR NEW.extension IS DISTINCT FROM OLD.extension
     OR NEW.created_at != OLD.created_at THEN
    RAISE EXCEPTION 'mutation_command provenance fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_command_immutability
  BEFORE UPDATE ON gitwire_auth.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_command_immutability();
```

### Event-source partition trigger

```sql
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_event_source_partition()
RETURNS trigger AS $$
BEGIN
  -- Admission events can only be inserted by gitwire_app
  -- Execution events can only be inserted by gitwire_executor
  IF NEW.event_source = 'admission' AND current_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'admission events can only be inserted by gitwire_app';
  END IF;
  IF NEW.event_source = 'executor' AND current_user != 'gitwire_executor' THEN
    RAISE EXCEPTION 'executor events can only be inserted by gitwire_executor';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_event_source_partition
  BEFORE INSERT ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_event_source_partition();
```

### CAS lifecycle function

```sql
CREATE OR REPLACE FUNCTION gitwire_auth.transition_command_lifecycle(
  p_command_id     uuid,
  p_expected_state text,
  p_new_state      text,
  p_expected_ver   bigint
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  UPDATE mutation_commands
    SET lifecycle_state = p_new_state,
        lifecycle_version = p_expected_ver + 1,
        transitioned_at = now()
    WHERE id = p_command_id
      AND lifecycle_state = p_expected_state
      AND lifecycle_version = p_expected_ver;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
```

### Append-only triggers for events and receipts

```sql
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mutation_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_events_no_update
  BEFORE UPDATE ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_events_append_only();
CREATE TRIGGER trg_events_no_delete
  BEFORE DELETE ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_events_append_only();

CREATE OR REPLACE FUNCTION gitwire_auth.enforce_receipts_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'execution_receipts is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_receipts_no_update
  BEFORE UPDATE ON gitwire_auth.execution_receipts
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_receipts_append_only();
CREATE TRIGGER trg_receipts_no_delete
  BEFORE DELETE ON gitwire_auth.execution_receipts
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_receipts_append_only();
```

---

## 12. Migration, cutover, and rollback order

### Migration files

```
038_level1_schema.sql          — schema, tables, triggers, indexes
039_level1_roles.sql           — roles, schema grants, table privileges
040_level1_seed.sql            — bootstrap admin principal + credential
```

### Stage 038: Schema creation

Each file opens with `SET search_path = gitwire_auth, public;`.

**Object creation order:**
1. `CREATE SCHEMA gitwire_auth; REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC;`
2. `CREATE TABLE auth_principals` + unique indexes
3. `CREATE TABLE auth_credentials` + index
4. `CREATE TABLE auth_roles`
5. `CREATE TABLE auth_role_permissions`
6. `CREATE TABLE auth_principal_roles` + index
7. `CREATE TABLE mutation_commands` + idempotency constraint
8. `CREATE TABLE mutation_events` + index
9. `CREATE TABLE execution_receipts` + index
10. `CREATE TABLE auth_sessions` + index
11. `CREATE TABLE auth_enforcement_state` + seed insert
12. `CREATE FUNCTION enforce_legal_lifecycle_transition` + trigger
13. `CREATE FUNCTION enforce_command_immutability` + trigger
14. `CREATE FUNCTION enforce_event_source_partition` + trigger
15. `CREATE FUNCTION enforce_events_append_only` + triggers
16. `CREATE FUNCTION enforce_receipts_append_only` + triggers
17. `CREATE FUNCTION transition_command_lifecycle` + ALTER OWNER + REVOKE + GRANT

**Rollback (reverse order):**
1. `DROP FUNCTION transition_command_lifecycle(uuid, text, text, bigint);`
2. `DROP TRIGGER trg_receipts_no_delete; DROP TRIGGER trg_receipts_no_update;`
3. `DROP FUNCTION enforce_receipts_append_only;`
4. `DROP TRIGGER trg_events_no_delete; DROP TRIGGER trg_events_no_update;`
5. `DROP FUNCTION enforce_events_append_only;`
6. `DROP TRIGGER trg_event_source_partition;`
7. `DROP FUNCTION enforce_event_source_partition;`
8. `DROP TRIGGER trg_command_immutability;`
9. `DROP FUNCTION enforce_command_immutability;`
10. `DROP TRIGGER trg_legal_lifecycle_transition;`
11. `DROP FUNCTION enforce_legal_lifecycle_transition;`
12. `DROP TABLE auth_enforcement_state;`
13. `DROP TABLE auth_sessions;`
14. `DROP TABLE execution_receipts;`
15. `DROP TABLE mutation_events;`
16. `DROP TABLE mutation_commands;`
17. `DROP TABLE auth_principal_roles;`
18. `DROP TABLE auth_role_permissions;`
19. `DROP TABLE auth_roles;`
20. `DROP TABLE auth_credentials;`
21. `DROP TABLE auth_principals;`
22. `DROP SCHEMA gitwire_auth;`

### Stage 039: Roles and privileges

```sql
SET search_path = gitwire_auth, public;

-- Create roles (idempotent for production vs. smoke test)
DO $$ BEGIN CREATE ROLE gitwire_auth_fn_owner NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE gitwire_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE gitwire_executor; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE gitwire_operator; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schema usage
GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_app, gitwire_executor, gitwire_operator;

-- Function owner: lifecycle transitions only
GRANT UPDATE (lifecycle_state, lifecycle_version, transitioned_at)
  ON mutation_commands TO gitwire_auth_fn_owner;
GRANT SELECT ON mutation_commands TO gitwire_auth_fn_owner;

-- Application: principals, credentials, sessions, roles, commands, admission events
GRANT SELECT, INSERT ON auth_principals TO gitwire_app;
GRANT UPDATE (status, auth_epoch, updated_at) ON auth_principals TO gitwire_app;
GRANT SELECT, INSERT ON auth_credentials TO gitwire_app;
GRANT UPDATE (revoked_at, revoked_by, updated_at) ON auth_credentials TO gitwire_app;
GRANT SELECT, INSERT ON auth_sessions TO gitwire_app;
GRANT UPDATE (revoked_at) ON auth_sessions TO gitwire_app;
GRANT DELETE ON auth_sessions TO gitwire_app;
GRANT SELECT ON auth_roles TO gitwire_app;
GRANT SELECT, INSERT ON auth_role_permissions TO gitwire_app;
GRANT SELECT, INSERT ON auth_principal_roles TO gitwire_app;
GRANT UPDATE (revoked_at) ON auth_principal_roles TO gitwire_app;
GRANT SELECT, INSERT ON mutation_commands TO gitwire_app;
-- Application CANNOT UPDATE lifecycle fields (only CAS function can)
-- Application CAN INSERT admission events but NOT execution events (enforced by trigger)
GRANT SELECT, INSERT ON mutation_events TO gitwire_app;
-- Application CANNOT INSERT receipts (executor only)
GRANT SELECT ON execution_receipts TO gitwire_app;
GRANT SELECT ON auth_enforcement_state TO gitwire_app;

-- Executor: commands (read + lifecycle via function), execution events, receipts
GRANT SELECT ON mutation_commands TO gitwire_executor;
GRANT SELECT, INSERT ON mutation_events TO gitwire_executor;
GRANT SELECT, INSERT ON execution_receipts TO gitwire_executor;

-- Function owner transition grant
GRANT EXECUTE ON FUNCTION transition_command_lifecycle(uuid, text, text, bigint) TO gitwire_app;
GRANT EXECUTE ON FUNCTION transition_command_lifecycle(uuid, text, text, bigint) TO gitwire_executor;

-- Operator: inspect everything, transition enforcement state
GRANT SELECT ON auth_principals TO gitwire_operator;
GRANT SELECT ON auth_credentials TO gitwire_operator;
GRANT SELECT ON auth_roles TO gitwire_operator;
GRANT SELECT ON auth_role_permissions TO gitwire_operator;
GRANT SELECT ON auth_principal_roles TO gitwire_operator;
GRANT SELECT ON mutation_commands TO gitwire_operator;
GRANT SELECT ON mutation_events TO gitwire_operator;
GRANT SELECT ON execution_receipts TO gitwire_operator;
GRANT SELECT ON auth_sessions TO gitwire_operator;
GRANT SELECT ON auth_enforcement_state TO gitwire_operator;
GRANT UPDATE (state, updated_at, updated_by, evidence) ON auth_enforcement_state TO gitwire_operator;
```

**Rollback:** REVOKE all grants from each role. Do NOT drop
`gitwire_app` (may be shared with existing application). Drop
`gitwire_auth_fn_owner`, `gitwire_executor` if created by this
migration.

### Stage 040: Bootstrap seed

Creates the initial admin principal and credential using a
deterministic UUID for rollback identification:

```sql
SET search_path = gitwire_auth, public;

-- Bootstrap admin principal (deterministic UUID for rollback)
INSERT INTO auth_principals (id, principal_type, display_name)
VALUES (uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin'),
        'user', 'Bootstrap Admin')
ON CONFLICT DO NOTHING;

-- Bootstrap admin credential
INSERT INTO auth_credentials (id, principal_id, lookup_id, secret_hash,
  pepper_version, audience, display_prefix)
VALUES (uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin-credential'),
        uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin'),
        'bootstrap-admin', '<hash-from-environment>', 1, 'gitwire-app', 'gw_pat_')
ON CONFLICT DO NOTHING;

-- Bootstrap admin role assignment (fleet scope)
INSERT INTO auth_principal_roles (principal_id, role_id, scope_type, granted_by)
SELECT p.id, r.id, 'fleet', p.id
FROM auth_principals p, auth_roles r
WHERE p.id = uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin')
  AND r.name = 'admin'
ON CONFLICT DO NOTHING;
```

**Rollback:** delete only the deterministic seed rows:
```sql
DELETE FROM auth_principal_roles
WHERE principal_id = uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin');
DELETE FROM auth_credentials
WHERE id = uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin-credential');
DELETE FROM auth_principals
WHERE id = uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'bootstrap-admin');
```

### Cutover sequence

1. **Observe-only** (`state = 'observed'`): existing direct-write path
   performs GitHub mutations. The admission path creates commands and
   shadow-validates (compares predicted vs. actual requests) but does
   NOT execute a second mutation.

2. **Enforce** (`state = 'enforce'`): new mutations go through
   admission + executor. Legacy path blocked.

3. **Executor-only** (`state = 'executor_only'`): GitHub write
   credentials revoked from application.

4. **Legacy removed** (`state = 'legacy_removed'`): direct-write code
   removed.

---

## 13. Least-privilege roles

### Application role (`gitwire_app`)

| Privilege | Scope |
|---|---|
| `SELECT, INSERT` + limited `UPDATE` | `auth_principals` (status, auth_epoch, updated_at) |
| `SELECT, INSERT` + limited `UPDATE` | `auth_credentials` (revocation fields) |
| `SELECT, INSERT` + limited `UPDATE` + `DELETE` | `auth_sessions` (revoked_at; DELETE for cleanup) |
| `SELECT` | `auth_roles` |
| `SELECT, INSERT` | `auth_role_permissions` |
| `SELECT, INSERT` + limited `UPDATE` | `auth_principal_roles` (revoked_at) |
| `SELECT, INSERT` | `mutation_commands` (INSERT only — no UPDATE; lifecycle via function) |
| `SELECT, INSERT` | `mutation_events` (admission events only — enforced by trigger) |
| `SELECT` | `execution_receipts` (no INSERT — executor only) |
| `SELECT` | `auth_enforcement_state` (no UPDATE — operator only) |
| `EXECUTE` | `transition_command_lifecycle()` |

### Executor role (`gitwire_executor`)

| Privilege | Scope |
|---|---|
| `SELECT` | `mutation_commands` |
| `SELECT, INSERT` | `mutation_events` (execution events only — enforced by trigger) |
| `SELECT, INSERT` | `execution_receipts` |
| `EXECUTE` | `transition_command_lifecycle()` |

### Operator role (`gitwire_operator`)

| Privilege | Scope |
|---|---|
| `SELECT` | All `gitwire_auth` tables (listed individually in §12 stage 039) |
| `UPDATE (state, updated_at, updated_by, evidence)` | `auth_enforcement_state` only |

### Function-owner role (`gitwire_auth_fn_owner`)

| Privilege | Scope |
|---|---|
| `NOLOGIN` | Cannot be logged into |
| `UPDATE (lifecycle_state, lifecycle_version, transitioned_at)` | `mutation_commands` |
| `SELECT` | `mutation_commands` |

---

## 14. Level 2/3 extension seams

Every Level 1 command carries an `extension` JSONB column. In Level 1,
this field is **immutable after creation** — it is write-once at
admission time. This prevents post-creation mutation of evidence.

```text
extension: {
  -- Level 2 (optional)
  approval: { ... },
  capability_jti: "...",
  step_up_assurance: "...",
  -- Level 3 (optional)
  command_signature: "...",
  external_attestation: { ... },
  external_audit_receipt: "..."
}
```

### Compatibility rule

> Stronger profiles may enrich a Level 1 command at the admission
> boundary (populating `extension` before the command is created), and
> may require evidence before admitting a command. They must not change
> the original record's identity, operation, target, payload meaning,
> or initiating attribution after creation.

A Level 2/3 deployment MAY require evidence (populated `extension`)
before admitting a command. A Level 1 command created without
extension data remains valid in Level 1 execution but may be rejected
by a stricter deployment's admission path.

### What Level 1 does NOT implement

- No capability JTI protocol (Level 2).
- No command-signing implementation (Level 3).
- No external attestation workflow (Level 3).
- No multi-party approval machinery (Level 2/3).
- No per-worker database login (Level 2).
- No speculative archival functions.
- No specialized delegation-denial/reconciliation/retirement subsystems.

---

## 15. Test matrix

### Security-negative tests

| Test | Expected result |
|------|----------------|
| Request with forged principal header | `no_authenticated_principal` — header ignored, principal derived from credential |
| Request with valid credential but wrong repo scope | `resource_not_found` — command not created |
| Request with expired credential | `expired` — authentication fails before authorization |
| Direct GitHub write attempt by worker (enforce mode) | Blocked — no effective write credentials outside executor |
| Command with mismatched payload hash | Executor rejects — `payload_hash != sha256(payload_canonical)` |
| Command replay with different target | `idempotency_conflict` — unique constraint on `(installation_id, repo_id, operation, idempotency_key)` |
| Worker INSERT on execution_receipts | `INSERT privilege denied` — only executor has INSERT |
| Worker INSERT execution event as gitwire_app | `executor events can only be inserted by gitwire_executor` — trigger rejects |
| Application UPDATE lifecycle_state directly | `permission denied` — no UPDATE privilege; must use CAS function |
| UPDATE command provenance field | `mutation_command provenance fields are immutable` — trigger rejects |
| Transition completed → pending | `Illegal lifecycle transition` — trigger rejects |
| Transition pending → completed (state skip) | `Illegal lifecycle transition` — trigger rejects |

### Retry and duplicate-delivery tests

| Test | Expected result |
|------|----------------|
| BullMQ retry of same job | Same idempotency key → existing command found → no re-execution |
| Webhook redelivery | Same idempotency key → existing command → no re-execution |
| Executor timeout then recovery | Reconciliation event; no duplicate GitHub mutation |

### Race condition tests

| Test | Expected result |
|------|----------------|
| Concurrent command creation same idempotency key | One succeeds, one fails with unique violation |
| Concurrent lifecycle transition (CAS) | One succeeds (`affected = 1`), one fails (`affected = 0`) |
| Credential revocation during active request | `auth_epoch` mismatch detected |

### Lifecycle tests

| Test | Expected result |
|------|----------------|
| pending → submitted → executing → completed | All transitions succeed; events recorded |
| Lifecycle transition with wrong expected_version | CAS fails — `affected = 0` |
| Observe-mode shadow validation | Command created; no duplicate GitHub mutation |

---

## 16. Retention

Level 1 retains append-only records **indefinitely**. The append-only
triggers on `mutation_events` and `execution_receipts` reject all
DELETE operations unconditionally — there is no owner exemption or
cleanup function.

| Record type | Retention | Rationale |
|---|---|---|
| `mutation_commands` | Indefinite | Audit trail; provenance reference |
| `mutation_events` | Indefinite | Append-only; triggers reject DELETE |
| `execution_receipts` | Indefinite | Append-only; triggers reject DELETE |
| `auth_sessions` | 30 days after expiry/revocation | Scheduled job: `DELETE WHERE expires_at < now() - interval '30 days'` (sessions are not append-only) |
| `auth_principals` | Indefinite | Never deleted (soft-disable) |
| `auth_credentials` | Indefinite | Never deleted (soft-revoke) |

If a future deployment requires bounded retention for events/receipts,
Level 2 may define a privileged cleanup path with an owner exemption
in the append-only triggers. Level 1 does not implement this.

---

## Cross-document references

- **W0-A inventory** (`current-state-inventory.md`): documents the
  existing authority surfaces that Level 1 addresses.
- **W0-B permission model** (`permission-model.md`): defines the
  principal/resource/action/permission model, evaluation algebra, and
  57-resource registry that Level 1 implements.
- **AGENTS.md**: defines the Octokit usage constraints, database
  conventions, and code patterns.

---

*End of Level 1 authority core specification. Documentation-only.
No executable migrations. No database execution. No runtime changes.
W0-D remains blocked until explicit acceptance.*
