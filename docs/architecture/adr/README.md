# Architecture Decision Records

> **Scope marker.** This directory records the binding architectural
> decisions of the accepted Level 1 authority architecture (issue #77,
> output 4). Each ADR encodes a decision already settled in
> [`../authority/level-1-core.md`](../authority/level-1-core.md) (W0-C-R)
> and [`../authority/permission-model.md`](../authority/permission-model.md)
> (W0-B). ADRs do **not** introduce new architecture, re-derive the model,
> or specify executable SQL — they record *decisions* and cite the source
> documents by `file:line`. The parent cartography is
> [`../authority/README.md`](../authority/README.md).

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](./0001-authority-source-of-truth.md) | Authority source of truth | Accepted |
| [ADR-0002](./0002-principal-resource-action-model.md) | Principal/resource/action model | Accepted |
| [ADR-0003](./0003-evaluation-and-deny-semantics.md) | Evaluation and deny semantics | Accepted |
| [ADR-0004](./0004-tenancy-and-resource-inheritance.md) | Tenancy and resource inheritance | Accepted |
| [ADR-0005](./0005-policy-storage-and-versioning.md) | Policy storage and versioning | Accepted |
| [ADR-0006](./0006-audit-event-integrity-boundary.md) | Audit/event integrity boundary | Accepted |
| [ADR-0007](./0007-migration-and-compatibility-strategy.md) | Migration and compatibility strategy | Accepted |
| [ADR-0008](./0008-production-security-authority-retained-by-humans.md) | Production/security authority retained by humans | Accepted |

All eight are required by issue #77, output 4 ("ADR set"). They are the
minimum set, not a ceiling.

## Convention

A GitWire ADR is a numbered Markdown record in this directory. The
convention is intentionally minimal.

### File naming

```text
NNNN-short-kebab-slug.md
```

- `NNNN` — zero-padded sequential number, starting at `0001`. Numbers are
  never reused or renumbered.
- `short-kebab-slug` — lowercase kebab-case summary of the decision
  (e.g. `authority-source-of-truth`).
- Extension `.md`.

### Record shape

Every ADR opens with an H1 of the form `# ADR NNNN: <Title>`, followed by
these sections, in order:

1. `## Status` — one of `Accepted`, `Superseded by ADR-NNNN`, `Deferred`.
   For `Accepted`, name the source document that settles the decision.
2. `## Context` — the problem the decision addresses, and the
   alternatives considered. Cite the source architecture by `file:line`.
3. `## Decision` — the decision, stated in normative prose. This is the
   binding text; prose elsewhere is informational.
4. `## Rationale` — why this decision over the alternatives.
5. `## Non-goals` — what this decision does **not** settle, with a
   pointer to where that concern is owned (e.g. issue #81 for executable
   SQL proof).
6. `## Acceptance criteria` — the observable conditions under which an
   implementation conforms to this ADR.
7. `## Cross-references` — sibling ADRs and the source documents.

### Normative language

Use lowercase normative verbs (`must`, `must not`, `cannot`). This matches
the accepted authority documents, which use zero RFC 2119 uppercase `MUST`.
A `## Decision` section is binding regardless of which verb it uses.

### Supersession

When an ADR overrules an earlier accepted document or ADR, it must say so
explicitly and narrowly: name the superseded text, state the scope of the
supersession, and retain the superseded text as guidance for any scope it
still covers. See ADR-0006 for the worked example (the Level 1 capability/JTI
supersession).

### How to add a new ADR

1. Pick the next free number; do not renumber existing ADRs.
2. Copy the record shape above. Do not add YAML frontmatter — an H1 on
   line 1 is the house style.
3. Cite the accepted source architecture by `file:line` for every claim.
   If no accepted source settles the decision, the ADR is premature —
   raise the decision in its source document first.
4. Add a row to the `## Index` table above.
5. If the ADR supersedes an earlier accepted document, add the narrow
   supersession note to that document (as ADR-0006 does for
   `permission-model.md`).

## Relationship to the Level 1 architecture

These ADRs are the decision record for the Level 1 authority core defined
in [`../authority/level-1-core.md`](../authority/level-1-core.md). They
encode the invariants, enforcement allocation, trust boundaries, and
extension seams of that document.

Executable proof — applying the migrations, running the negative tests,
verifying rollback and reapply against a disposable PostgreSQL instance —
is **not** part of this package. It is owned by
[issue #81](https://github.com/Octo-Lex/GitWire/issues/81) and the
authorized implementation wave. Where an ADR cites SQL DDL, the citation
is to the architectural intent recorded in `level-1-core.md`; the
DDL's executable correctness is #81's concern.

## Out of scope for this package

- New architecture not already settled in `level-1-core.md` or
  `permission-model.md`.
- Executable migrations, DB smoke tests, or runtime test harnesses
  (issue #81 / post-Wave-0 waves).
- Runtime identity/RBAC/policy enforcement code.
- Production, credential, deployment, or environment changes.
