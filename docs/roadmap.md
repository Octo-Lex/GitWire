# GitWire Gap-Closure Roadmap

> **Canonical multi-release plan.** This document supersedes earlier roadmap drafts
> and absorbs the operational lessons from the CT 115 reconciliation window
> (2026-06-19). The implementation slice for the next release lives separately at
> [`installation/v0.20.1-plan.md`](./installation/v0.20.1-plan.md).

## Purpose

GitWire's strategic position is strong: v0.19.0 made repair proposals governable,
and v0.20.0 made pass-capable isolated repair verification reachable. The next
phase is to convert that capability into production-grade operational value while
hardening the platform around deployment discipline, auditability, operator
workflow, model/provider flexibility, and review depth.

This roadmap is gap-driven. Each item is framed as:

* the current gap,
* the concrete fix,
* why it matters,
* why it belongs in this sequence,
* and the acceptance criteria for calling it done.

## Strategic north star

GitWire should not try to become "just another AI reviewer." Its moat is the
complete governance loop:

```text
Policy → AI decision → scoped action → execution receipt → reconciliation → audit evidence
```

The product promise remains:

```text
Decide. Execute. Prove.
```

The roadmap should therefore prioritize the gaps that strengthen that proof chain
first, then address usability, portability, and breadth.

---

# Executive summary

## Immediate priority

The highest-priority work is no longer the production validator image. The CT 115
reconciliation revealed that deployment drift can invalidate the running system
even when the repository and releases are correct.

The immediate priority is therefore:

```text
Make every future container rebuild self-reconciling, self-verifying, and externally observable.
```

That means v0.20.1 must be a deployment-discipline release before product work
resumes, and it must include a CI build+smoke gate so unbuildable code cannot
merge in the first place.

## Current production state

CT 115 has been reconciled and is currently healthy (as of 2026-06-20):

```text
Disk:       v0.20.0
Container:  v0.20.0
Database:   migration 036
Redis:      256 MB ceiling applied live, noeviction (ephemeral until v0.20.1-A)
GitHub App: unsuspended, traffic flowing normally
```

The remaining operational caveat is:

```text
Redis maxmemory is currently process-memory only.
```

If the Redis container is recreated before v0.20.1-A ships, the ceiling resets to
unbounded unless manually reapplied.

## Next major milestone

The next release should be:

```text
v0.20.1 — Deployment Discipline
```

This release prevents recurrence of the drift class discovered during the CT 115
reconciliation window.

After v0.20.1, the roadmap resumes with executor reachability, production
validator image work, backend evidence capture, and post-apply proof.

---

# Release roadmap

| Release             | Theme                               | Goal                                                                             |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| v0.20.1-A           | Deployment discipline               | Make migrations, Redis config, CI build gate, and deployment visibility durable  |
| v0.20.1-B / v0.20.2 | Version centralization              | Remove version drift across backend, dashboard, and package surfaces             |
| v0.21.0             | Operational pass-capable executor   | Make the v0.20 proof chain work with a real validator image and backend evidence |
| v0.22.0             | Post-apply proof chain              | Prove the applied repository state, not only the proposed patch                  |
| v0.23.0             | Operator workflow and audit UX      | Make proof and approval understandable to humans                                 |
| v0.24.0             | LLM provider abstraction            | Reduce model/vendor lock-in                                                      |
| v0.25.0             | Evaluation readiness and hygiene    | Documentation, dependencies, and release hardening                               |
| v0.26.0             | Code graph and repository indexing  | Improve AI review depth beyond diff scope                                        |
| v0.27.0             | Data acquisition correctness        | Pagination, ingestion robustness, sync correctness                               |
| v1.0.0              | Stable self-hosted governance plane | Production-ready control plane for governed GitHub automation                    |

---

# Tier 0 — Deployment discipline and production invariants

## Gap 0: Production can drift away from the released repository

### Problem

The CT 115 reconciliation revealed that release correctness and production
correctness had diverged.

Production was found with:

```text
Disk:       v0.20.0
Container:  stale image
Database:   stale migration ledger / missing governance tables
```

