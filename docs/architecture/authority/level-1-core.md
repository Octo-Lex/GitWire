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
| Cross-repository mutation (acting on repo B with repo A's authority) | Repository-scoped authorization; every command binds exact org/repo/resource |
| Concurrent duplicate execution (retries, redeliveries) | Idempotency keys; CAS lifecycle transitions |
| Unauthorized GitHub writes (scattered octokit calls) | Central executor is the sole write boundary; all other paths are read-only |
| Audit gaps (missing or forgeable attribution) | Append-only command/event trail; provenance recorded at command creation, not deferred |
| Self-authority hijack (GitWire modifies its own security controls) | GitHub branch protection + required review; GitWire may propose but never autonomously merge |
| Stale authority (revoked credential still effective) | `auth_epoch` invalidation; credential revocation is immediate |

### Trust boundaries

```
[HTTP Client] → [Application Gateway] → [PostgreSQL] → [Workers]
                        ↓                      ↓
                  [Authorization]         [Command Store]
                        ↓                      ↓
                  [Command Creator]      [Central Executor] → [GitHub API]
```

- **Client → Application:** untrusted. Client provides credentials; the
  application authenticates and derives the principal. Client headers
  are never authoritative.
- **Application → PostgreSQL:** trusted for identity derivation and
  authorization evaluation. The application runs under a shared
  database role (`gitwire_app`).
- **PostgreSQL:** trusted for data invariants (FK, CHECK, immutability,
  CAS). NOT trusted to authenticate individual workers behind the
  shared connection.
- **Application/Workers → Executor:** trusted command queue. Commands
  are immutable once created.
- **Executor → GitHub:** sole write boundary. Only the executor holds
  effective GitHub write credentials.

### Non-goals (Level 1)

- No database-level worker authentication (workers share the
  application DB role).
- No execution-attempt UUIDs treated as identity proof (they are
  concurrency tokens only).
- No delegation-claim authentication protocol (Level 2 concern).
- No cryptographic command signing (Level 3 concern).
- No external attestation implementation (Level 3 concern).
- No speculative archival subsystems (standard retention only).
- No enterprise multi-party approval machinery (Level 2/3 concern).

---

## 3. Server-owned identities

### Human principals

Every authenticated user resolves to a server-owned principal record.
The application authenticates the user (GitHub OAuth, bootstrap admin,
or session) and derives the principal from the authenticated
credential — never from a client-supplied header or UUID.

```text
auth_principals
  id              UUID PRIMARY KEY
  principal_type  text NOT NULL      -- 'user' | 'service'
  display_name    text NOT NULL
  status          text NOT NULL DEFAULT 'active'  -- 'active' | 'disabled'
  auth_epoch      bigint NOT NULL DEFAULT 0
  created_at      timestamptz NOT NULL DEFAULT now()
  updated_at      timestamptz NOT NULL DEFAULT now()
```

The `auth_epoch` column increments on credential revocation, role
revocation, or admin-forced session invalidation. Sessions compare
their epoch against the principal's current epoch on every request.

### Service principals

Service identities represent internal GitWire components (workers,
executor, bot). They authenticate via scoped API credentials and are
resolved server-side. A service principal does NOT carry GitHub
identity. Workers share the application database role — the database
does not authenticate individual workers.

### Credential resolution

The application resolves credentials as follows:

1. **API key:** `Authorization: Bearer <key>` → lookup by credential
   ID → HMAC-verify the secret → resolve to a principal.
2. **Session:** session token → Redis lookup → resolve to a principal.
3. **GitHub OAuth:** OAuth code → GitHub token exchange → resolve to
   a user principal via `github_user_id`.

In all cases, the **principal ID is derived from the authenticated
credential, not from the request**. The request context carries the
resolved principal; it does not accept a client-supplied principal.

---

## 4. Trusted request context

Every authorized request produces a **trusted request context** that
the application derives before evaluating authorization or creating
commands:

```text
RequestContext {
  principal: {
    id:              UUID     -- server-derived from authenticated credential
    type:            'user' | 'service'
    auth_epoch:      bigint   -- principal's current epoch (for session validity)
  }
  requesting_service: {
    id:              UUID     -- the service component making the request
    name:            text     -- e.g., 'gitwire-app', 'executor-service'
  }
  authentication_method: text -- 'api_key' | 'session' | 'github_oauth' | 'webhook_hmac'
  target: {
    organization:    text     -- from route params
    repository:      text     -- from route params
    resource_type:   text     -- from route definition
    resource_id:     text     -- from route params or body
  }
}
```

Neither the `principal.id` nor the `requesting_service.id` is
client-supplied. The application derives them from the authenticated
session/credential and the internal service registry. A request that
fails authentication produces no request context — it is rejected
before authorization evaluation.

---

## 5. Repository-scoped authorization

The application evaluates authorization before creating any mutation
command:

```js
authorize({
  principal,          // from RequestContext
  requestingService,  // from RequestContext
  operation,          // the operation being requested (e.g., 'heal_ci', 'merge_pr')
  resource,           // { organization, repository, resource_type, resource_id }
});
```

### Evaluation model

Authorization is an **application-layer** evaluation. It is NOT
deferred to PostgreSQL. The application:

1. Loads the principal's active roles and permissions.
2. Checks whether the principal has the required permission for the
   operation on the target resource.
3. Checks explicit deny rules.
4. Produces an **authorization result** (allow/deny + reason + policy
   version + evaluated-input snapshot).

The authorization result is recorded as part of the mutation command's
provenance (§6). The database does not re-run the authorization engine.

### Level 1 permission model

Level 1 uses a simple, practical permission model derived from the
accepted W0-B model:

- **Roles** are named permission sets (e.g., `admin`, `operator`,
  `viewer`, `service:heal-worker`).
- **Permissions** are `<resource_type>:<action>` tokens using the
  W0-B 57-resource registry.
- **Scope** is repository-scoped: a principal authorized on repository
  X cannot act on repository Y.
- **Read/list** are independent exact permissions (W0-B §4).
- **Default deny.** Every request is denied unless an explicit allow
  matches.

The full role/permission/scope model is defined in the accepted W0-B
permission model (`permission-model.md`). Level 1 implements it at the
application layer without requiring database-enforced RBAC tables.

---

## 6. Immutable mutation commands

Every GitHub mutation originates as an **immutable mutation command**.
Once created, the command's identity, operation, target, payload, and
attribution cannot change. Only lifecycle state transitions.

### Minimum durable provenance

Every Level 1 command durably carries:

```text
MutationCommand {
  id:                    UUID PRIMARY KEY
  -- Identity and attribution
  initiating_principal:  UUID NOT NULL    -- server-derived
  requesting_service:    UUID NOT NULL    -- server-derived
  authentication_method: text NOT NULL    -- 'api_key' | 'session' | etc.
  -- Target
  target_organization:   text NOT NULL
  target_repository:     text NOT NULL
  target_resource_type:  text NOT NULL
  target_resource_id:    text
  -- Operation
  operation:             text NOT NULL    -- exact operation (e.g., 'heal_ci')
  payload_hash:          text NOT NULL    -- sha256 of canonical payload
  -- Authorization evidence
  auth_result_snapshot:  jsonb NOT NULL   -- sufficient to explain admission
  auth_policy_version:   text NOT NULL    -- policy version evaluated
  assurance_profile:     text NOT NULL DEFAULT 'level1'
  -- Concurrency
  idempotency_key:       text NOT NULL    -- unique per logical operation
  lifecycle_version:     bigint NOT NULL DEFAULT 0
  lifecycle_state:       text NOT NULL DEFAULT 'pending'
  -- Extension seam (nullable, Level 2/3 additive)
  extension:             jsonb            -- approval, JTI, signature, attestation
  -- Timestamps
  created_at:            timestamptz NOT NULL DEFAULT now()
  transitioned_at:       timestamptz
}
```

The `auth_result_snapshot` is a JSONB snapshot of the authorization
evaluation result — sufficient to explain why the command was admitted
without requiring a re-run of the authorization engine. It includes
the evaluated roles, permissions, scope, and policy version.

### Immutability

The following fields are immutable after INSERT:
`initiating_principal`, `requesting_service`, `authentication_method`,
`target_organization`, `target_repository`, `target_resource_type`,
`target_resource_id`, `operation`, `payload_hash`, `auth_result_snapshot`,
`auth_policy_version`, `idempotency_key`, `created_at`.

Only `lifecycle_state`, `lifecycle_version`, `transitioned_at`, and
`extension` may change after creation. A BEFORE UPDATE trigger enforces
field-level immutability.

### Lifecycle states

```text
pending → submitted → executing → completed
                                  ↘ failed
                       cancelled
```

- `pending`: command created, not yet submitted to executor.
- `submitted`: command queued for executor.
- `executing`: executor is processing the command.
- `completed`: executor succeeded; receipt recorded.
- `failed`: executor failed; error recorded.
- `cancelled`: command withdrawn before execution.

Lifecycle transitions use CAS on `lifecycle_version` to prevent race
conditions. Each transition increments the version atomically.

---

## 7. Append-only mutation events and receipts

Every command execution produces append-only events:

```text
MutationEvent {
  id:              UUID PRIMARY KEY
  command_id:      UUID NOT NULL REFERENCES mutation_commands(id)
  event_type:      text NOT NULL    -- 'submitted', 'started', 'succeeded', 'failed', 'cancelled'
  event_data:      jsonb            -- result details, error info, receipt reference
  occurred_at:     timestamptz NOT NULL DEFAULT now()
}
```

Events are append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers
prevent modification. The application has INSERT and SELECT only.

### GitHub receipts

When the executor performs a GitHub mutation, it records the GitHub
API response as a receipt:

```text
ExecutionReceipt {
  id:              UUID PRIMARY KEY
  command_id:      UUID NOT NULL REFERENCES mutation_commands(id)
  github_endpoint: text NOT NULL    -- e.g., 'PUT /repos/{owner}/{repo}/branches/{branch}/protection'
  github_status:   integer          -- HTTP status code
  github_response: jsonb            -- response body (truncated if large)
  github_oid:      text             -- GitHub object ID (if applicable)
  executed_at:     timestamptz NOT NULL DEFAULT now()
}
```

Receipts are append-only. They provide durable evidence of what GitHub
actually received and returned.

---

## 8. Central GitHub mutation executor

### Contract

The central executor is the **sole component** that may obtain
effective GitHub write credentials. It:

1. Accepts only supported immutable command types (from the command
   queue).
2. Verifies repository and installation binding (command target
   matches executor's installation context).
3. Verifies operation and payload-hash binding (command payload matches
   what the executor will send to GitHub).
4. Executes idempotently (re-delivery of the same command does not
   produce duplicate side effects).
5. Records each attempt as a mutation event.
6. Persists the GitHub receipt.
7. Reconciles uncertain completion (timeout, network error → poll
   GitHub for actual state).

### Executor boundary

```
[Command Queue] → [Executor] → [GitHub API]
                      ↓
                 [Event + Receipt]
```

The executor reads commands from the queue, translates them to GitHub
API calls, and records events/receipts. It does not evaluate
authorization (that happened at command creation time). It does not
modify command provenance fields.

### Idempotency

Each command carries an `idempotency_key` that is unique per logical
operation. If the same command is re-delivered (BullMQ retry, webhook
re-delivery), the executor detects the existing command by idempotency
key and does not re-execute. A unique constraint on
`(target_repository, idempotency_key)` enforces this at the database
level.

---

## 9. Prohibited direct-write paths

**Ordinary routes, workers, schedulers, Telegram handlers, maintenance
tasks, and repair components must not call GitHub mutation APIs
directly.**

In the current codebase, many components call `octokit.request()` for
mutations (branch protection, PR merge, label creation, etc.). Level 1
requires all such paths to route through the central executor.

### Migration of existing direct-write paths

The cutover plan (§12) defines how existing direct-write paths are
identified and migrated:

1. **Observe-only**: the executor runs alongside existing paths. Both
   produce the same mutations; the executor's events are logged but do
   not replace existing behavior.
2. **Enforce**: new mutations must go through the executor. Direct-write
   paths are blocked (credential revocation or code-level gating).
3. **Legacy removal**: direct-write code paths are removed.

### What is NOT a direct write

- GitHub **read** APIs (fetching PRs, listing commits, checking CI
  status) are not mutations and do not need to go through the executor.
- The executor itself calling GitHub APIs is the intended write path.
- Workers that create commands (for the executor to execute) are not
  performing direct writes — they are creating commands.

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

- **Protected branches**: `master` (or main) requires pull request
  review before merge.
- **Required checks**: CI must pass before merge.
- **CODEOWNERS**: authority-sensitive files require review by
  designated owners.
- **Required human review**: at least one human approval for changes to
  authority-sensitive files.
- **Protected deployment environments**: production deployment requires
  manual approval.

### GitWire may not autonomously

- Merge pull requests affecting its own authority-sensitive files.
- Deploy changes to production without human approval.
- Modify branch protection rules, CODEOWNERS, or CI workflows
  autonomously.
- Rotate or modify its own GitHub App credentials.

GitWire **may** prepare branches, commits, proposals, and pull
requests affecting its own controls. It may not merge or deploy them.

---

## 11. Minimal additive schema

Level 1 adds a **small** set of tables to the existing schema. All
tables are additive — no existing tables are modified destructively.

### Schema overview

```sql
-- Extensions (required before any Level 1 table)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ==========================================
-- Level 1 authority schema: gitwire_auth
-- ==========================================
CREATE SCHEMA IF NOT EXISTS gitwire_auth;
REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC;
```

### Table: `gitwire_auth.auth_principals`

```sql
CREATE TABLE gitwire_auth.auth_principals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  text        NOT NULL CHECK (principal_type IN ('user', 'service')),
  display_name    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  auth_epoch      bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
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

CREATE UNIQUE INDEX ux_auth_credentials_lookup
  ON gitwire_auth.auth_credentials (lookup_id);
CREATE INDEX ix_auth_credentials_principal
  ON gitwire_auth.auth_credentials (principal_id)
  WHERE revoked_at IS NULL;
```

### Table: `gitwire_auth.mutation_commands`

```sql
CREATE TABLE gitwire_auth.mutation_commands (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identity and attribution (immutable)
  initiating_principal  uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  requesting_service    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  authentication_method text        NOT NULL CHECK (authentication_method IN
                                    ('api_key', 'session', 'github_oauth', 'webhook_hmac')),
  -- Target (immutable)
  target_organization   text        NOT NULL,
  target_repository     text        NOT NULL,
  target_resource_type  text        NOT NULL,
  target_resource_id    text,
  -- Operation (immutable)
  operation             text        NOT NULL,
  payload_hash          text        NOT NULL,
  -- Authorization evidence (immutable)
  auth_result_snapshot  jsonb       NOT NULL,
  auth_policy_version   text        NOT NULL,
  assurance_profile     text        NOT NULL DEFAULT 'level1',
  -- Concurrency
  idempotency_key       text        NOT NULL,
  lifecycle_version     bigint      NOT NULL DEFAULT 0,
  lifecycle_state       text        NOT NULL DEFAULT 'pending'
                                    CHECK (lifecycle_state IN
                                    ('pending', 'submitted', 'executing', 'completed', 'failed', 'cancelled')),
  -- Extension seam (nullable, Level 2/3 additive)
  extension             jsonb,
  -- Timestamps
  created_at            timestamptz NOT NULL DEFAULT now(),
  transitioned_at       timestamptz,

  -- Idempotency: one command per repo per logical operation
  CONSTRAINT ux_mutation_commands_idempotency
    UNIQUE (target_repository, idempotency_key)
);
```

### Table: `gitwire_auth.mutation_events`

```sql
CREATE TABLE gitwire_auth.mutation_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid        NOT NULL REFERENCES gitwire_auth.mutation_commands(id),
  event_type      text        NOT NULL CHECK (event_type IN
                    ('submitted', 'started', 'succeeded', 'failed', 'cancelled', 'reconciled')),
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

### Append-only and immutability triggers

```sql
-- Mutation events are append-only
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

-- Execution receipts are append-only
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

-- Mutation command provenance fields are immutable (only lifecycle fields may change)
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_command_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW.initiating_principal != OLD.initiating_principal
     OR NEW.requesting_service != OLD.requesting_service
     OR NEW.authentication_method != OLD.authentication_method
     OR NEW.target_organization != OLD.target_organization
     OR NEW.target_repository != OLD.target_repository
     OR NEW.target_resource_type != OLD.target_resource_type
     OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
     OR NEW.operation != OLD.operation
     OR NEW.payload_hash != OLD.payload_hash
     OR NEW.auth_result_snapshot != OLD.auth_result_snapshot
     OR NEW.auth_policy_version != OLD.auth_policy_version
     OR NEW.idempotency_key != OLD.idempotency_key
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

### Table: `gitwire_auth.auth_enforcement_state`

Single-row state table controlling the cutover sequence (§12).

```sql
CREATE TABLE gitwire_auth.auth_enforcement_state (
  id          integer PRIMARY KEY DEFAULT 1,
  state       text NOT NULL DEFAULT 'observed'
              CHECK (state IN ('observed', 'enforce', 'executor_only', 'legacy_removed')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_single_row CHECK (id = 1)
);

INSERT INTO gitwire_auth.auth_enforcement_state (id, state) VALUES (1, 'observed')
  ON CONFLICT (id) DO NOTHING;
```

---

## 12. Migration, cutover, and rollback order

### Migration files

```
038_level1_schema.sql          — schema, tables, triggers, indexes
039_level1_roles.sql           — least-privilege role grants
040_level1_seed.sql            — bootstrap admin principal + credential
```

### Stage 038: Schema creation

Creates the `gitwire_auth` schema, all Level 1 tables, triggers, and
indexes. Each migration file opens with `SET search_path = gitwire_auth, public;`
to ensure unqualified objects resolve correctly.

**Object creation order:**
1. `CREATE SCHEMA gitwire_auth`
2. `CREATE TABLE auth_principals`
3. `CREATE TABLE auth_credentials`
4. `CREATE TABLE auth_sessions`
5. `CREATE TABLE mutation_commands`
6. `CREATE TABLE mutation_events`
7. `CREATE TABLE execution_receipts`
8. `CREATE TRIGGER` (append-only + immutability)
9. `CREATE INDEX` (all indexes)

**Rollback (reverse order):**
1. `DROP INDEX` (all indexes)
2. `DROP TRIGGER` (all triggers)
3. `DROP FUNCTION` (enforce_events_append_only, enforce_receipts_append_only, enforce_command_immutability)
4. `DROP TABLE execution_receipts`
5. `DROP TABLE mutation_events`
6. `DROP TABLE mutation_commands`
7. `DROP TABLE auth_sessions`
8. `DROP TABLE auth_credentials`
9. `DROP TABLE auth_principals`
10. `DROP SCHEMA gitwire_auth`

### Stage 039: Least-privilege roles

Creates the four roles and grants privileges. See §13.

**Rollback:** `REVOKE` all grants, `DROP ROLE` for migration role only
(application and operator roles may be shared).

### Stage 040: Bootstrap seed

Creates the initial admin principal and credential. This is the only
seed data — all other principals are created at runtime by the
application.

**Rollback:** `DELETE FROM auth_credentials; DELETE FROM auth_principals;`

### Cutover sequence

1. **Observe-only** (default after migration): the executor runs
   alongside existing direct-write paths. Both produce the same GitHub
   mutations. The executor's events/receipts are logged but do not
   replace existing behavior. This stage surfaces any discrepancies
   without disrupting production.

2. **Enforce**: new mutations must go through the executor. Existing
   direct-write paths are gated (the application checks whether a
   mutation command exists before allowing a direct write). This is a
   flag flip, not a schema change.

3. **Direct-writer shutdown**: the executor is the sole write path.
   Direct-write code is disabled. GitHub write credentials are revoked
   from the application and granted only to the executor.

4. **Legacy removal**: direct-write code is removed from the codebase.

The application reads `auth_enforcement_state` (defined in §11) to
determine whether to enforce command-based mutations or allow legacy
direct writes. Transition is human-controlled (operator SQL UPDATE with
evidence), not automated.

---

## 13. Least-privilege roles

### Application role (`gitwire_app`)

```sql
-- Principals and credentials
GRANT SELECT, INSERT ON gitwire_auth.auth_principals TO gitwire_app;
GRANT UPDATE (status, auth_epoch, updated_at) ON gitwire_auth.auth_principals TO gitwire_app;

GRANT SELECT, INSERT ON gitwire_auth.auth_credentials TO gitwire_app;
GRANT UPDATE (revoked_at, revoked_by, updated_at) ON gitwire_auth.auth_credentials TO gitwire_app;

-- Sessions
GRANT SELECT, INSERT ON gitwire_auth.auth_sessions TO gitwire_app;
GRANT UPDATE (revoked_at) ON gitwire_auth.auth_sessions TO gitwire_app;
GRANT DELETE ON gitwire_auth.auth_sessions TO gitwire_app;

-- Mutation commands: INSERT + SELECT + limited UPDATE (lifecycle only)
GRANT SELECT, INSERT ON gitwire_auth.mutation_commands TO gitwire_app;
GRANT UPDATE (lifecycle_state, lifecycle_version, transitioned_at, extension)
  ON gitwire_auth.mutation_commands TO gitwire_app;

-- Mutation events: INSERT + SELECT only (append-only)
GRANT SELECT, INSERT ON gitwire_auth.mutation_events TO gitwire_app;

-- Execution receipts: INSERT + SELECT only (append-only)
GRANT SELECT, INSERT ON gitwire_auth.execution_receipts TO gitwire_app;

-- Enforcement state: SELECT only (transition is operator-controlled)
GRANT SELECT ON gitwire_auth.auth_enforcement_state TO gitwire_app;
```

### Executor role (`gitwire_executor`)

The executor needs to read commands and write events/receipts. It does
NOT need principal or credential access:

```sql
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_executor;
GRANT UPDATE (lifecycle_state, lifecycle_version, transitioned_at)
  ON gitwire_auth.mutation_commands TO gitwire_executor;
GRANT SELECT, INSERT ON gitwire_auth.mutation_events TO gitwire_executor;
GRANT SELECT, INSERT ON gitwire_auth.execution_receipts TO gitwire_executor;
```

### Migration role (`gitwire_migration`)

Runs DDL only:

```sql
GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_migration;
-- Granted during migration execution, revoked after.
```

### Operator role (`gitwire_operator`)

Human-controlled operations (enforcement state transition, inspection):

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA gitwire_auth TO gitwire_operator;
GRANT UPDATE (state, updated_at) ON gitwire_auth.auth_enforcement_state TO gitwire_operator;
```

The operator can transition the enforcement state but cannot modify
commands, events, receipts, principals, or credentials.

---

## 14. Level 2/3 extension seams

Every Level 1 record is forward-compatible with additive Level 2/3
evidence. The `extension` JSONB column on `mutation_commands` is the
primary seam:

```text
extension: {
  -- Level 2 (optional, per-service DB identity + capability)
  approval: { ... },           -- multi-party approval evidence
  capability_jti: "...",       -- job-authorization capability token ID
  step_up_assurance: "...",    -- step-up authentication evidence

  -- Level 3 (optional, cryptographic + external)
  command_signature: "...",    -- Ed25519 signature of the command
  external_attestation: { ... }, -- external authority evidence
  external_audit_receipt: "..." -- external audit ledger reference
}
```

### Compatibility rule

> Stronger profiles may enrich and validate a Level 1 record, but must
> not change the original record's identity, operation, target, payload
> meaning, or initiating attribution.

This means:
- The `extension` field may be populated after command creation but
  cannot alter the immutable provenance fields.
- A Level 2/3 deployment can ADD validation triggers that check the
  `extension` field, but Level 1 does not require or check it.
- Level 1 records created without extension data remain valid and
  executable in Level 2/3 deployments (the extension is additive).

### What Level 1 does NOT implement

- No capability JTI protocol (Level 2).
- No command-signing implementation (Level 3).
- No external attestation workflow (Level 3).
- No multi-party approval machinery (Level 2/3).
- No per-worker database login (Level 2).
- No speculative archival functions (standard retention only).
- No specialized delegation-denial/reconciliation/retirement subsystems.

These are documented as integration patterns for deployments that need
them, not as core Level 1 dependencies.

---

## 15. Test matrix

### Security-negative tests

| Test | Expected result |
|------|----------------|
| Request with forged principal header | `no_authenticated_principal` — header ignored, principal derived from credential |
| Request with valid credential but wrong repo scope | `resource_not_found` — command not created |
| Request with expired credential | `expired` — authentication fails before authorization |
| Request with revoked credential | `disabled` or `expired` — auth_epoch mismatch detected |
| Direct GitHub write attempt by worker (enforce mode) | Blocked — no effective write credentials outside executor |
| Command with mismatched payload hash | `payload_mismatch` — executor rejects |
| Command replay with different target | `idempotency_conflict` — unique constraint on `(target_repository, idempotency_key)` |

### Retry and duplicate-delivery tests

| Test | Expected result |
|------|----------------|
| BullMQ retry of same job | Same idempotency key → existing command found → no re-execution |
| Webhook redelivery of same event | Same idempotency key → existing command found → no re-execution |
| Executor timeout then recovery | Reconciliation event recorded; no duplicate GitHub mutation |

### Race condition tests

| Test | Expected result |
|------|----------------|
| Concurrent command creation with same idempotency key | One succeeds, one fails with unique violation |
| Concurrent lifecycle transition (two workers finalize same command) | CAS on `lifecycle_version` — one succeeds, one fails |
| Credential revocation during active request | `auth_epoch` mismatch detected at next checkpoint |

### Lifecycle tests

| Test | Expected result |
|------|----------------|
| Command transitions pending → submitted → executing → completed | All transitions succeed; events recorded |
| Command transition from completed to pending | Rejected by lifecycle_state CHECK |
| Command transition with wrong lifecycle_version | CAS fails — `affected_rows = 0` |

---

## Cross-document references

- **W0-A inventory** (`current-state-inventory.md`): documents the
  existing authority surfaces that Level 1 addresses.
- **W0-B permission model** (`permission-model.md`): defines the
  principal/resource/action/permission model, evaluation algebra, and
  57-resource registry that Level 1 implements at the application layer.
- **AGENTS.md**: defines the Octokit usage constraints, database
  conventions, and code patterns that the Level 1 implementation must
  follow.

---

## Retention

Level 1 uses standard retention — no specialized archival functions.

| Record type | Retention | Cleanup mechanism |
|---|---|---|
| `mutation_commands` | Indefinite | Never deleted (audit trail) |
| `mutation_events` | 365 days | Scheduled job: `DELETE WHERE occurred_at < now() - interval '365 days'` |
| `execution_receipts` | 365 days | Scheduled job: `DELETE WHERE executed_at < now() - interval '365 days'` |
| `auth_sessions` | 30 days after expiry/revocation | Scheduled job: `DELETE WHERE expires_at < now() - interval '30 days'` |
| `auth_principals` | Indefinite | Never deleted (soft-disable only) |
| `auth_credentials` | Indefinite | Never deleted (soft-revoke only) |

Events and receipts can be safely deleted after 365 days because their
parent commands retain the `auth_result_snapshot` (immutable provenance).
The FK from events/receipts to commands uses `ON DELETE NO ACTION` —
but since commands are never deleted, this never fires.

---

*End of Level 1 authority core specification. Documentation-only.
No executable migrations. No database execution. No runtime changes.
W0-D remains blocked until explicit acceptance.*
