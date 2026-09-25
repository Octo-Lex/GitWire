# W1-03 — High-Authority HTTP Route Cutover Implementation Plan

**Status:** implementation artifact under Convergence Execution Plan v0.1  
**Planning baseline:** `master@7034ea504d05a47cc0034219008dfcef79026bf8`  
**Implementation reconciliation baseline:** `master@4cc7ba8ad4d67ee373d50f81189625b1fee870a2`  
**Predecessors:** W1-01 and W1-02 merged  
**Scope owner:** Wave 1 — identity, principal context and blocking authorization

> W1-03 implementation reconciliation corrected the route/method/permission matrix below against the independent protected-surface declarations and consequential-surface manifest on the implementation baseline. The scope remains the same 27 routes across the same six families; this correction removes stale route shapes, permission names and transport examples from the original planning artifact.

## 1. Objective

Cut the designated high-authority HTTP mutation surfaces from observe-only authorization to mechanically blocking authorization, using the authoritative principal/resource context delivered by W1-01 and the controlled authorization outcome delivered by W1-02.

For every route in this plan:

1. derive the principal from server-owned `req.auth`;
2. resolve the exact target resource through the existing declared server-side resolver;
3. evaluate the declared permission through `authorizeControlled()` in `enforced` mode;
4. stop the request before the consequential handler effect when authorization blocks or enforcement plumbing cannot establish a durable decision;
5. retain decision evidence with `observe_mode=false` for enforced evaluation; and
6. preserve existing product semantics on allowed requests.

This artifact materializes the existing W1-03 contract. It does **not** add a programme gate or change Wave 1 scope.

## 2. Frozen scope and boundaries

### In scope

Exactly 27 high-authority HTTP surfaces:

- 4 maintainer collaborator/branch-protection/settings writers;
- 2 waiver grant/revoke routes;
- 5 enforcement policy/suppression/run controls;
- 3 quality-gate definition/evaluation controls;
- 6 Phase-2 merge-queue/feedback controls; and
- 7 Phase-3 flaky/reconciler/dependency/vulnerability controls.

### Explicitly out of scope

- Worker execution cutover; that remains W1-04.
- Policy-authority/promotion redesign; that remains Wave 2.
- Canonical mutation commands, executor convergence, receipts, CAS/idempotency and reconciliation; those remain Wave 3.
- Role/permission redesign or new permissions.
- Resource-schema redesign.
- Handler business-logic redesign.
- Global enforcement of every protected HTTP route.
- Production deployment or final production cutover authority.

The two existing triage mutation routes remain handler-enforced and must not be double-authorized by the central middleware:

- `POST /api/triage/failures/:jobId/disposition`
- `POST /api/triage/failures/:jobId/retry`

## 3. Frozen authority invariants

W1-03 is complete only if the following hold on all 27 surfaces:

- **Server-owned principal:** caller body/query/header actor metadata never becomes authorization authority.
- **Exact resource:** the declared resolver establishes the canonical database-backed repository/installation/fleet resource before authorization.
- **Declared permission:** permission comes from the protected-surface declaration, never the caller.
- **Blocking deny:** a denied enforced outcome prevents downstream handler execution.
- **Fail closed:** resource-resolution, controlled-authorization, invalid-control-output or required evidence-persistence failure cannot fall through into mutation.
- **Evidence truth:** enforced decisions persist with `observe_mode=false`; observe-only compatibility paths retain observe truth.
- **Allowed-path compatibility:** an allowed request reaches the existing handler with canonical authority context and without duplicate route-local evaluation.
- **No accidental expansion:** routes outside the exact W1-03 set keep their pre-W1-03 behavior.

## 4. Corrected exact route cutover matrix

`Current` is `observe` for all 27 routes on the implementation baseline. `Target` is central `enforced` authorization before handler execution.

