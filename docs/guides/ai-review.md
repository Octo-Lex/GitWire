# AI Review (Advisory)

GitWire's AI code review is **advisory**: the model produces a review
judgment, and GitWire — not the model — decides what that judgment is allowed
to do. By default an AI review never approves or requests changes on
GitHub's behalf; it publishes a comment and leaves the decision with the
maintainers and the repository's configured policy.

This page explains what you see on a pull request and what each part means.

## What gets posted

Every AI review publishes **one GitHub review comment** on the pull request.
The comment states three things explicitly:

> **AI judgment: APPROVE** · Evidence: COMPLETE · Authority: advisory
> Evidence complete · 14/14 changed files accounted for

- **AI judgment** — the reviewer's conclusion: `APPROVE`,
  `NEEDS DISCUSSION`, or `REQUEST_CHANGES`.
- **Evidence** — whether GitWire could actually review the whole change
  (`COMPLETE` or `INCOMPLETE`). See below.
- **Authority** — `advisory` in the default configuration, or `repository
  policy blocked` when your repository's own configuration asked for a
  blocking consequence.

Findings are attached as inline review comments where GitHub's diff supports
anchoring them; findings that cannot be anchored (for example, issues on
deleted lines) carry their full detail in the review body instead. Nothing is
silently dropped.

## The four published outcomes

A review body can end in one of four outcomes. The model's judgment and the
published outcome are not always the same thing — GitWire publishes
`INCOMPLETE` when it cannot stand behind a clean result.

**APPROVE** — the reviewer found no material concerns *and* GitWire accounted
for every changed file with complete review evidence. This is still a
recommendation; a human merges the PR.

**NEEDS DISCUSSION** — the reviewer found concerns worth maintainer attention,
below the request-changes threshold.

**REQUEST_CHANGES** — the reviewer found material concerns. In the default
configuration this is still advisory: it is published as a comment, and the
GitWire check fails only if your repository explicitly configured blocking.

**INCOMPLETE** — GitWire could not review the whole change, so no clean
approval is issued even if the reviewer liked what it saw. The body says why,
for example:

> **INCOMPLETE — no clean approval was issued.** GitWire could not completely
> review this change: 3 of 12 changed files lacked complete review evidence
> (limits reached: max_files_to_review).

Reasons a review can be incomplete: the changed-file or line budget was
exceeded, a file's diff was too large to include fully, the review bundle hit
its size limit, or a file is binary and has no reviewable diff. Budgets are
not silently exceeded — the omitted material is always named.

## Removed files are reviewed

Deleting a file is a normal part of a change, and deletions are reviewed like
any other edit — removing an auth check is exactly the kind of change a
reviewer should look at. A removed file only counts as excluded when an
explicit ignore pattern in your configuration matches its path.

## "Unverified" findings

A material finding whose claimed location cannot be validated against the
diff GitWire actually acquired is published with an **unverified** badge. The
reviewer's opinion stays visible, but an unverified finding never fails the
GitWire check by itself.

## Superseded reviews

If the PR head changes while a review is running, the in-flight review is
**superseded**: nothing is published for the old head, and the check
terminalizes neutrally ("AI review superseded", with both commit SHAs).
GitWire does not automatically re-review the new head — push again, reopen
the PR, or request a review to trigger a fresh one. A review is never posted
looking current when it actually analyzed an older commit.

## Blocking policy (optional)

Blocking is opt-in per repository. Configure `block_on_verdict` (default:
`["request_changes"]`) with `min_confidence_to_block` (default: `medium`) on
the repository's AI review configuration. When a `REQUEST_CHANGES` judgment
with validated finding evidence meets that policy, the GitWire check fails —
repository policy, never the model alone, produces the consequence.

## For operators

- **Publication mode**: `ai_review_config.publication_mode` — `advisory`
  (default) or `legacy_stateful` (rollback only: emits GitHub
  `APPROVE`/`REQUEST_CHANGES` events directly; not the pilot target).
- **Receipts**: every invocation writes a reconstructable receipt into
  `ai_reviews` — judgment, published outcome, integrity state, authority
  state, publication mode, blocking flag, GitHub review event, publication
  state, terminal reason, per-file coverage, and per-finding evidence
  receipts. Publication is exactly-once across crashes: each review carries a
  deterministic marker, and a retry that finds a prior publication adopts it
  instead of duplicating it.
- **Terminal states** (`terminal_reason`): `completed`,
  `completed_unpublished`, `head_superseded`, `delivery_failure`,
  `ambiguous_publication`, `recovered_after_crash`, `error`.
