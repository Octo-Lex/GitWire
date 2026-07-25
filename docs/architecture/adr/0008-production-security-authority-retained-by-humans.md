# ADR 0008: Production/security authority retained by humans

> **Scope marker.** Records what GitWire may and may not do to its own
> security controls, who holds break-glass and bootstrap authority,
> and the least-privilege DB role model. Part of the Level 1 authority
> architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §2, §10, §13
and [`../authority/permission-model.md`](../authority/permission-model.md) §11.

## Context

A self-modifying automation system is a confused-deputy risk: if
GitWire can merge changes to its own authority controls, deploy those
changes, or rotate its own credentials, a compromised or misbehaving
run can permanently entrench itself. The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records the relevant threat surface, and the threat model in
`level-1-core.md §2` calls out "Self-authority hijack (GitWire
modifies its own security controls)" explicitly
(level-1-core.md:86). Level 1 must place the authority for
security-sensitive changes outside GitWire's autonomous reach.

## Decision

### Self-management policy

GitWire may prepare branches, commits, proposals, and pull requests.
It may **not** merge or deploy them (level-1-core.md §10, :539-548).

### Authority-sensitive files

The following require designated-owner review and may not be
autonomously merged by GitWire (level-1-core.md:519-528):

- `AGENTS.md`
- `docs/architecture/authority/`
- `.github/workflows/`
- `CODEOWNERS`
- branch protection rules
- deployment environment configurations
- database migration files (post-W0-E)

### Required GitHub controls

(level-1-core.md:529-538)

- **Protected branches**: `master` requires pull request review.
- **Required checks**: CI must pass before merge.
- **CODEOWNERS**: authority-sensitive files require designated-owner
  review.
- **Required human review**: at least one human approval.
- **Protected deployment environments**: production requires manual
  approval.

### Break-glass principal

A dedicated `break_glass` role (permission-model.md §11, :1235-1242)
holds fleet-wide + system permissions. It is activated only through a
separate audited mechanism, has a short absolute expiry (e.g. 30
minutes), tags every action `break_glass`, and triggers an alert to
all active administrators.

### Bootstrap re-enable authority

If all administrators are locked out, bootstrap is re-enabled by direct DB
access: an operator with production DB credentials inserts a row into
`auth_bootstrap_recovery_markers(consumer_secret_hash, pepper_version)`
(permission-model.md §2). The operator's INSERT grant is column-level on only
those two columns; `created_by_db_session` is **not** insertable by the
operator — it is database-derived (`DEFAULT current_user`) — so attribution
cannot be forged. Only the **derived** `consumer_secret_hash` is stored; the
raw consumer secret never enters SQL, repository files, logs, or proof
evidence. Recovery is permitted only when **no active administrator exists**
(the all-admins-locked-out condition). The marker is matched by derived-hash
equality in `enable_bootstrap_from_marker()` and consumed exactly once by
`complete_bootstrap()`. There is no API route for re-enable. The bootstrap
SECURITY DEFINER functions are owned by `gitwire_auth_fn_owner` (NOLOGIN), not
`gitwire_operator`.

### Least-privilege DB roles

Five roles (level-1-core.md §13, :1366-1421):

- **`gitwire_app`** — the application's everyday role.
- **`gitwire_admission`** — may INSERT admission events.
- **`gitwire_executor`** — may INSERT execution events and receipts;
  sole holder of GitHub write credentials in the `executor_only` and
  `legacy_removed` states.
- **`gitwire_operator`** — may SELECT everything; its only mutating surfaces
  are (a) the audited `transition_enforcement_state()` function, (b) a
  column-level INSERT of recovery markers
  `(consumer_secret_hash, pepper_version)` — `created_by_db_session` is
  database-derived and not insertable — and (c)
  `enable_bootstrap_from_marker()` (recovery only, gated on no active
  administrator). It has **no** direct table UPDATE
  (level-1-core.md:1405-1410).
- **`gitwire_auth_fn_owner`** — `NOLOGIN`; owns the SECURITY DEFINER
  functions. Function ownership is separated from login roles so no
  login role can redefine the enforcement functions.

