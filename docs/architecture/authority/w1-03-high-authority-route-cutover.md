# W1-03 — High-Authority HTTP Route Cutover Implementation Plan

**Status:** execution-ready implementation artifact under Convergence Execution Plan v0.1  
**Baseline:** `master@7034ea504d05a47cc0034219008dfcef79026bf8`  
**Predecessors:** W1-01 and W1-02 merged  
**Scope owner:** Wave 1 — identity, principal context and blocking authorization

## 1. Objective

Cut the designated high-authority HTTP mutation surfaces from observe-only authorization to mechanically blocking authorization, using the authoritative principal/resource context delivered by W1-01 and the controlled authorization outcome delivered by W1-02.

For every route in this plan:

1. derive the principal from server-owned authentication context;
2. resolve the exact target resource through the existing declared server-side resolver;
3. evaluate the declared permission through the central authorization service in `enforced` mode;
4. stop the request before the consequential handler effect when the authorization outcome is blocked;
5. retain decision evidence with the correct enforced/observe mode truth; and
6. preserve existing product semantics on allowed requests.

This artifact materializes the existing W1-03 contract. It does **not** add a programme gate or change Wave 1 acceptance criteria.

## 2. Frozen scope and boundaries

### In scope

The exact W1-03 route set is the 27 high-authority HTTP surfaces below, derived from the protected-surface/mutation manifest on the baseline commit:

- maintainer collaborator/branch-protection/settings writers;
- waiver grant/revoke;
- enforcement policy/suppression/run controls;
- quality-gate definition/evaluation controls;
- Phase-2 merge-queue and feedback-rule control writers; and
- Phase-3 flaky/reconciler/dependency/vulnerability control writers.

### Explicitly out of scope

- Worker execution cutover. Issue-fix, merge-queue workers, maintainer workers, Phase-3 workers and scheduled reconciliation remain W1-04.
- Policy-authority/promotion redesign. That remains Wave 2.
- Canonical mutation commands, executor convergence, receipts, CAS/idempotency and reconciliation. Those remain Wave 3.
- Role/permission redesign or new permissions.
- Resource-schema redesign.
- Handler business-logic redesign.
- Attribution cleanup unrelated to the authority decision itself.
- Global enforcement of every protected HTTP route.
- Production deployment or final production cutover authority.

The two existing triage mutation routes remain handler-enforced and are not reimplemented by W1-03:

- `POST /api/triage/failures/:jobId/disposition`
- `POST /api/triage/failures/:jobId/retry`

Their existing handler-local enforcement remains the compatibility reference and must not be double-authorized by the central middleware.

## 3. Frozen authority invariants

W1-03 is complete only if the following already-authorized Wave 1 invariants hold on all 27 surfaces:

- **Server-owned principal:** request metadata, body fields, actor strings or installation fields do not become authorization authority.
- **Exact resource:** the declared resolver returns the canonical database-backed repository/installation/fleet resource before authorization.
- **Declared permission:** the permission comes from the protected-surface declaration, not from the caller.
- **Blocking deny:** a denied central outcome prevents `next()` from reaching the consequential handler effect.
- **Fail closed:** resource-resolution or authorization-control failure on a centrally enforced route cannot fall through into the mutation handler.
- **Evidence truth:** enforced decisions persist as enforced (`observe_mode=false`); observe-only compatibility paths retain observe truth.
- **Allowed-path compatibility:** an allowed request reaches the existing handler with canonical authority context and no duplicate authorization evaluation.
- **No accidental expansion:** routes not named in the W1-03 exact set keep their pre-W1-03 authorization behavior.

## 4. Exact route cutover matrix

`Current` is `observe` for all 27 routes on the baseline. `Target` is central `enforced` authorization before handler execution.