| # | Family | Method | Route | Permission | Canonical resource resolution | Current | Target |
|---:|---|---|---|---|---|---|---|
| 1 | Maintainer | PUT | `/api/maintainer/collaborators/:owner/:repo/:login` | `repository:github:act` | owner/repo -> repositories | observe | central enforced |
| 2 | Maintainer | DELETE | `/api/maintainer/collaborators/:owner/:repo/:login` | `repository:github:act` | owner/repo -> repositories | observe | central enforced |
| 3 | Maintainer | PUT | `/api/maintainer/branch-rules/:owner/:repo/:pattern` | `repository:github:act` | owner/repo -> repositories | observe | central enforced |
| 4 | Maintainer | PATCH | `/api/maintainer/:owner/:repo/settings` | `repository:update` | owner/repo -> repositories | observe | central enforced |
| 5 | Waivers | POST | `/api/waivers` | `repository:update` | body repo -> repositories | observe | central enforced |
| 6 | Waivers | DELETE | `/api/waivers/:id` | `repository:update` | waiver id -> waivers.repo_id -> repositories | observe | central enforced |
| 7 | Enforcement | POST | `/api/enforcement/policies` | `repository:update` | body installation_id or repo_filter -> installation | observe | central enforced |
| 8 | Enforcement | PUT | `/api/enforcement/policies/:id` | `repository:update` | policy id -> policy_definitions.installation_id | observe | central enforced |
| 9 | Enforcement | DELETE | `/api/enforcement/policies/:id` | `repository:update` | policy id -> policy_definitions.installation_id | observe | central enforced |
| 10 | Enforcement | POST | `/api/enforcement/violations/:id/suppress` | `repository:update` | violation id -> enforcement_violations.repo_id | observe | central enforced |
| 11 | Enforcement | POST | `/api/enforcement/run` | `repository:github:act` | optional body.repo -> repository; otherwise fleet | observe | central enforced |
| 12 | Gates | POST | `/api/gates/:owner/:repo` | `repository:update` | owner/repo -> repositories | observe | central enforced |
| 13 | Gates | DELETE | `/api/gates/:owner/:repo/:name` | `repository:update` | owner/repo -> repositories | observe | central enforced |
| 14 | Gates | POST | `/api/gates/:owner/:repo/evaluate` | `quality_gate:evaluate` | owner/repo -> repositories | observe | central enforced |
| 15 | Phase 2 | POST | `/api/phase2/queue/:owner/:repo/config` | `merge_queue_entry:update` | owner/repo -> repositories | observe | central enforced |
| 16 | Phase 2 | POST | `/api/phase2/queue/:owner/:repo/:pr/admit` | `merge_queue_entry:update` | owner/repo -> repositories | observe | central enforced |
| 17 | Phase 2 | POST | `/api/phase2/queue/:owner/:repo/:pr/remove` | `merge_queue_entry:update` | owner/repo -> repositories | observe | central enforced |
| 18 | Phase 2 | POST | `/api/phase2/feedback` | `repository:update` | body installation_id or repo_filter -> installation | observe | central enforced |
| 19 | Phase 2 | PUT | `/api/phase2/feedback/:id` | `repository:update` | feedback rule id -> installation | observe | central enforced |
| 20 | Phase 2 | DELETE | `/api/phase2/feedback/:id` | `repository:update` | feedback rule id -> installation | observe | central enforced |
| 21 | Phase 3 | POST | `/api/phase3/flaky/:id/graduate` | `repository:update` | flaky test id -> flaky_tests.repo_id | observe | central enforced |
| 22 | Phase 3 | POST | `/api/phase3/flaky/:id/dismiss` | `repository:update` | flaky test id -> flaky_tests.repo_id | observe | central enforced |
| 23 | Phase 3 | POST | `/api/phase3/reconciler/run` | `installation:read` | optional body.repo -> repository; otherwise fleet | observe | central enforced |
| 24 | Phase 3 | PUT | `/api/phase3/reconciler/repos/:owner/:repo` | `repository:update` | owner/repo -> repositories | observe | central enforced |
| 25 | Phase 3 | POST | `/api/phase3/dependencies/:owner/:repo/scan` | `repository:update` | owner/repo -> repositories | observe | central enforced |
| 26 | Phase 3 | POST | `/api/phase3/dependencies/:owner/:repo/batch-pr` | `repository:github:act` | owner/repo -> repositories | observe | central enforced |
| 27 | Phase 3 | POST | `/api/phase3/dependencies/vuln/:id/dismiss` | `repository:update` | vulnerability id -> vulnerability_advisories.repo_id | observe | central enforced |