The operator role deliberately cannot UPDATE tables directly: its mutating
paths are the audited `transition_enforcement_state()` function (whose
`updated_by` is derived from `session_user`), the recovery-marker INSERT
(attribution derived from `current_user`), and
`enable_bootstrap_from_marker()` (recovery, gated on no active
administrator). It cannot complete bootstrap, cannot authenticate to the
application API, and cannot forge marker attribution.

### Threat-model control

The "self-authority hijack" threat is controlled by "GitHub branch
protection + required review; GitWire may propose but never
autonomously merge" (level-1-core.md:86).

### Level 2 JTI operator reconciliation (Level 2 only)

`permission-model.md §14` (:1662-1666) describes an operator
reconciliation step for stuck `executing` JTI claims: a human operator
with production DB access force-transitions `executing` → `cancelled`
after process-supervisor-confirmed termination. This is an audited
manual operation. **This reconciliation is part of the Level 2
capability/JTI design, which ADR-0006 supersedes for the Level 1
closure of F-06.** It is recorded here only so an operator adopting
Level 2 knows the procedure exists and is human-gated; it is not a
Level 1 mechanism.

## Rationale

1. **Propose, never merge.** Letting GitWire prepare its own changes
   preserves automation value; forbidding autonomous merge/deploy
   preserves the human gate on security-sensitive change.
2. **CODEOWNERS + required checks.** Making the gate structural
   (branch protection, required CI, designated owners) rather than
   conventional means a misbehaving run cannot quietly bypass it.
3. **Break-glass is audited and short.** Emergency authority exists
   but is time-bounded, tagged, and alerting — usable for recovery,
   useless for quiet persistence.
4. **Operator role is read-mostly.** Giving the operator SELECT everywhere
   plus audited, narrowly-scoped mutating surfaces (the enforcement-state
   transition function, recovery-marker INSERT with derived attribution, and
   bootstrap-enable gated on no active admin) — and no direct table UPDATE —
   means operational authority cannot silently mutate enforcement state or
   forge attribution.
5. **Function ownership separation.** A `NOLOGIN` owner for SECURITY
   DEFINER functions prevents any login role from redefining the
   enforcement logic.

## Non-goals

- This ADR does not specify the DDL of the roles or grants. That is an
  implementation target owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify multi-party approval machinery; that is a
  Level 2/3 concern (level-1-core.md:132, 1460).
- This ADR does not specify the F-06 closure at Level 1 — see
  ADR-0006. The Level 2 JTI operator-reconciliation procedure noted
  above is informational for Level 2 adopters and is not part of the
  Level 1 mechanism.

## Acceptance criteria

An implementation conforms to this ADR when:

- `master` is protected and requires pull-request review and passing
  CI.
- CODEOWNERS requires designated-owner review on every
  authority-sensitive file.
- Production deployment requires manual approval.
- GitWire automation cannot merge or deploy authority-sensitive
  changes autonomously.
- The `break_glass` role exists with a short absolute expiry and
  alerting.
- Bootstrap re-enable requires a direct DB INSERT into
  `auth_bootstrap_recovery_markers` (derived hash only); the marker is
  validated against its derived consumer-secret hash and consumed exactly
  once. No API route exists for re-enable.
- The `gitwire_operator` role has SELECT everywhere; its mutating surfaces are
  EXECUTE on `transition_enforcement_state()`, a column-level INSERT of
  recovery markers `(consumer_secret_hash, pepper_version)`, and EXECUTE on
  `enable_bootstrap_from_marker()` (recovery, gated on no active admin). It has
  no direct table UPDATE and cannot forge marker attribution.
- The `gitwire_auth_fn_owner` role is `NOLOGIN`.

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §2, §10, §13
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §11
- Related: [ADR-0005](./0005-policy-storage-and-versioning.md) (enforcement state machine + transition function),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (F-06 Level 1 closure; Level 2 JTI reconciliation is informational only here),
  [ADR-0007](./0007-migration-and-compatibility-strategy.md) (operator drives cutover; bootstrap re-enable)