| # | Family | Method | Route | Permission | Canonical resource resolution | Current | Target |
|---:|---|---|---|---|---|---|---|
| 1 | Maintainer | PUT | `/api/maintainer/repos/:owner/:repo/collaborators/:username` | `maintainer:admin` | repository from path owner/repo | observe | central enforced |
| 2 | Maintainer | DELETE | `/api/maintainer/repos/:owner/:repo/collaborators/:username` | `maintainer:admin` | repository from path owner/repo | observe | central enforced |
| 3 | Maintainer | PUT | `/api/maintainer/repos/:owner/:repo/branches/:branch/protection` | `maintainer:admin` | repository from path owner/repo | observe | central enforced |
| 4 | Maintainer | PATCH | `/api/maintainer/repos/:owner/:repo/settings` | `repository:update` | repository from path owner/repo | observe | central enforced |
| 5 | Waivers | POST | `/api/waivers` | `repository:update` | repository from request repo selector, rebound through `repositories` | observe | central enforced |
| 6 | Waivers | DELETE | `/api/waivers/:id` | `repository:update` | waiver id -> canonical repository | observe | central enforced |
| 7 | Enforcement | POST | `/api/enforcement/policies` | `repository:update` | request installation/repo selector -> canonical installation/repository state | observe | central enforced |
| 8 | Enforcement | PUT | `/api/enforcement/policies/:id` | `repository:update` | policy id -> canonical installation | observe | central enforced |
| 9 | Enforcement | DELETE | `/api/enforcement/policies/:id` | `repository:update` | policy id -> canonical installation | observe | central enforced |
| 10 | Enforcement | POST | `/api/enforcement/violations/:id/suppress` | `repository:update` | violation id -> canonical repository | observe | central enforced |
| 11 | Enforcement | POST | `/api/enforcement/run` | `maintainer:admin` | body repo when present -> canonical repository; otherwise fleet | observe | central enforced |
| 12 | Gates | POST | `/api/gates/:owner/:repo/definitions` | `repository:update` | repository from path owner/repo | observe | central enforced |
| 13 | Gates | DELETE | `/api/gates/:owner/:repo/definitions/:gateName` | `repository:update` | repository from path owner/repo | observe | central enforced |
| 14 | Gates | POST | `/api/gates/:owner/:repo/evaluate` | `repository:read` | repository from path owner/repo | observe | central enforced |
| 15 | Phase 2 | PUT | `/api/phase2/queue/:owner/:repo/config` | `merge_queue:admin` | repository from path owner/repo | observe | central enforced |
| 16 | Phase 2 | POST | `/api/phase2/queue/:owner/:repo/admit/:pr` | `merge_queue:admin` | repository from path owner/repo | observe | central enforced |
| 17 | Phase 2 | DELETE | `/api/phase2/queue/:owner/:repo/entries/:id` | `merge_queue:admin` | repository from path owner/repo | observe | central enforced |
| 18 | Phase 2 | POST | `/api/phase2/feedback/rules` | `repository:update` | request installation/repo selector -> canonical installation/repository state | observe | central enforced |
| 19 | Phase 2 | PUT | `/api/phase2/feedback/rules/:id` | `repository:update` | feedback-rule id -> canonical installation | observe | central enforced |
| 20 | Phase 2 | DELETE | `/api/phase2/feedback/rules/:id` | `repository:update` | feedback-rule id -> canonical installation | observe | central enforced |
| 21 | Phase 3 | POST | `/api/phase3/flaky/:id/graduate` | `repository:update` | flaky-test id -> canonical repository | observe | central enforced |
| 22 | Phase 3 | POST | `/api/phase3/flaky/:id/dismiss` | `repository:update` | flaky-test id -> canonical repository | observe | central enforced |
| 23 | Phase 3 | POST | `/api/phase3/reconciler/run` | `system:admin` | optional repository selector -> canonical repository; otherwise fleet | observe | central enforced |
| 24 | Phase 3 | PUT | `/api/phase3/reconciler/repos/:owner/:repo` | `repository:update` | repository from path owner/repo | observe | central enforced |
| 25 | Phase 3 | POST | `/api/phase3/dependencies/:owner/:repo/scan` | `repository:update` | repository from path owner/repo | observe | central enforced |
| 26 | Phase 3 | POST | `/api/phase3/dependencies/:owner/:repo/batch-pr` | `maintainer:admin` | repository from path owner/repo | observe | central enforced |
| 27 | Phase 3 | POST | `/api/phase3/vulnerabilities/:id/dismiss` | `repository:update` | vulnerability id -> canonical repository | observe | central enforced |

The route IDs used in code remain the canonical `route:<METHOD>:<full path>` IDs already produced by the protected-surface registry.

## 5. Target implementation shape

### 5.1 Separate authorization mode from enforcement owner

The current route-mode registry marks only the two triage routes `enforced`, and the global route middleware deliberately delegates those routes to their handlers. W1-03 must not overload that delegation rule.

Use two explicit exact-ID sets (or an equivalent structure with the same semantics):

- `HANDLER_ENFORCED_ROUTE_SURFACE_IDS` — the two existing triage routes;
- `CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS` — exactly the 27 W1-03 routes.

`authorizationModeForRouteId(id)` may continue to return the canonical W1-02 `AuthorizationMode.ENFORCED` value for the union. A separate ownership/classification helper must let `routeAuthObserver` distinguish central enforcement from handler-owned enforcement.

Do not introduce a third authorization mode token. `observe` and `enforced` remain the canonical decision modes from W1-02; ownership describes where transport blocking occurs.