The route IDs used in code are the canonical `route:<METHOD>:<full path>` IDs produced by the protected-surface registry.

## 5. Target implementation shape

### 5.1 Separate authorization mode from enforcement owner

Maintain two explicit exact-ID sets:

- `HANDLER_ENFORCED_ROUTE_SURFACE_IDS` — exactly the two triage routes;
- `CENTRALLY_ENFORCED_ROUTE_SURFACE_IDS` — exactly the 27 routes in section 4.

`routeAuthorizationMode(id)` returns canonical W1-02 `AuthorizationMode.ENFORCED` for their union. Separate ownership helpers tell `routeAuthObserver` whether transport blocking belongs to central middleware or the handler. Do not introduce a third authorization mode token.

### 5.2 Central route middleware

For a centrally enforced declaration:

1. match using the existing Express-compatible case-insensitive/non-strict path semantics;
2. resolve path parameters exactly once and call `resolveRouteResource()` using the declared resolver;
3. bind immutable `req.authority` from `req.auth`, the canonical resource and surface ID;
4. invoke:

   `authorizeControlled({ principal, permission, resource, mode: AuthorizationMode.ENFORCED })`;

5. require enforced decision evidence to be persisted before an allowed request can proceed;
6. cache the persisted decision in the existing `_wave2DeclarationObserved` / `_wave2DeclarationDecision` compatibility state;
7. on a normal policy denial, return `403 {"error":"Forbidden","code":decision.code}` and do not call `next()`;
8. on resource-resolution, authorization-control, invalid-outcome or required evidence-persistence failure, return a generic `503 {"error":"Authorization unavailable"}` and do not call `next()`;
9. on a persisted allowed outcome, call `next()` exactly once.

For an observe-only declaration, preserve current nonblocking behavior, including nonfatal observation failures.

For a handler-enforced triage declaration, delegate directly to the existing handler and do not run a second central authorization evaluation.

### 5.3 Existing route-local compatibility helpers

Do not rewrite the 27 business handlers merely to remove their existing `observeAuthorize()` calls. The central middleware populates the existing declaration-decision cache on an allowed persisted request. `observeAuthorize()` reuses that decision only when permission and normalized resource identity match; a mismatch continues to evaluate normally.

### 5.4 Resource authority

Keep the D0-04/W1-01 resolver model intact:

- path/body/query values are selectors, not authority;
- database lookup produces canonical resource identity;
- missing/unknown repository or installation identity cannot authorize;
- waiver/policy/violation/feedback/flaky/vulnerability IDs are rebound through server-owned records;
- optional repository/fleet routes authorize the exact selected execution resource.

No W1-03 code may authorize against raw caller-supplied identity when a canonical resolver exists.

## 6. Expected code delta

Production changes remain concentrated in:

- `packages/web/src/services/auth/routeAuthorizationModes.js`
  - exact handler and central enforcement sets;
  - enforced union;
  - deterministic ownership helpers.
- `packages/web/src/middleware/routeAuthObserver.js`
  - central enforced authorization;
  - fail-closed transport;
  - evidence-persistence gate;
  - compatibility decision caching;
  - preserved observe and triage behavior.

Tests live under the repository's actual test root, `packages/web/tests/unit/`.

The 27 route modules are not expected to require production changes. Expanding into widespread handler edits requires concrete evidence that the shared seam is insufficient.

## 7. Verification plan

### 7.1 Exact-set and classification

