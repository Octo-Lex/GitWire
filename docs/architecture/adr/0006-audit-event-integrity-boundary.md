# ADR 0006: Audit/event integrity boundary

> **Scope marker.** Records the append-only command/event/receipt
> trail, the partitioned INSERT authority that protects it, the
> immutability of command provenance, and the Level 1 closure of F-06.
> Part of the Level 1 authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §6, §7, §16.
**This ADR supersedes `permission-model.md §14` and the F-06 row of
`permission-model.md §15` as the Level 1 closure for F-06.** The
supersession is narrow; see Decision.

## Context

The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records three integrity defects in today's audit surface: audit
attribution is forgeable through client-supplied headers (F-03, HIGH),
the audit hash chain has a race-fork window (F-11, MEDIUM), and
`audit_exports` records a file path/hash without writing the file
(F-12, MEDIUM). Separately, the worker execution path trusts the job
payload (F-06, HIGH): a forged payload can drive a worker to mutate
outside its intended scope.

Level 1 must make the command/event/receipt trail tamper-evident,
attribute every event to a server-derived principal, and close F-06
without deferring worker-execution integrity to a stronger deployment
profile.

A contradiction exists between the two accepted source documents on
*how* F-06 is closed at Level 1:

- [`../authority/permission-model.md`](../authority/permission-model.md) §14
  specifies a signed capability token with one-time JTI consumption as
  the proposed closure, and §15's F-06 row characterizes it as the
  model's mechanism.
- [`../authority/level-1-core.md`](../authority/level-1-core.md) §14
  ("What Level 1 does NOT implement", :1457) states unambiguously:
  "No capability JTI protocol (Level 2)."

Both documents shipped in PR #82. They cannot both be authoritative for
the Level 1 mechanism. This ADR resolves the contradiction.

## Decision

### Append-only command/event/receipt trail

Three tables form the trail (level-1-core.md §7, :372-427):

- **`mutation_commands`** — the admitted command with full provenance.
- **`mutation_events`** — lifecycle events
  (`admitted`, `submitted`, `started`, `succeeded`, `failed`,
  `cancelled`, `reconciled` — level-1-core.md:733-734) carrying
  `actor_principal` and `event_source`
  (`'admission' | 'executor' | 'reconciler'` — level-1-core.md:381-383).
- **`execution_receipts`** — the GitHub response evidence.

### Partitioned INSERT authority

INSERT authority is partitioned by `event_source`
(level-1-core.md §7, :389-408), enforced by the
`enforce_event_source_partition()` BEFORE INSERT trigger checking
`current_user` (level-1-core.md:936-969):

- Admission events (`admitted`, `submitted`, `cancelled`): only
  `gitwire_admission` may INSERT.
- Execution events (`started`, `succeeded`, `failed`, `reconciled`):
  only `gitwire_executor` may INSERT.

The application has SELECT on `execution_receipts` but **no INSERT**;
only `gitwire_executor` has INSERT (level-1-core.md:409-427). This
prevents the application from forging GitHub response evidence.

### Append-only and immutability triggers

- `enforce_events_append_only()` and `enforce_receipts_append_only()`
  raise on any UPDATE or DELETE — **no owner exemption**
  (level-1-core.md:1107-1137, 1514-1517).
- `enforce_command_immutability()` (level-1-core.md:885-934) makes
  every command field immutable after INSERT except `lifecycle_state`,
  `lifecycle_version`, `transitioned_at`. This includes
  `auth_result_snapshot`, `auth_policy_version`, and the `extension`
  JSONB column (level-1-core.md:906, 1425-1427).

### Retention

Level 1 retains append-only records indefinitely; the append-only
triggers reject all DELETE operations unconditionally
(level-1-core.md §16, :1512-1531). `auth_sessions` are retained 30
days after expiry/revocation; `auth_principals` and `auth_credentials`
are soft-disabled, never deleted. If a future deployment requires
bounded retention for events/receipts, Level 2 may define a privileged
cleanup path with an owner exemption; Level 1 does not implement this
(level-1-core.md:1528-1530).

### Audit-defect closures

- **F-03** (audit-attribution forgery): every request carries the
  authenticated `principal_id`; actor fields are derived from
  `req.auth.principalId`, not client headers (permission-model.md
  §15 F-03).
- **F-11** (hash-chain race-fork): synchronized chain computation —
  transactional SELECT-then-INSERT or equivalent
  (permission-model.md §15 F-11).