### 5.2 Central route middleware

Refactor the existing declaration authorization path in `routeAuthObserver.js` so it can execute the same authoritative context resolution in either observe or enforced mode.

For a centrally enforced declaration:

1. match the protected route using the existing Express-compatible path semantics;
2. build/bind the immutable request authority context from `req.auth`, the declaration and `resolveRouteResource()`;
3. invoke `authorizeControlled(input, { mode: AuthorizationMode.ENFORCED })`;
4. cache the resulting decision on the request using the existing compatibility markers so route-local `observeAuthorize()` calls reuse the central decision rather than evaluate again;
5. when `outcome.blocked === true`, return HTTP `403` with the established body `{"error":"insufficient_permissions"}` and do not call `next()`;
6. when allowed, call `next()` exactly once;
7. if authoritative resource resolution or the enforcement plumbing itself fails, fail closed before `next()` and emit the existing safe/generic transport error appropriate to the failure class; never downgrade to observe behavior.

For an observe-only declaration, preserve current nonblocking behavior, including nonfatal observation failures.

For a handler-enforced triage declaration, preserve delegation to the existing handler and do not run a second central authorization evaluation.

### 5.3 Existing route-local compatibility helpers

The 27 handlers already use `observeAuthorize()` on the relevant mutation paths. Do not rewrite the business handlers merely to remove those calls.

The central middleware must populate the existing `_wave2DeclarationObserved` / `_wave2DeclarationDecision` compatibility state before continuing an allowed W1-03 request. `observeAuthorize()` will then reuse the already-evaluated decision.

Only change an individual handler if a defect-sensitive test demonstrates that the compatibility path cannot preserve exactly-once authorization or pre-effect blocking.

### 5.4 Resource authority

Keep the D0-04/W1-01 resolver model intact:

- path/body/query values are selectors, not authority;
- database lookup produces the canonical resource identity;
- a missing, ambiguous or invalid required resource cannot authorize;
- IDs for waiver, enforcement policy, violation, feedback rule, flaky test and vulnerability must be rebound through their server-owned records before permission evaluation;
- optional repository/fleet routes must authorize against the exact resource mode actually selected for execution.

No W1-03 code may authorize against a raw caller-supplied repository, installation, actor or resource ID when a canonical resolver exists.

## 6. Expected code delta

The preferred minimal production delta is concentrated in the authorization seam:

- `packages/web/src/services/auth/routeAuthorizationModes.js`
  - freeze the exact central-enforcement set;
  - retain the two handler-enforced triage IDs;
  - expose deterministic ownership/classification helpers.
- `packages/web/src/middleware/routeAuthObserver.js`
  - call `authorizeControlled()` for centrally enforced routes;
  - fail closed before the handler on blocked/unresolved enforcement;
  - cache the central decision/authority context for compatibility helpers;
  - preserve observe-only and handler-enforced behavior.

Expected tests will update/add files under `packages/web/src/__tests__/` for route-mode classification, observer enforcement semantics, resource-spoof negatives and route-family cutover coverage.

The 27 route modules are **not expected to require production changes**. If implementation requires widespread handler edits, stop and demonstrate why the shared middleware seam is insufficient before expanding the blast radius.

## 7. Verification plan

### 7.1 Exact-set and classification tests

Add a source-sensitive/table-driven test that asserts:

- the centrally enforced route ID set is exactly the 27 IDs in this plan;
- no additional route is silently included;
- both triage IDs remain handler-enforced;
- protected declarations report `enforced` mode for the union of central + handler-enforced routes;
- all other protected route declarations retain observe mode.

The expected W1-03 set must be independent enough to catch an accidental omission from the implementation set; do not derive the expected list from the list under test.

### 7.2 Central middleware behavior

Prove, at minimum:

- **allowed central route:** canonical authority context is bound, `authorizeControlled(..., enforced)` is called, the decision is cached, and `next()` is called once;
- **denied central route:** response is `403 {"error":"insufficient_permissions"}`, `next()` is not called and the handler/effect cannot execute;
- **resolution failure:** `next()` is not called and no handler/effect executes;
- **observe route:** behavior remains nonblocking and observation failure remains nonfatal;
- **handler-enforced triage:** middleware delegates without a duplicate authorization call;
- **path semantics:** existing case-insensitive/trailing-slash matching remains intact on centrally enforced paths.

### 7.3 Decision-evidence integration

For a representative centrally enforced route, verify the persisted authorization evidence contains the server-derived principal, declared permission and canonical resource and records `observe_mode=false` for both allow and deny outcomes.

W1-02 unit tests remain the canonical transport-neutral mode tests; W1-03 adds the HTTP integration proof.