The database had physically applied some v0.15-era schema changes without
recording the corresponding migrations, and it was missing the v0.16–v0.20
repair/governance subsystem tables until manual reconciliation.

The system is now reconciled, but the original failure mode can recur unless
deployment itself becomes self-checking.

### Fix

Ship v0.20.1-A as a deployment-discipline release.

Scope:

1. Add a fail-closed Docker entrypoint that runs migrations before app startup.
2. Persist Redis memory ceiling and `noeviction` policy in Docker Compose.
3. Expose version, git SHA, and migration status in health/readiness.
4. Add a CI Docker build + smoke gate (see Gap 0.2).
5. Update deployment documentation with the reconciliation lessons.
6. Add CRLF normalization guidance for emergency Linux hotfixes from Windows
   working copies.

### Acceptance criteria

* A fresh app container rebuild runs `node scripts/migrate.js` before starting
  workers.
* If migrations fail, the app container exits non-zero.
* Redis restarts with:

  ```text
  maxmemory = 268435456
  maxmemory-policy = noeviction
  ```

* Redis still preserves append-only persistence.
* Health/readiness reports:

  * version,
  * git SHA when available,
  * applied migration count,
  * available migration count,
  * migration status derived from applied vs available.
* Deployment docs explain:

  * `docker-entrypoint-initdb.d` only runs on first database creation,
  * `CONFIG SET` is ephemeral when Redis has no config file,
  * the canonical migration runner path,
  * and CRLF normalization during emergency `scp` hotfixes.

### Why now

This must happen before product roadmap work. Otherwise future features can again
be merged, tagged, and released while production silently runs stale code or
stale schema.

---

## Gap 0.1: Version strings are not centralized

### Problem

Version drift appeared across root package, workspace packages, dashboard footer,
and running container surfaces.

Root was at v0.20.x while workspace packages (`packages/web`,
`packages/web-dashboard`, `packages/core`, `packages/runtime`, `packages/bot`,
`packages/rules`) remained at v0.14.0, and the dashboard shipped a hardcoded
`v0.12.0` visible string in the sidebar footer (`Sidebar.tsx:147`). This is a
**multi-release divergence across package metadata and UI surfaces**, not a
cosmetic typo. The dashboard-visible version lagged the released version by eight
minor releases.

### Fix

Ship v0.20.1-B or v0.20.2 as a focused version-centralization release.

Preferred approach:

1. Commit a fallback build-info module with safe defaults.
2. Overwrite it during Docker/build with real version, git SHA, and timestamp.
3. Use that module in backend health/readiness and dashboard footer.
4. Keep imports safe in fresh clones and tests before generation runs.

Committed fallback example:

```js
export const BUILD_INFO = {
  name: "gitwire",
  version: "0.0.0-dev",
  gitSha: null,
  builtAt: null
};
```

### Acceptance criteria

* Fresh clone works before build-info generation.
* Tests work before build-info generation.
* Docker build overwrites fallback with real version/SHA.
* Dashboard footer does not hardcode version.
* Backend health reports the same version as the dashboard.
* Version source is root package version unless explicitly overridden at build
  time.

### Why after v0.20.1-A

Version centralization improves operability, but entrypoint migrations, durable
Redis limits, and the CI build gate materially change failure modes. Ship
structural invariants first. Given the verified scale of the divergence
(six `package.json` files plus a UI string), this is **non-trivial work**, not
a fold-in candidate unless it proves trivial while touching health metadata.

---

## Gap 0.2: Code can merge without proving the production image builds and boots

### Problem

During the CT 115 reconciliation rebuild, **six latent build/runtime bugs** were
discovered that had been committed across v0.16–v0.20 and never caught:

* `policyRolloutService.js`: orphaned function body (`return` at module scope)
  caused `SyntaxError: Illegal return statement` — hard crash on boot.
* `SetupChecklist.tsx`: `useApi` imported from `swr` (does not export it).
* `Sidebar.tsx`: `DryRunProofIcon` imported twice.
* `policy-preview/page.tsx`: unescaped `->` parsed as JSX closing tag.
* `rollouts/page.tsx`: `EmptyState` passed `subtitle` prop it does not accept.
* `first-run-onboarding.md`: dead link to nonexistent configuration page.

