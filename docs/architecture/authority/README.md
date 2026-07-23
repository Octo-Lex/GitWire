# Authority Cartography — Wave 0

> **Scope marker.** This directory is the Lane B Wave 0 output for issue #77.
> Wave 0 is design-only: it inventories the current authority surface and
> proposes a model. It does **not** introduce runtime authorization behavior,
> migrations, or production code changes.

## What lives here

| Document | Purpose |
|---|---|
| [`current-state-inventory.md`](./current-state-inventory.md) | Disk-verified map of every authority surface today (W0-A). Every claim cites `file:line`. 51 database tables, 174 HTTP endpoints, 14 workers, 15 ranked findings. |
| [`permission-model.md`](./permission-model.md) | Proposed canonical principal / resource / action / permission model (W0-B). Includes evaluation algebra, job-authorization capabilities, and decision-example matrix. |
| [`schema-migration-plan.md`](./schema-migration-plan.md) | No-execution schema design: DDL, constraints, indexes, privileges, concurrency invariants, additive migration ordering, backfill rules, rollback boundaries, and schema-level proof obligations (W0-C). |
| `wave-validation-plan.md` *(W0-D, not yet written)* | Defect-sensitive validation plan for Waves 1–4. |

The inventory is the substrate for everything else. Do not propose a model
that contradicts an inventory finding without an explicit decision recorded
in an ADR (also W0-D).

## Why a separate cartography pass

GitWire's existing [`docs/architecture/security.md`](../security.md) is an
80-line overview covering API-key auth, rate limiting, webhook verification,
GitHub App token scope, data storage, and network security. It describes the
intended model. It does **not** enumerate every mutation sink, every
anonymous path, every place authority is implied but not enforced, or every
trust-the-payload pattern.

The Wave 0 inventory fills that gap. It is comprehensive to the point of
being uncomfortable: it records what the code actually does, including the
places where what the code does is weaker than what the docs claim.

## Methodology

1. **Three parallel read-only cartography passes**, each covering an
   orthogonal surface:
   - HTTP entry points (29 route files, 3 middleware modules)
   - Workers and direct DB/filesystem/script mutation (14 workers + scheduled
     jobs + 51 DB tables + scripts + executor-service)
   - Authentication mechanisms, identity, tenancy, and audit trail
2. **Every claim cites `file:line`.** Names and comments are not trusted; the
   verifier traced actual callers, middleware, guards, and side effects.
3. **Independent verification by the local assistant.** The three passes were
   produced by separate exploration agents. Before synthesis, the local
   assistant re-checked every CRITICAL and HIGH finding against the actual
   repository state and recorded disagreements with the agents where they
   occurred (see `Disputed findings` in the inventory).
4. **Coverage accounting per pass.** Each surface records what was covered,
   what was skipped and why, and what remains unknown.

## Risk-rating key

Findings in the inventory are rated by **severity** and **confidence**.

### Severity

| Rating | Meaning |
|---|---|
| `CRITICAL` | A principal can perform a mutation or access data they should not, without authentication or by exploiting a structural bypass. Exploitation is straightforward. |
| `HIGH` | Authentication exists but is structurally weak (single shared secret, spoofable identity, replayable, non-constant-time), or authority is propagated unsafely across a trust boundary. Exploitation is possible with access to a specific layer (Redis, network, logs). |
| `MEDIUM` | Authority is enforced but attribution, audit, or tenancy is weaker than the consumer would reasonably expect. Exploitation requires authenticated access and yields only audit forgery, cross-tenant data leakage, or a partial authorization bypass. |
| `LOW` | Operator-hygiene, hardening opportunity, or future-degradation risk with no present exploit path. |
| `INFO` | Documented for completeness; no security impact. |

### Confidence

| Rating | Meaning |
|---|---|
| `VERIFIED` | The local assistant re-checked this claim against the actual repository state in this session and confirmed the cited `file:line` evidence. |
| `REPORTED` | The exploration agent reported this with citation, but the local assistant did not re-verify it in this session (time-bounded synthesis). Carries the same weight as the underlying evidence; tagged for follow-up. |
| `DISPUTED` | The local assistant re-checked this claim and **disagrees** with the agent's framing. The inventory records the corrected fact and the reason for the disagreement. |

## Frozen base and branch

- **Branch:** `lane-b/wave-0-authority-cartography`
- **Base SHA:** `7b8cdc62b4262b5913dbebaedcb4401f2acef29a` (the Lane A / P2
  frozen baseline — see PR #69).
- The Wave 0 branch is 0 commits ahead / 0 behind that baseline at the start
  of W0-A. Each W0-* checkpoint advances the branch by one or more commits
  (review corrections may require additional commits within a checkpoint).

## Out of scope for Wave 0

Per the assignment:

- No runtime authorization behavior is introduced.
- No production migrations are created or executed.
- No credentials are rotated, no identity provider is reconfigured.
- The frozen P2 stress substrate (`packages/web/tests/stress/`,
  `packages/web/tests/unit/stress-functional/`) is not modified.
- The CI-hardening workstream (issue #78) proceeds in parallel on a separate
  branch.
- `.ouroboros/`, `.zcode/`, `rewrite-rules.txt`, detached `trial_repo_*`
  worktrees, and stale `gitwire/heal-*` branches are not touched.

## Checkpoint status

| Checkpoint | Status | Head |
|---|---|---|
| **W0-A** | ✅ Accepted | `f7e2ce6` — current-state inventory |
| **W0-B** | ✅ Accepted | `51e3f70` — permission and resource model |
| **W0-C** | 🔲 Awaiting review | schema and migration plan |
| **W0-D** | ⛔ Blocked | ADRs and validation plan (blocked on W0-C) |
| **W0-E** | ⛔ Blocked | cumulative re-verification before PR |