Prove independently that:

- the central set is exactly the 27 IDs in section 4;
- the handler set is exactly the two triage IDs;
- the sets are disjoint;
- declarations report `enforced` for the 29-route union;
- every other protected HTTP declaration remains `observe`.

The expected list in the test must be independently frozen rather than derived from the implementation array.

### 7.2 Central middleware behavior

Prove:

- allowed central route binds canonical authority, calls `authorizeControlled(... mode: enforced)`, caches the persisted decision and calls `next()` once;
- denied central route returns the established 403 shape and never calls `next()`;
- unresolved/resource-resolution failure cannot reach `authorizeControlled()` or the handler;
- authorization-control/evidence failure cannot reach the handler;
- observe-only failure remains nonblocking;
- handler-owned triage delegates without duplicate evaluation;
- centrally enforced paths retain case-insensitive/trailing-slash matching.

### 7.3 Family-level pre-effect denial

For each of Maintainer, Waivers, Enforcement, Gates, Phase 2 and Phase 3, execute a representative centrally enforced path with a denied controlled outcome and use the middleware's downstream `next` sentinel to prove no downstream handler/effect chain is entered. Because the common middleware is mechanically upstream of every matched family route, this is the direct pre-effect proof without duplicating 27 heavyweight route integration tests.

### 7.4 Evidence and resource security

Retain W1-01/W1-02/D0-04 tests that prove:

- server-owned principal/context binding;
- canonical resolver behavior and spoof resistance;
- `observe_mode=false` persistence for enforced allow/deny outcomes;
- unknown resources deny rather than authorize from caller-supplied names;
- route-local observation reuses only an exact permission/resource declaration decision.

### 7.5 Regression suite

The protected-surface completeness tests, route path-semantics tests, source-sensitive decision-log writer audit and relevant W1-01/W1-02/D0-04 suites must remain green.

## 8. Implementation order

Use one bounded W1-03 implementation PR unless repository rules or concrete review evidence require a successor PR:

1. classification foundation;
2. central blocking seam;
3. exact-set and family denial proof;
4. resource/evidence/path regression proof;
5. exact-head review and CI closure.

Partial implementation is not W1-03 completion.

## 9. Review and merge gate

For the exact implementation head:

1. first-party review of the complete W1-03 delta;
2. correct concrete evidence-backed findings without expanding scope;
3. request Codex/repository automated review on the corrected exact head (or use the authorized first-party substitute if Codex quota is unavailable);
4. require normal exact-head CI, DCO and CodeQL checks to pass;
5. reconcile findings against source/tests rather than treating advisory text as an automatic blocker;
6. merge only when section 10 is demonstrated.

No separate acceptance gate is introduced by this document.

## 10. Closure criteria

W1-03 closes when all of the following are true on the merged implementation:

- exactly the 27 routes in section 4 are centrally enforced;
- the two triage routes remain handler-enforced without duplicate evaluation;
- each central request uses server-owned principal context and canonical resolved resource;
- denied authorization stops request progression before the consequential handler effect;
- resolution/control/evidence failure cannot fall through into mutation;
- allowed requests retain product behavior and route-local compatibility helpers reuse the central decision;
- enforced evidence records correct mode/resource/principal/permission truth;
- observe-only routes outside the exact set remain nonblocking;
- relevant W1-01/W1-02/D0-04 regressions remain green; and
- exact-head repository-required CI/DCO/CodeQL and review evidence have no unresolved concrete blocker.

## 11. Rollback

W1-03 requires no destructive schema change. A bounded behavioral rollback removes the 27 central-enforcement ownership entries while preserving W1-01 authoritative context, W1-02 controlled authorization, historical decision evidence, protected-surface/resource declarations and the two handler-owned triage gates.

## 12. Completion handoff

After W1-03 is merged and its closure criteria pass, the next authorized Wave 1 unit is **W1-04 worker cutover**. W1-04 is not part of W1-03 and must not be started implicitly by W1-03 closure.