These survived because the production container had not been rebuilt since v0.15.
The migration entrypoint (Gap 0) prevents *schema* drift on startup, but a syntax
error or import failure would still crash the container on boot — and the bug
would only surface during a deploy, not at PR time.

This is the **same root cause** as the drift class — "release correctness ≠
production correctness" — applied to the build layer instead of the migration
layer.

### Fix

Add a CI Docker build + smoke gate to every PR targeting `master`.

Required work:

1. CI job builds the production Docker image for the app (and ideally the
   dashboard) on every PR.
2. CI boots the image with test/env-safe dependencies and a reachable
   Postgres + Redis (service containers or ephemeral compose).
3. CI hits `/health` (or `/readiness`) and requires a 200 within a timeout.
4. Syntax/runtime startup errors fail CI before merge.

### Acceptance criteria

* PR CI builds the production Docker image.
* CI starts the image with test/env-safe dependencies.
* CI hits `/health` or `/readiness` successfully.
* Syntax/runtime startup errors fail CI before merge.
* The gate would have caught the six v0.16–v0.20 latent build/runtime bugs.

### Why now

This is not optional hygiene. It closes the "merged but never rebuilt" class of
failure that consumed hours of the reconciliation window. Without it, the next
feature release can again ship unbuildable code. This belongs in **v0.20.1-A**.

---

# Tier 1 — Operationalize the flagship capability

## Gap 1.0: Docker/Podman execution is not yet proven reachable from the app container

### Problem

The Docker executor (`dockerExecutorBackend.js`) calls `docker`/`podman` from
inside the app runtime via `spawn("docker", ...)`. In the current CT 115
deployment, the app container does **not** have Docker socket access, and the LXC
host's nesting model has not been validated for this use case.

Without resolving this, the validator image work cannot be called operational —
the executor will fail at the first `docker run --network=none --read-only ...`
with "docker: not found" or a socket-permission error.

### Fix

Prove and document Docker/Podman reachability from the deployed topology before
investing in the validator image itself.

Required work:

1. The app/executor runtime must be able to invoke `docker` or `podman`.
2. The socket/permission model must be documented (host socket mount with
   restricted permissions, sidecar executor, or a separate worker runtime).
3. The model must work under the LXC constraints on CT 115 (nesting=on is set,
   but the inner-container execution path is unproven).
4. Isolation probes must run in the **same topology** used by production
   receipts, not just in a dev environment.
5. The failure mode must be explicit if the executor runtime is unavailable
   (fail-closed, not silent inconclusive).

### Acceptance criteria

* The app/executor runtime can invoke `docker` or `podman`.
* Socket/permission model is documented.
* The model works under LXC constraints.
* Isolation probes run in the same topology used by production receipts.
* Failure mode is explicit if executor runtime is unavailable.

### Why before Gap 1

Validator image work depends on this. Building and publishing an image is
useless if the runtime that is supposed to execute it cannot reach the container
daemon. This is the gating infrastructure prerequisite.

---

## Gap 1: The pass-capable executor exists, but production pass execution is not yet operational

### Problem

v0.20.0 authorizes the Docker executor as the only pass-capable backend and
wires backend evidence into the verifier. However, the Docker executor still
depends on a configured production image reference:

```text
GITWIRE_VALIDATOR_IMAGE_REF=registry/path/gitwire-validator@sha256:<real-digest>
```

If that is unset, the backend falls back to a deterministic test fixture image.
That fixture is intentionally blocked from producing production pass results
unless explicitly allowed for test environments.

This is the correct safety posture, but it means the v0.20 proof chain is not
operational in production until a real validator image exists and evidence is
captured for it.

### Fix

Create and publish the real validator image (after Gap 1.0 is resolved).

Required work:

1. Define the validator image contents.

   * Start with the minimal toolchain required for current validation commands.
   * Prefer a locked base image.
   * Keep the image small and deterministic.
   * Avoid credentials, package manager caches, or mutable install-time behavior.

2. Build and push the image.

   * Example target:

     ```text
     registry.example.com/gitwire/gitwire-validator@sha256:<digest>
     ```