- **F-12** (`audit_exports` phantom file): design debt tracked
  separately; out of the authority model's scope
  (permission-model.md §15 F-12).

### Level 1 closure of F-06 (capability/JTI supersession)

> **Level 1 closes F-06 without capability tokens or JTI.** Level 1
> relies on server-derived authorization, trusted command admission,
> immutable commands with payload/provenance binding, unique
> idempotency keys, CAS lifecycle transitions, and a sole central
> executor that verifies admitted state. Signed capability tokens, JTI
> replay consumption, and strict token-level at-most-once semantics
> remain optional Level 2 extensions.
>
> `permission-model.md` §§14–15 are superseded for the Level 1
> mechanism but retained as Level 2 design guidance. F-06 is not
> deferred and is not only closed at Level 2.

This is the only reading consistent with the accepted Level 1 product
definition: `level-1-core.md §14` (:1457) explicitly assigns capability
JTI to Level 2, while Level 1 includes trusted command admission
(§5–§6), unique idempotency keys and CAS lifecycle transitions
(§6 :361-369), and a sole central executor that verifies admitted state
before acting (§8 :431-478).

`permission-model.md §14`'s signed-capability-plus-one-time-JTI design
is retained unchanged as Level 2 guidance: a deployment that adopts
Level 2 may enrich commands at the admission boundary via the
`extension.capability_jti` field (level-1-core.md:1433) and require
token-level at-most-once enforcement. Nothing in this ADR removes that
design; it removes only its characterization as the *Level 1* closure.

## Rationale

1. **Partitioned INSERT authority is the integrity spine.** Splitting
   INSERT rights by `event_source` means a compromised application
   role cannot fabricate execution evidence, and a compromised
   executor role cannot fabricate admission records.
2. **No owner exemption.** Allowing `OWNER` to bypass append-only
   triggers would defeat the trail's tamper-evidence for the most
   privileged actor. Level 1 declines the convenience.
3. **Immutability of provenance.** Freezing `auth_result_snapshot`,
   `auth_policy_version`, and `extension` after INSERT means the
   authorizing decision cannot be retroactively edited.
4. **F-06 closed at Level 1, not deferred.** The combination of
   server-derived authorization, immutable command binding,
   idempotency, CAS lifecycle control, and sole-executor verification
   closes the trust-the-payload defect at Level 1. Deferring F-06
   wholly to Level 2 would understate the accepted Level 1 controls;
   claiming capability/JTI as the Level 1 mechanism would contradict
   `level-1-core.md §14`. The supersession above reconciles both.

## Non-goals

- This ADR does not specify the trigger function bodies. The DDL is an
  implementation target owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify the synchronized hash-chain algorithm in
  executable form — F-11's resolution names the approach
  (transactional SELECT-then-INSERT); the executable proof is #81.
- This ADR does not specify F-12's resolution; it is tracked
  separately.
- This ADR does not remove or rewrite `permission-model.md §14`. The
  narrow supersession note is added to that document (see
  `permission-model.md §14` opening blockquote and §15 F-06 row); the
  capability/JTI design text is retained verbatim as Level 2 guidance.

## Acceptance criteria

An implementation conforms to this ADR when:

- `mutation_events` INSERT succeeds only for the role matching
  `event_source`; other roles are rejected by trigger.
- The application role has no INSERT on `execution_receipts`.
- UPDATE and DELETE on `mutation_events` and `execution_receipts`
  raise, with no owner exemption.
- UPDATE of any `mutation_commands` provenance field (including
  `auth_result_snapshot`, `auth_policy_version`, `extension`) raises.
- Every event's `actor_principal` is the authenticated principal, not
  a client-supplied value.
- F-06 is closed by the Level 1 control set above; no capability token
  or JTI table is required for Level 1 conformance.

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §6, §7, §14, §16
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §14 (superseded for Level 1; retained as Level 2), §15 F-03, F-06, F-11, F-12
- Related: [ADR-0002](./0002-principal-resource-action-model.md) and
  [ADR-0003](./0003-evaluation-and-deny-semantics.md) link here for the
  capability/JTI resolution rather than restating it.
- Related: [ADR-0005](./0005-policy-storage-and-versioning.md) (provenance columns),
  [ADR-0007](./0007-migration-and-compatibility-strategy.md) (extension seam and cutover),
  [ADR-0008](./0008-production-security-authority-retained-by-humans.md) (Level 2 JTI operator reconciliation)