### 7.4 Resource-spoof/security-negative coverage

Use table-driven or representative defect-sensitive tests across the resolver classes used by W1-03:

- path owner/repo resolves the server-owned repository and cannot be replaced by body identity;
- waiver id resolves its owning repository;
- policy/feedback-rule id resolves its owning installation;
- violation/flaky/vulnerability id resolves its owning repository;
- a wrong repository/installation selection cannot authorize a different canonical resource;
- unresolved/cross-resource IDs fail closed;
- `enforcement/run` and `phase3/reconciler/run` distinguish repository-scoped execution from fleet execution and authorize the selected resource.

### 7.5 Family-level pre-effect denial proof

For each route family (Maintainer, Waivers, Enforcement, Gates, Phase 2, Phase 3), include at least one test in which authorization is denied and a spy on the family's consequential handler dependency proves the effect is not invoked.

The exact-set middleware test establishes coverage for all 27 route IDs; family-level tests establish that the middleware is actually upstream of representative effects. Avoid duplicating 27 heavyweight integration tests where the same centralized mechanism is already mechanically proven.

### 7.6 Regression suite

The existing D0-04 protected-surface completeness tests, W1-01 authority-context tests, W1-02 controlled-authorization tests, route path-semantics tests and source-sensitive decision-log writer audit must remain green.

## 8. Implementation order

Use one bounded W1-03 implementation PR unless concrete evidence requires a split. Within that PR, keep reviewable commits in this order:

1. **Classification foundation** — add explicit central-vs-handler enforcement ownership and exact-set tests; no route behavior changes yet.
2. **Central blocking seam** — wire `authorizeControlled(..., enforced)` into `routeAuthObserver`, including fail-closed transport and cached decision reuse.
3. **Maintainer + Waiver cutover proof** — exercise collaborator/branch/settings and waiver resolver/effect boundaries.
4. **Enforcement + Gates proof** — exercise installation/repository/fleet resolution and pre-effect blocking.
5. **Phase-2 proof** — exercise merge-queue controls and feedback-rule installation binding.
6. **Phase-3 proof** — exercise flaky/reconciler/dependency/vulnerability resource paths.
7. **Closure regression** — exact 27-route classification, complete relevant suites and no scope expansion.

A multi-PR implementation is allowed only if repository rules or concrete review evidence require it. If split, W1-03 remains open until the complete 27-route set satisfies the closure criteria; partial merges are not W1-03 completion.

## 9. Review and merge gate

For the exact implementation head:

1. first-party review of the complete W1-03 delta;
2. correct any concrete evidence-backed finding without expanding scope;
3. request Codex/repository automated review on the corrected exact head;
4. require the repository's normal exact-head CI, DCO and CodeQL checks to pass;
5. reconcile automated findings against source/tests rather than treating advisory text as an automatic blocker;
6. merge only when the closure criteria below are demonstrated.

No separate acceptance gate is introduced by this document.

## 10. Closure criteria

W1-03 closes when all of the following are true on the merged implementation:

- exactly the 27 routes in section 4 are classified for central enforced authorization;
- the two existing triage routes remain handler-enforced without duplicate evaluation;
- each centrally enforced request uses server-owned principal context and a canonical resolved resource;
- a denied authorization outcome stops request progression before the consequential handler effect;
- resource-resolution/enforcement failure cannot fall through into mutation;
- allowed requests retain existing product behavior and route-local compatibility helpers reuse the central decision;
- enforced decision evidence records the correct mode/resource/principal/permission truth;
- observe-only routes outside the exact cutover set remain nonblocking;
- protected-surface completeness and the relevant W1-01/W1-02/D0-04 regression suites remain green; and
- exact-head repository-required CI/DCO/CodeQL and review evidence are reconciled with no concrete unresolved blocker.

These are implementation proofs of the existing Wave 1 acceptance conditions, not new programme-level criteria.

## 11. Rollback

W1-03 requires no destructive schema change.

If the central route cutover must be rolled back before later waves depend on it:

1. revert the 27 routes from central-enforced ownership to observe-only classification;
2. preserve W1-01 authoritative context and W1-02 controlled authorization primitives;
3. preserve existing authorization-decision evidence already written;
4. leave the two triage handler-enforced routes unchanged; and
5. do not weaken or remove the protected-surface/resource declarations.

Rollback is therefore a bounded behavioral revert, not a data rollback.

## 12. Completion handoff

After W1-03 is merged and its closure criteria pass, the next authorized Wave 1 unit is **W1-04 worker cutover**. No worker cutover work is required to claim W1-03 complete, and W1-04 must reuse the same server-owned principal/resource and controlled authorization semantics rather than creating a parallel authority path.