3. Configure the runtime.

   * Set:

     ```text
     GITWIRE_VALIDATOR_IMAGE_REF=registry.example.com/gitwire/gitwire-validator@sha256:<digest>
     ```

   * Do not set `GITWIRE_ALLOW_TEST_FIXTURE=1` outside tests.

4. Run E2E isolation evidence capture.

   * Network disabled.
   * No GitHub token.
   * No SSH agent.
   * Non-root user.
   * Read-only rootfs.
   * Workspace writable.
   * PID limit enforced.
   * Memory limit enforced.
   * Wall clock timeout enforced.
   * No Docker socket exposure beyond what is explicitly required and documented.

5. Persist backend evidence through the existing evidence store.

   * Evidence must include probe suite hash.
   * Evidence must include inspection hash.
   * Evidence must include inspected image digest.
   * Evidence must include repo digest set.
   * Evidence must recompute and validate before any pass receipt is accepted.

6. Validate against a real failing CI run.

   * Failed CI evidence collected.
   * Diagnosis created.
   * Patch proposed.
   * Docker executor runs validation.
   * Pass receipt recorded.
   * Proposal transitions to `verified`.
   * Critic approval transitions to `review_ready`.

### Acceptance criteria

* A real digest-pinned validator image is built and documented.
* `GITWIRE_VALIDATOR_IMAGE_REF` is required for production pass execution.
* Test fixture image cannot produce production pass.
* Backend evidence exists for the real image digest.
* A real repair proposal can move:

  ```text
  proposed → verified → review_ready
  ```

* All receipts bind:

  * backend ID,
  * executor version,
  * image ref,
  * image digest,
  * source snapshot,
  * patch artifact,
  * validation plan,
  * command results,
  * and backend evidence.

### Why after Tier 0

The validator image should not be operationalized until rebuilds are safe,
migrations are automatic, Redis limits are durable, CI catches unbuildable code,
health/readiness can detect deployment drift, and the executor runtime can
actually reach Docker/Podman in the deployed topology.

---

## Gap 2: Executor comments contradict pass-capable behavior

### Problem

The Docker executor still contains stale comments saying `supports_pass` is
currently false and will be flipped later. The code now has `supports_pass: true`,
gated by production image configuration, backend evidence, and the lifecycle
verifier.

In governance software, comments are part of the audit story. A stale
fail-closed comment in a pass-capable executor is not harmless; it misleads
reviewers and operators about the safety posture.

### Fix

Update Docker executor comments to reflect the current state:

* Docker executor is pass-capable.
* Pass results are allowed only when:

  * production image ref is configured,
  * test fixture is not being used,
  * backend evidence exists,
  * the verifier accepts the evidence,
  * and the lifecycle receipt binds to the same evidence.

Remove all comments implying the backend is still dormant.

### Acceptance criteria

* No comment says `supports_pass` is false.
* No comment says a later PR will flip pass support.
* Header comments describe the production gating model accurately.
* Inline comments near pass derivation explain fixture refusal and production
  pass behavior.

### Why now

This should ship with the operational executor work. The code has crossed from
dormant scaffold to pass-capable subsystem; the comments need to cross with it.

---

# Tier 2 — Close the final proof-chain gap

## Gap 3: GitWire proves proposed patches, not yet applied repository state

### Problem

v0.20 proves that a proposed patch can pass inside a verified isolated executor.
That is necessary, but not sufficient.

The stronger governance claim is:

```text
The patch that was approved was actually applied, and the resulting repository state passed validation.
```

Without post-apply proof, GitWire has a gap between:

```text
approved artifact
```

and:

```text
actual repository state after apply
```

The schema already declares the `applied` and `verified_after_apply` states and
the `applied_by`/`applied_at` columns (migration 031), but there is no
`recordApply` / `recordVerifiedAfterApply` code path — the states are currently
unreachable.

### Fix

Implement post-apply proof chain.

Required work:

1. Make apply operation explicit.

   * Record apply attempt.
   * Record target branch.
   * Record expected base SHA.
   * Record resulting commit SHA or tree SHA.
   * Record applied artifact hash.

2. Verify the applied state.

   * Fetch post-apply source snapshot.
   * Confirm applied commit/tree contains the approved artifact changes.
   * Reconstruct validation inputs from applied state.
   * Run isolated validation against applied state.
   * Record post-apply execution receipt.

3. Enable:

   ```text
   applied → verified_after_apply
   ```

4. Add failure paths.

   * Apply conflict.
   * Base moved.
   * Artifact mismatch.
   * Post-apply validation failed.
   * Post-apply executor inconclusive.
   * GitHub mutation failed.

5. Preserve audit chain.

   * Proposal ID.
   * Patch artifact hash.
   * Approval event.
   * Apply event.
   * GitHub mutation ref.
   * Resulting commit/tree.
   * Post-apply source snapshot.
   * Post-apply receipt.

### Acceptance criteria

* `verified_after_apply` is reachable only through a real post-apply receipt.
* The applied tree/commit is bound to the approved patch artifact.
* A patch cannot be marked verified after apply if:

  * it differs from the approved artifact,
  * it was applied to the wrong base,
  * validation did not run,
  * validation receipt is missing,
  * backend evidence is missing,
  * or command results are incomplete.
* The audit trail can answer:

  ```text
  Who approved what, what was applied, to which repo state, and what proof shows it still passed?
  ```

### Why this comes before UX

UI polish without post-apply proof would make an incomplete trust chain easier
to use. Post-apply proof makes the trust chain correct.

---

# Tier 3 — Make the workflow usable and auditable

## Gap 4: Operator experience is mostly backend-governance primitives

### Problem

The backend now has strong proof primitives, but operators need a clean workflow
for reviewing, approving, rejecting, retrying, and explaining repair proposals.

Without operator UX, the system is technically sound but hard to evaluate.

### Fix

Build the operator repair workflow.

Surfaces:

1. Repair proposal list.

   * Status.
   * Repository.
   * CI failure source.
   * Diagnosis summary.
   * Patch summary.
   * Verification state.
   * Critic verdict.
   * Required operator action.

2. Proposal detail page.

   * Evidence collected.
   * Diagnosis.
   * Patch artifact.
   * Validation plan.
   * Execution receipt.
   * Backend evidence.
   * Critic review.
   * Event timeline.

3. Approval/rejection flow.

   * Approve only if `review_ready`.
   * Reject with reason.
   * Cancel/supersede stale proposals.
   * Retry failed verification where policy allows.

4. Proof viewer.

   * Receipt hash.
   * Source snapshot hash.
   * Artifact hash.
   * Image ref/digest.
   * Backend evidence hash.
   * Probe results.
   * Command results.
   * Output refs.

5. Audit export.

   * Markdown summary.
   * JSON bundle.
   * Redacted evidence.
   * Hash chain.

### Acceptance criteria

* Operator can understand why a repair is safe without reading DB rows.
* Operator can approve/reject from UI with audit trail.
* Evidence/receipt hashes are visible.
* The UI distinguishes:

  * failed,
  * inconclusive,
  * verified,
  * review_ready,
  * approved,
  * applied,
  * verified_after_apply.
* The UI can export a complete proposal evidence bundle.

---

## Gap 5: Audit bundles are not yet a first-class product surface

### Problem

GitWire's strongest differentiator is proof. But proof needs to be portable.

Auditors, security reviewers, and enterprise buyers will ask for:

```text
Show me why this action was allowed.
Show me what ran.
Show me what changed.
Show me who approved it.
Show me the evidence after the fact.
```

### Fix

Create exportable audit bundles.

Bundle formats:

1. JSON bundle.

   * Machine-readable.
   * Complete hash references.
   * Event timeline.
   * Proposal state.
   * Policy decision.
   * Worker decisions.
   * Receipts.
   * Evidence.

2. Markdown bundle.

   * Human-readable.
   * Executive summary.
   * Timeline.
   * Pass/fail table.
   * Approval decision.
   * Hash appendix.

3. Optional signed bundle.

   * Detached signature.
   * Export hash.
   * Versioned schema.

### Acceptance criteria

* Any repair proposal can produce an audit bundle.
* Bundle includes enough data to reconstruct the proof chain.
* Secrets and raw model outputs remain redacted or excluded.
* Bundle format is versioned.
* Bundle export does not mutate proposal state.

### Why this matters

Competitors can claim "AI reviewed this." GitWire can claim "here is the
evidence chain proving why this automation was allowed and what it did."

That is the moat.

---

# Tier 4 — Reduce vendor lock-in and improve enterprise fit

## Gap 6: Anthropic is hardwired across AI services

### Problem

Multiple production services import `@anthropic-ai/sdk` directly (verified: 10
files including `aiReviewService`, `adversarialReview`, `adversarialDefense`,
`configValidationService`, `embeddingService`, `flakyTestService`,
`ciHealWorker`, `issueFix/analyze`, `issueFix/generate`, `triageWorker`). There
is no provider abstraction, and at least one core review service hardcodes a
Claude model (`claude-sonnet-4-20250514` in `aiReviewService.js:49`).

This creates:

* vendor lock-in,
* enterprise procurement friction,
* data residency concerns,
* model migration friction,
* and duplicated prompt/client handling.

### Fix

Introduce an LLM provider interface.

Suggested interface:

```ts
interface LLMProvider {
  complete(input: {
    messages: Array<Message>;
    model?: string;
    schema?: unknown;
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMCompletionResult>;

  embed?(input: {
    text: string;
    model?: string;
  }): Promise<number[]>;
}
```

Implement providers:

1. `AnthropicProvider`

   * Wrap current SDK calls.
   * Preserve existing behavior.
   * Default provider initially.

2. `OpenAICompatProvider`

   * Base URL.
   * API key.
   * Model name.
   * Works with OpenAI-compatible gateways.

3. `LiteLLMProvider`

   * Optional.
   * Useful for enterprise routing.

4. Future:

   * Ollama/local.
   * vLLM.
   * Gemini-compatible gateway.

Configuration:

```text
GITWIRE_LLM_PROVIDER=anthropic|openai-compatible|litellm
GITWIRE_LLM_BASE_URL=
GITWIRE_LLM_API_KEY=
GITWIRE_LLM_REVIEW_MODEL=
GITWIRE_LLM_EMBED_MODEL=
```

### Acceptance criteria

* Core services receive an `LLMProvider`, not `Anthropic`.
* Anthropic remains supported.
* OpenAI-compatible endpoint works for completion.
* Embedding path has a provider abstraction or clean fallback.
* Default behavior remains unchanged when no provider env vars are set.
* No raw provider SDK objects cross service boundaries.

---

# Tier 5 — Evaluation readiness and release hygiene

## Gap 7: Documentation and dependency hygiene

### Problem

Evaluation readiness depends on visible consistency and low-friction setup.

Known cleanup areas:

* Dashboard/package version drift — verified scale: root at v0.20.x, all six
  workspace packages at v0.14.0, dashboard sidebar footer hardcoded `v0.12.0`.
  Multi-release divergence, not cosmetic (addressed structurally in v0.20.1-B).
* Dashboard README under-documentation.
* `@octokit/rest` declared as a runtime dependency in two packages but only
  referenced in a single JSDoc type hint (`create-github.js:70`) — candidate for
  devDependency move.
* Dashboard ships both `@phosphor-icons/react` (1 file) and `lucide-react`
  (0 files) — one is effectively unused.
* `zod` is actively used (`packages/web/config/index.js` env validation) and
  **must not** be removed.

### Fix

1. Update dashboard and package docs.
2. Add a release checklist that checks visible version surfaces.
3. Audit dependencies precisely (by import analysis, not assumption).
4. Consolidate icon libraries if practical.
5. Keep `zod`.

### Acceptance criteria

* No hardcoded stale visible version.
* Dashboard README reflects actual UI.
* Dependency removals are justified by import analysis.
* Package lock updated.
* Full suite passes.

---

# Tier 6 — Improve review depth against competitor strengths

## Gap 8: AI review is still mostly diff-scoped

### Problem

GitWire can govern and prove AI actions better than competitors, but review
depth is limited if the AI review context is primarily the PR diff and local
context.

Competitors focused on code intelligence can identify cross-file breakage
because they index repository structure. GitWire does not yet have a full code
graph.

### Fix

Build code context in stages.

## Stage 1 — Symbol and call graph index

Use tree-sitter or language-specific parsers to extract:

* files,
* symbols,
* imports,
* exports,
* call sites,
* definitions,
* references,
* reverse dependencies.

Use this to augment PR review with:

* callers of changed functions,
* definitions used by changed files,
* files importing changed modules,
* test files related to changed code.

## Stage 2 — Semantic code chunks

Add embeddings only after symbol indexing.

## Stage 3 — Review bundle augmentation

Modify review bundle builder to include:

* diff,
* directly related symbols,
* reverse dependencies,
* related tests,
* semantic neighbors,
* prior findings if relevant.

### Acceptance criteria

* PR review can retrieve code outside the changed diff.
* Bundle explains why each extra file was included.
* Index is tied to commit SHA.
* Stale index is detected and rebuilt.
* Review findings can cite both changed and related files.
* Context budget is bounded.

---

# Tier 7 — Data acquisition correctness hardening

## Gap 9: Pagination logic is duplicated and may rely on non-contract behavior

### Problem

Some GitHub ingestion loops use repeated requests and empty-array termination
(`while(true)` + `break on empty array`) rather than a central helper that
follows GitHub's pagination contract (the `Link: rel="next"` header). This
pattern is duplicated across `syncWorker`, `maintainerService`, and
`reconciliationWorker`.

**This is a latent data-loss risk** if a GitHub endpoint changes pagination
behavior, returns partial pages, or search/list endpoint shapes diverge from the
current empty-array termination assumption. The `GET /search/issues` endpoint
already returns `{ total_count, items }` rather than a bare array — if it were
ever put in a paginated loop, `!data.length` would evaluate truthy on the first
page and silently truncate results.

### Fix

Create a shared GitHub pagination helper.

Preferred:

```ts
githubPaginate(octokit, route, params)
```

Requirements:

* Follow `Link: rel="next"` header.
* Handle list endpoints.
* Handle search endpoints with `{ total_count, items }`.
* Bound page count.
* Bound total items.
* Emit instrumentation.
* Preserve rate-limit errors.

### Acceptance criteria

* Sync worker uses shared paginator.
* Maintainer service uses shared paginator.
* Reconciliation worker uses shared paginator.
* Search endpoints are handled explicitly.
* Tests cover:

  * one page,
  * multiple pages,
  * empty first page,
  * search endpoint shape,
  * missing Link header,
  * rate-limit error propagation.

---

# Standing moat investments

These are not one-time gaps. They should receive ongoing allocation every cycle.

## Moat 1: Decision provenance

Make every decision queryable by:

* repository,
* actor,
* worker,
* policy rule,
* action type,
* risk level,
* status,
* evidence hash,
* proposal ID,
* receipt ID,
* time window.

## Moat 2: Exportable audit bundles

Every governed action should have an exportable proof package.

Formats:

* JSON.
* Markdown.
* Optional signed artifact.

## Moat 3: Reconciliation

GitWire should continue investing in "does the action still hold?" checks:

* label still exists,
* comment still present,
* branch still deleted,
* PR still merged,
* policy still valid,
* repair still applied,
* post-apply validation still current.

## Moat 4: Receipt portability

Execution receipts could become a product-level specification:

```text
GitWire Execution Receipt v1
```

A portable schema for proving:

* what ran,
* where it ran,
* under what isolation,
* against which source,
* with which artifact,
* under which policy,
* and with which outputs.

## Moat 5: Policy simulation and dry-run proof

Before acting, GitWire should be able to show:

```text
If this policy were enabled, these actions would have been allowed, blocked, or skipped.
```

This helps adoption because teams can evaluate GitWire without risk.

---

# Proposed PR sequence

## v0.20.1-A — Deployment discipline

| PR  | Title                                  | Outcome                                            |
| --- | -------------------------------------- | -------------------------------------------------- |
| #57 | Fail-closed migration entrypoint       | Prevents app startup against stale schema          |
| #58 | Durable Redis compose limits           | Preserves Redis ceiling after recreation           |
| #59 | Health/readiness deployment visibility | Makes drift externally detectable                  |
| #60 | Docker image build + smoke CI gate     | Prevents unbuildable code from merging             |
| #61 | Runbook reconciliation updates         | Makes recovery and release verification repeatable |

## v0.20.1-B / v0.20.2 — Version centralization

| PR  | Title                           | Outcome                                        |
| --- | ------------------------------- | ---------------------------------------------- |
| #62 | Committed build-info fallback   | Fresh clone/tests never miss generated module  |
| #63 | Build-time metadata generation  | Docker/dashboard/backend share version and SHA |
| #64 | Dashboard footer version source | Removes hardcoded stale footer                 |
| #65 | Version drift test              | CI catches future drift                        |

## v0.21.0 — Operational pass-capable executor

| PR  | Title                                | Outcome                               |
| --- | ------------------------------------ | ------------------------------------- |
| #66 | Executor reachability in LXC         | Docker/Podman proven from app runtime |
| #67 | Runtime version symmetric binding    | Tightens receipt/evidence identity    |
| #68 | Production validator image           | Real digest-pinned validation runtime |
| #69 | Backend evidence capture             | Evidence exists for production image  |
| #70 | Docker executor comment correction   | Removes contradictory safety comments |
| #71 | Operational docs for validator image | Makes deployment repeatable           |

## v0.22.0 — Post-apply proof

| PR  | Title                               | Outcome                                         |
| --- | ----------------------------------- | ----------------------------------------------- |
| #72 | Apply operation model               | Explicit apply event and applied ref            |
| #73 | Applied artifact binding            | Proves applied change matches approved artifact |
| #74 | Post-apply source snapshot          | Captures repository state after apply           |
| #75 | Post-apply validation receipt       | Enables `verified_after_apply`                  |
| #76 | Failure/retry/supersede apply paths | Safe operational recovery                       |

## v0.23.0 — Operator UX and audit bundles

| PR  | Title                     | Outcome                             |
| --- | ------------------------- | ----------------------------------- |
| #77 | Repair proposal dashboard | Review queue visible                |
| #78 | Receipt/evidence viewer   | Proof chain visible                 |
| #79 | Approve/reject UI         | Human workflow complete             |
| #80 | Audit bundle export       | Portable evidence                   |
| #81 | Proposal timeline view    | End-to-end lifecycle understandable |

## v0.24.0 — Provider abstraction

| PR  | Title                                   | Outcome                           |
| --- | --------------------------------------- | --------------------------------- |
| #82 | LLM provider interface                  | Vendor boundary introduced        |
| #83 | Anthropic provider wrapper              | Current behavior preserved        |
| #84 | OpenAI-compatible provider              | Enterprise model routing possible |
| #85 | Migrate review services                 | First production migration        |
| #86 | Migrate issue/triage/embedding services | Provider abstraction complete     |

---

# Priority rules

When choosing what to do next, use this order:

1. Does it prevent production drift or unsafe startup?
2. Does it prevent unbuildable or unbootable code from merging?
3. Does it close a proof-chain gap?
4. Does it make the flagship repair path operational?
5. Does it improve auditability?
6. Does it reduce enterprise adoption friction?
7. Does it improve evaluator trust?
8. Does it improve competitor parity?
9. Does it reduce maintenance cost?

---

# Current recommended next action

Start with:

```text
branch: v0201/deployment-discipline
release: v0.20.1-A
scope: fail-closed migration entrypoint + durable Redis compose config
        + health/readiness deployment visibility + Docker build/smoke CI gate
        + runbook updates
```

Do not start executor reachability (Gap 1.0), production validator image (Gap 1),
or any product roadmap work until v0.20.1-A is merged, deployed, and verified.

---

# Success definition

v0.20.1 is successful when this statement is true:

```text
A fresh container rebuild can safely start GitWire against the current
production database without manual migration commands, without losing Redis
memory limits, with externally visible version/schema status, and with CI
preventing unbuildable code from ever reaching master.
```
