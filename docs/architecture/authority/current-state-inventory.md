# Current-State Authority Inventory (W0-A)

> Disk-verified map of GitWire's authority surface as of base
> `7b8cdc62b4262b5913dbebaedcb4401f2acef29a`. Every claim cites `file:line`.
> See [`README.md`](./README.md) for methodology, risk-rating key, and scope.

## W0-A review corrections (commit `docs(authority): close W0-A review gaps`)

The first checkpoint at `bf51160` was reviewed and rejected with six blocking
findings. The corrections below supersede the original wording **in place**;
the rest of this document is unchanged from `bf51160` except for the new
appendix sections (§17, §18, §19).

### C-1 — Complete handler inventory (was a placeholder)

§5.2 referred to a "long-form inventory" via a `#` placeholder. The full
173-handler route-file table (plus the app-level `/health` handler) is now in [§17](#17-full-http-handler-inventory). The
aggregate counts in §5.2 stand; the per-handler rows fill the gap.

### C-2 — Complete mutation-sink map (was omitted as "too long")

§7.1 omitted the table-by-writer map with "regenerate by grep." The full
51-table writer map is now in [§18](#18-full-database-writer-map). The count
in §7.1 was also wrong: the verified number is **51 tables**, not 50
(`webhook_deliveries` was missed in the original count). The filesystem-site
count in §7.2 was also wrong: the verified number is **11 sites** (not 8 — several `mkdir`/`writeFileSync` calls in `scripts/` were missed; not 12 — `sourceSnapshotProvider.js` was originally miscounted as a site, but its `fs/promises` imports are dead code that never executes, see C-2-rev). The full filesystem inventory is in [§18.2](#182-filesystem-mutation-sites).
(several `mkdir`/`writeFileSync` calls in `scripts/` were missed). The full
filesystem inventory is in [§18.2](#182-filesystem-mutation-sites).

### C-3 — Verification claims made consistent

F-09 and F-10 were originally marked `HIGH / REPORTED`. After re-verification
with concrete evidence (C-3a, C-3b below), both are upgraded to `VERIFIED`.
This makes the methodology claim ("every CRITICAL and HIGH finding was
independently rechecked") honest.

- **C-3a (F-09 upgrade):** `routes/issues.js:44-75` confirmed — the `GET /api/issues` handler builds its WHERE clause from optional query params
  (`repo`, `priority`, `type`, `state`, `unassigned`, `stale`, `search`) with
  **no installation_id condition** and **no caller-scope filter**. Any API-key
  holder gets every installation's issues by default; `repo` filters by exact
  full name but does not verify the caller's authority over that repo. Same
  shape applies to `pullRequests.js`, `ciRuns.js`, `healHistory.js`,
  `activity.js`, `decisions.js`. VERIFIED.
- **C-3b (F-10 upgrade, re-corrected in W0-A-rev2):** F-10 conflated two distinct authority paths and misstated the gate mechanism. Split:
  - **F-10a (fleet policy reconciler):** `phase3Worker.js:124` enqueues `policy-reconcile-fleet` nightly (`0 2 * * *`). The handler at `:55-58` contains the comment "Gate: enforcement pillar only" but **does not call `isPillarEnabled`** — it directly awaits `runFleetReconciliation("scheduler")`. `policyReconcilerService.js:84-86` iterates every installation and every repository; the per-repo bypass is `policy_repo_configs.reconcile_skip` (a DB column set via `PUT /api/phase3/reconciler/repos/:owner/:repo`), **NOT `.gitwire.yml`** — no `getConfigForRepo` or `isPillarEnabled` check runs on this path. The reconciler then performs GitHub `PUT .../branches/{branch}/protection` (`policyReconcilerService.js:228`), `POST .../labels` (`:263`), and `PATCH /repos/...` (`:278`) on every non-skipped repo on every cron tick, with actor hardcoded `"scheduler"`. No human-in-the-loop. VERIFIED.
  - **F-10b (merge queue, separate path):** the merge queue is **event-driven**, not cron-driven. Jobs arrive via `handlePullRequest.js:50,55`, `handlePullRequestReview.js:7`, `handleCheckSuite.js:7`, `handleWorkflowRun.js:53,56`. `phase2Worker.js:26` gates on `isPillarEnabled("merge_queue", repoConfig)` (a real `.gitwire.yml` pillar check, unlike the reconciler). `mergeQueueService.js:208` performs `PUT .../pulls/{n}/merge` — but only on the front-of-queue entry when eligibility checks pass; it does not execute on every reconciliation cron tick. F-10b's risk profile is materially different from F-10a's and should not have been bundled.

### C-4 — F-11 mechanism correction

The original §10/§13 F-11 wording said the audit chain "is computed at write
time under a Redis lock (`auditTrailService.js`)." **That is factually
wrong.** The code at `auditTrailService.js:59-78` performs an unsynchronized
`SELECT payload_hash FROM audit_trail_entries ORDER BY seq DESC LIMIT 1`
(line 59), then a separate `INSERT` (line 63). The module imports no Redis
client and acquires no lock. Two concurrent writers can both read the same
`prev_hash` and produce a forked chain. The race finding stands; the stated
mechanism is corrected here. §13's F-11 row and §10's prose are superseded
by this correction.

### C-5 — Severity re-rating

| ID | Original | Corrected | Reason |
|---|---|---|---|
| **F-02** | CRITICAL | **HIGH** | The reviewer's point: under the current shared-key model, every API-key holder already has fleet-wide authority, so `revokeWaiver(id)` is not crossing an existing tenant-scoped caller boundary — it is a global-admin/IDOR *design gap* that becomes exploitable only once per-caller identity exists. Still serious; not CRITICAL against today's trust model. |
| **F-04** | HIGH | **LOW** | The executor-service is private-compose-network-only by design (`server.js:38-41` comment; `docker-compose.yml:67+` exposes no ports). The non-constant-time compare is defense-in-depth hardening, not a HIGH finding. No timing oracle is demonstrated. |
| **F-06** | CRITICAL | **HIGH** | The defect has CRITICAL impact in principle, but exploitation requires Redis write access, and Redis is documented as internal-Docker-network-only (`security.md:58,69`). Without a demonstrated reachable injection vector, HIGH is the honest rating. Upgrade back to CRITICAL if a reachable vector is established. |
| **F-05** | HIGH (wording) | HIGH (reworded) | Original said "replayed-and-resigned delivery." The realistic attack is GitHub's own **redelivery** of an already-valid signed request (same payload, same signature, same `X-GitHub-Delivery`), or capture-and-replay of a valid signed body by anyone who observed it. Re-signing requires the secret, which collapses into F-01. Reworded in §13. |
| **F-07** | HIGH (framing) | HIGH (reframed) | Original framed downstream non-reverification as an independent bypass. The accurate framing is **provenance loss dependent on the F-06 queue-trust defect**: the role check at `commentRouter.js:27` is discarded when the job is enqueued, so once a job is in the queue (via F-06 or otherwise), the worker executes it with the App's authority regardless of the original author's role. The role check exists only on the HTTP ingress path. |

Net severity change after corrections: 2 CRITICAL → 1 CRITICAL + 1 HIGH; 5 HIGH → 1 LOW + 4 HIGH (with one reworded and one reframed).

### C-6 — Source-of-truth discrepancy matrix (`docs/architecture/security.md`)

The existing [`docs/architecture/security.md`](../security.md) describes the
intended model. Four specific claims diverge from current code. The full
matrix is in [§19](#19-securitymd-discrepancy-matrix).

---

## Table of contents

1. [Principal taxonomy](#1-principal-taxonomy)
2. [Authentication mechanisms](#2-authentication-mechanisms)
3. [Authorization decision sites](#3-authorization-decision-sites)
4. [Tenancy model](#4-tenancy-model)
5. [HTTP surface](#5-http-surface)
6. [Worker and background surface](#6-worker-and-background-surface)
7. [Database and filesystem mutation sinks](#7-database-and-filesystem-mutation-sinks)
8. [Service-to-service trust](#8-service-to-service-trust)
9. [GitHub App installation authority](#9-github-app-installation-authority)
10. [Audit trail coverage](#10-audit-trail-coverage)
11. [Scripts and administrative paths](#11-scripts-and-administrative-paths)
12. [Principal → action → resource → enforcement → sink matrix](#12-principal--action--resource--enforcement--sink-matrix)
13. [Findings, ranked](#13-findings-ranked)
14. [Disputed findings](#14-disputed-findings)
15. [Unknowns and unresolved questions](#15-unknowns-and-unresolved-questions)
16. [Coverage accounting](#16-coverage-accounting)
17. [Full HTTP handler inventory (W0-A correction C-1)](#17-full-http-handler-inventory)
18. [Full table inventory and known-writer map (W0-A correction C-2)](#18-full-table-inventory-and-known-writer-map)
19. [`security.md` discrepancy matrix (W0-A correction C-6)](#19-securitymd-discrepancy-matrix)

---

## 1. Principal taxonomy

| ID | Principal type | Defined at | Authenticated by | Authority scope |
|---|---|---|---|---|
| P-1 | **Human dashboard user** | implicit (no `users` table) | Possession of the shared API key OR a live `gitwire-session` cookie (`middleware/auth.js:64-105`) | Superuser across **all** installations (no per-tenant, per-repo, or per-action scoping) |
| P-2 | **GitHub App** (machine identity) | `packages/runtime/src/create-github.js:23-31` | App private key + appId (env-loaded) | App-level — can mint installation tokens for every installation the App is installed on |
| P-3 | **GitHub App installation** (per-org/per-repo scope) | `getInstallationClient(installationId)` `create-github.js:47-49` | App-signed JWT exchanged for installation token | Installation-wide — every repo the installation can access, with every permission the App was granted. No per-repo token narrowing. |
| P-4 | **Background worker** (acting as P-3) | every worker that calls `getInstallationClient` | Trust-the-payload: `job.data.payload.installation.id` is the only basis for minting the token | Equal to the installation whose id the job carries. **No replay of the webhook signature** binds the job to a verified delivery. |
| P-5 | **`gitwire[bot]`** (the App's bot user on GitHub) | hardcoded actor string in audit writes | Inherits from P-3 | Used for attribution when a worker performs a GitHub mutation. |
| P-6 | **executor-service** | `packages/executor-service/src/server.js:42-52` | `Bearer ${service_token}` env var (non-constant-time compare) | Minimum in the system: no DB, no GitHub, no network egress. Runs an allowlisted subset of `npm` commands in a `--network=none --read-only` container. |
| P-7 | **Operator running a script** | `scripts/*.js`, `scripts/*.sh` | None — env-provided credentials only | Whatever the script does. Several scripts mint App JWTs from a local `.pem`. |
| P-8 | **Anonymous** | n/a | n/a | 3 paths only: `/health`, `/webhooks/github` (HMAC), `/api/auth/{login,logout}`. See §5.2. |

**There is no per-user identity.** The "human dashboard user" principal collapses to "anyone holding the shared API key." There is no `users` table, no per-user credential, no role assignment per user.

## 2. Authentication mechanisms

### 2.1 API key (P-1)

- **Check site:** `packages/web/src/middleware/auth.js:64-105` (the only auth middleware).
- **Storage:** plaintext in env (`API_KEY`) and/or comma-separated (`API_KEYS`), loaded into an in-memory `Set` at `auth.js:27-37`.
- **Comparison:** `Set.has(token)` at `auth.js:100`. JavaScript engine V8 implements `Set.has` for short strings via a linear scan with `===`, which is not guarded to be constant-time. **Practical timing-attack risk is low** (short tokens, network jitter dominates) but not provably constant-time.
- **Per-caller identity:** **NONE.** The middleware never attaches `req.user`, `req.principal`, or any identity to the request. Verified: `command grep -rn 'req.user\|req.principal' packages/web/src/routes/` returns zero hits.
- **Fail mode:**
  - Production with no keys configured → throws at module load (`auth.js:43-48`) — fail-closed, process will not start.
  - Non-production with no keys → auto-generates a UUID and **logs it** as a warning (`auth.js:50-54`) — fail-open but observable. **[F-08]**.
  - Missing/invalid credential → 401 (`auth.js:100-102`) — fail-closed at request time.
- **Skip list:** `req.path === "/health"`, `startsWith("/webhooks")`, `startsWith("/api/auth")` (`auth.js:66-72`).

### 2.2 Session cookie (P-1, second factor)

- **Check site:** `auth.js:82-97`.
- **Storage:** Redis key `gitwire:session:<token>`, TTL 7 days, refreshed on each hit.
- **Issuance:** `routes/auth.js:41-73` exchanges the API key for a session cookie. The "password" submitted to `/api/auth/login` is validated against the same API-key set (`auth.js:45`). Functionally: "exchange API key for cookie."
- **Failure mode:** Redis error → logged and treated as "no session" → falls through to the API-key check (`auth.js:94-96`). Fail-closed.

### 2.3 GitHub webhook HMAC (P-2 → P-3 ingress)

- **Route:** `POST /webhooks/github` (`routes/webhooks.js:29`).
- **Algorithm:** HMAC-SHA256, verified by `webhookApp.webhooks.verifyAndReceive({ signature, payload })` (`webhooks.js:49`). The `@octokit/app` library delegates to `@octokit/webhooks-methods`, which in the Node build uses `crypto.createHmac("sha256", secret)` and `timingSafeEqual` — **constant-time compare confirmed** (`node_modules/@octokit/webhooks-methods/dist-src/node/verify.js`).
- **Secret source:** `process.env.GITHUB_WEBHOOK_SECRET` (`packages/web/config/index.js:170`).
- **Default if unset:** `parsed.data.GITHUB_WEBHOOK_SECRET || "dev-secret"` (`config/index.js:170`). **No production fail-closed check.** **[F-01 CRITICAL VERIFIED]**
- **Replay protection:** **WEAK.** No timestamp tolerance, no nonce. The only dedupe is `INSERT INTO webhook_deliveries ... ON CONFLICT (delivery_id) DO NOTHING` at `webhooks.js:175` — but that INSERT runs **AFTER** all side effects (queue dispatch `:109`, custom-rule eval `:114`, quality-gate eval `:142`). A replayed-and-resigned delivery with the same ID re-executes all side effects before the no-op insert. **[F-05 HIGH VERIFIED]**
- **Headers required:** `x-github-event`, `x-github-delivery`, `x-hub-signature-256`, non-empty body (`webhooks.js:33-40`).

### 2.4 executor-service bearer (P-6)

- **Check site:** `packages/executor-service/src/server.js:42-52`.
- **Comparison:** `if (auth !== \`Bearer ${config.service_token}\`)` at `server.js:48` — **non-constant-time**. **[F-04 HIGH VERIFIED]**
- **Mitigation:** the executor-service is on a private compose network only (`server.js:38-41`); the token is "a second layer." Network boundary is the primary defense.
- **Fail mode:** token unset → every `/v1/validate` returns 503 (fail-closed).

## 3. Authorization decision sites

The decision logic in this codebase is overwhelmingly **"authenticated → allowed."** The vast majority of mutating routes perform **no authorization check beyond `apiKeyAuth`**.

| Decision type | Sites | Notes |
|---|---|---|
| **`apiKeyAuth` only** (no further check) | 41 of ~46 mutating route handlers | "Any API-key holder can do this." |
| **Pillar config gate** (`.gitwire.yml`) | every worker entry point (e.g., `triageWorker.js:67`, `phase4Worker.js:35`, `maintainerWorker.js:53`) | Per-repo policy. Checked in workers, not in HTTP routes. |
| **Trigger filter** (branch, author, file) | `ciHealWorker.js:275`, `triageWorker.js:248`, etc. | Policy, not authority. |
| **Idempotency key** | `issueFix/helpers.js:20`, `maintainerWorker.js:115`, `phase4Worker.js:57` | Correctness, not authority. |
| **Author role check** (OWNER/MEMBER/COLLABORATOR) | `commentRouter.js:27` (upstream of comment commands) | **DISCARDED after queueing** — the queued job carries only `authorLogin`, not the role. **[F-07 HIGH VERIFIED]** |
| **Per-tenant filter on DB ops** | **essentially nowhere** | List endpoints default to global; mutations accept `:owner/:repo` without verifying installation scope. `revokeWaiver(waiverId)` has no `repo_id` filter (`waiverService.js:126-133`). **[F-02 CRITICAL VERIFIED]** |
| **Rate-limit-as-authz** | `rateLimiter.js:15-56` | 120 req/60s per identity (token or IP). Fail-open on Redis error (`rateLimiter.js:51-55`). |

There is **no role-based access control**, **no per-resource ownership check**, **no per-installation scope check on the HTTP path**, and **no policy enforcement point** that intercepts mutations.

## 4. Tenancy model

**Tenant definition:** the GitHub App installation. Each installation row in
`installations` is the scoping unit. A single installation can span multiple
repositories; per-repo scoping within an installation is enforced only by
application-layer `.gitwire.yml` policy, not by token narrowing or query
filtering.

**Enforcement layer:** **application memory**, not the database. Most list
endpoints (`/api/issues`, `/api/pull-requests`, `/api/ci`, etc.) default to
**global** scope — every installation's rows in one response. The few that
accept a tenant filter do so via `:owner/:repo` path params, with **no
verification that the caller's authority covers that repo**.

**Leakage surfaces:**

- **List endpoints** (`routes/issues.js`, `routes/pullRequests.js`, `routes/ciRuns.js`, `routes/healHistory.js`, etc.) — global by default. **[F-09 REPORTED]**
- **`revokeWaiver(waiverId)`** (`waiverService.js:126-133`) — `UPDATE policy_waivers SET active=FALSE WHERE id=$1`. No `repo_id`, no `installation_id`. Any API-key holder can revoke any waiver by ID. **[F-02 CRITICAL VERIFIED]**
- **`DELETE /api/repairs/:id/transition`, `PATCH /api/repairs/:id/evidence`** — currently hard-403'd (`routes/repairs.js:84-102`) but the route exists and accepts IDs.
- **Worker→installation binding** — workers mint installation tokens purely from `job.data.payload.installation.id`. A queue-injected job for installation A is indistinguishable from a real one. **[F-06 CRITICAL VERIFIED]**

## 5. HTTP surface

### 5.1 App topology

`createApp()` in `packages/web/src/app.js`. Global middleware in strict order:

| # | Line | Middleware | Scope |
|---|---|---|---|
| 1 | `app.js:49` | `helmet()` | all paths |
| 2 | `app.js:52` | `cors(...)` | all paths, origin allowlist, `credentials: true` |
| 3 | `app.js:63` | `morgan("combined")` | all paths, skips <400 |
| 4 | `app.js:73` | body-parser guard | skips `/webhooks` so the raw Buffer is available for HMAC |
| 5 | `app.js:79` | `rateLimiter` | all paths except `/health`, `/webhooks` |
| 6 | `app.js:82` | `app.use("/api/auth", authRouter)` | **mounted before `apiKeyAuth`** — these routes are anonymous |
| 7 | `app.js:85` | `apiKeyAuth` | global, except skip list |
| 8 | `app.js:88` | `GET /health` | anonymous |
| 9 | `app.js:112` | `app.use("/webhooks", webhookRouter)` | anonymous; HMAC-verified inside |
| 10+ | `app.js:115-153` | all `/api/*` routers | inherit `apiKeyAuth`; no per-route auth overrides |

Notable mount quirks:

- `phase4Router` is mounted at `/api` (not `/api/phase4`) — its handlers appear at `/api/review/...` and `/api/audit/...` (`app.js:135`).
- `transfersRouter` is mounted at `/api/repos` (same prefix as `reposRouter`) but only declares `/reconcile*`, so no actual collision (`app.js:146`).
- `webhookDeliveriesRouter` at `/api/webhooks/deliveries` — authenticated read-only; not to be confused with the unauthenticated `/webhooks/github`.

### 5.2 Per-route inventory

**29 route files, 173 route-file handlers** (plus 1 app-level `/health` handler at `app.js:88`, counted separately — see §17.4). Full per-handler table is in [§17](#17-full-http-handler-inventory); the structural summary:

| Mutation type | Handler count | Notes |
|---|---|---|
| Read-only (DB SELECT only) | ~127 | many of these are admin-readable state that *should* be tenant-scoped but aren't |
| DB write | 31 | `policy_definitions`, `policy_waivers`, `policy_rollout_plans`, `enforcement_violations`, `repo_config`, `quality_gates`, `feedback_rules`, `flaky_tests`, `vulnerability_advisories`, `merge_queue_*`, etc. |
| GitHub mutation | 13 | `octokit` calls for branch protection, collaborators, PR merges, rerun workflows, reviews, check-runs, comments, labels |
| Queue enqueue | 8 | sync, ci-heal, fix, maintainer, webhook-dispatch to 8 named queues |
| File write | 2 | `phase4.js:356` (audit/export), `phase4.js:384` (audit/reports) — but see §7 on the file that is claimed-but-never-written |

### 5.3 Anonymous mutation paths

Three handlers mutate state without `apiKeyAuth`:

| Path | file:line | Mutation | Risk |
|---|---|---|---|
| `POST /webhooks/github` | `webhooks.js:29` | DB + GitHub + queue + Redis | **Intentional**, gated by HMAC. See §2.3 for replay weakness. |
| `POST /api/auth/login` | `auth.js:41` | Redis `setex` of session | **Intentional**. The submitted password is checked against the API key, so this is gated by knowledge of the same key. |
| `POST /api/auth/logout` | `auth.js:76` | Redis `del` of session | **Intentional**, low risk: the caller can only delete the session whose cookie they hold. |

**No other anonymous mutation paths exist.** There are no inline `req.headers["x-..."]` overrides of `apiKeyAuth` in any route handler.

### 5.4 Audit-attribution drift (HIGH)

Because `apiKeyAuth` attaches no principal to `req`, every mutating route that records an actor takes it from one of two unverified sources:

1. **Client-supplied header:** `req.headers["x-actor-login"] || "dashboard"` at `routes/config.js:86, 123, 145, 181`; `|| "api"` at `routes/maintainer.js:242, 274, 358`. Any API-key holder can set this header to any string and have the action recorded as that GitHub login. **[F-03 HIGH VERIFIED]**
2. **Client-supplied body field:** `req.body.created_by`, `req.body.actor`, `req.body.reason`, `req.body.grantedBy`, `req.body.revokedBy` at `routes/rollouts.js:30,139,175,212,252,292`; `routes/waivers.js:90,109,123`; `routes/actions.js:124,136`. Same issue.

**Consequence:** the audit log cannot reliably attribute a human action to a specific human. Anyone with the shared API key can impersonate anyone in `audit_log`, `repo_config.updated_by`, `policy_waivers.granted_by`, etc.

## 6. Worker and background surface

### 6.1 Worker inventory (14 workers)

Every worker that needs GitHub access calls `getInstallationClient(installationId)`. The `installationId` comes from `job.data` (the queued payload), **not from any replay of the webhook signature or any separate credential**.

| Worker | file:line | Queue | Authority basis | Acts as | Mutations |
|---|---|---|---|---|---|
| webhookWorker | `workers/webhookWorker.js:10` | `webhook-events` | trusts `payload.installation.id` | installation | DB: `installations`, `repositories` |
| triageWorker | `workers/triageWorker.js:27` | `triage` | pillar + waiver; trusts payload | installation | GitHub: labels, comments; DB: issues, managed_actions, decision_log |
| ciHealWorker | `workers/ciHealWorker.js:123` | `ci-healing` | pillar + circuit breaker + cooldown + waiver + confidence + file allowlist | installation | GitHub: branch, commit, PR, label, reviewer, workflow rerun; DB: ci_runs, heal_prs, managed_actions |
| ciEvidenceWorker | `workers/ciEvidenceWorker.js:18` | `ci-evidence` | trusts `job.data.installationId`; reconstructs synthetic payload | installation | DB: repair_proposals; enqueue diagnosis |
| diagnosisWorker | `workers/diagnosisWorker.js:20` | `diagnosis` | policy-gated | **no GitHub identity** (evidence only) | DB: repair_proposal_events; enqueue patch |
| patchWorker | `workers/patchWorker.js:21` | `patch` | trusts `proposalId` | **no GitHub identity** | DB: patch_artifacts, repair_proposal_events; enqueue verification |
| verificationWorker | `workers/verificationWorker.js:27` | `verification` | trusts `proposalId`; read-only GitHub for snapshot | installation (read-only) | DB: execution_receipts, backend_isolation_evidence, source_snapshots |
| criticWorker | `workers/criticWorker.js:18` | `critic` | trusts `proposalId` | **no GitHub identity** | DB: repair_proposal_events |
| syncWorker | `workers/syncWorker.js:20` | `sync` | no per-repo gate; iterates all installations | App (each installation) | DB upserts: installations, repositories, issues, pull_requests, ci_runs, members, collaborators, branch_rules, embeddings |
| maintainerWorker | `workers/maintainerWorker.js:23` | `maintainer` | pillar + dry-run + idempotency; **comment-command path discards role** | installation | GitHub: warn, close, label, delete branch, post comment; DB: maintainer_actions, maintainer_settings |
| issueFixWorker | `workers/issueFixWorker.js:20` | `issue-fix` | pillar + idempotency; trusts `triggeredBy` field for telemetry only | installation | GitHub: branch, commit, PR, label, comment; DB: fix_attempts, managed_actions |
| phase2Worker (mergeQueue) | `workers/phase2Worker.js:15` | `phase2` | pillar + dry-run | installation | **GitHub: merge PRs** (`mergeQueueService.js:208`), delete branches, open revert PRs; DB: merge_queue_entries, rollback_events |
| phase3Worker | `workers/phase3Worker.js:17` | `phase3` | pillar + dry-run | installation (per-repo + fleet) | GitHub: PUT branch protection, PATCH repo settings, POST labels, open dependency PRs; DB: policy_repo_configs, dependency_*, flaky_tests, vulnerability_advisories |
| phase4Worker | `workers/phase4Worker.js:22` | `phase4` | pillar + waiver + idempotency + dry-run | installation | GitHub: review comments, check-runs; DB: ai_reviews, audit_exports |

**Plus** `reconciliationWorker` — not one of the 14 (no `startXxxWorker` export); invoked by `setInterval` at `index.js:71,78`. Runs every 6h with system identity.

### 6.2 Scheduled jobs

All schedulers enqueue with **no human principal**. The job carries only the system identity; the worker re-derives an installation token from `installation_id`.

| Schedule | Job | Authority | Mutations |
|---|---|---|---|
| 30 min + startup | `full-sync` | fleet-wide, no per-repo gate | DB upserts across all installations |
| 6h, per repo | `stale-scan` | pillar + dry-run | GitHub: warn, close, label; DB: maintainer_actions |
| 24h, per repo | `branch-cleanup` | pillar + dry-run | GitHub: `DELETE .../git/refs/heads/{branch}` |
| nightly `0 2 * * *` | `policy-reconcile-fleet` | actor hardcoded `"scheduler"` | GitHub: PUT branch protection, POST labels, PATCH repo settings |
| weekly Sun `0 3 * * 0` | `dependency-scan-fleet` | per-repo config | DB: dependency_*; opens dependency PRs |
| weekly Mon `0 7 * * 1` | `graduation-check` | fleet | DB: `UPDATE flaky_tests` |
| nightly `0 1 * * *` | `nightly-audit-export` | none (DB only) | DB: `INSERT INTO audit_exports` |
| 6h + 5min post-boot | `reconciliation` (setInterval) | system identity | DB: cleanup stale `managed_actions`, update `heal_prs` |

**[F-10a HIGH VERIFIED]** `policy-reconcile-fleet` performs branch-protection PUTs and repo-settings PATCHes on every non-skipped repo on every cron tick, with actor `"scheduler"` and no human-in-the-loop. The per-repo bypass is `policy_repo_configs.reconcile_skip` (a DB column), **not `.gitwire.yml`** — no `getConfigForRepo` or `isPillarEnabled` check runs on this path despite the misleading comment at `phase3Worker.js:57`. (The merge queue, F-10b, is a separate event-driven path with a real pillar gate — see §13.)

### 6.3 Webhook authority propagation

**Does signature-verification authority propagate from the HTTP webhook receive path to the workers?** **No.**

1. Webhook verified at `webhooks.js:49` (HMAC-SHA256, constant-time).
2. Payload sanitized and passed to `routeWebhookToQueue` (`webhooks.js:109`).
3. Dispatcher (`webhookHandlers/index.js:61`) calls `ctx.<queue>.add({ ..., payload, installation })`.
4. Worker pops the job, reads `job.data.payload.installation.id`, calls `getInstallationClient(installationId)`.
5. The signed-webhook authority is **reduced to "this installation's App token"** the moment the queue accepts the job.

Anyone with Redis write access can inject a job that will execute with the full authority of any installation whose id they put in the payload. **[F-06 CRITICAL VERIFIED]**. The `webhook_deliveries` audit row (`webhooks.js:175`) is write-only — no worker reads it back to verify the job came from a tracked delivery.

### 6.4 Comment-command authority discard

`commentRouter.js:27` checks `authorAssociation ∈ {OWNER, MEMBER, COLLABORATOR}` on the incoming issue-comment webhook. The role is then **dropped**: the queued job (`handleIssueComment.js:40-47`, `handleFixCommand.js:5-10`) carries only `authorLogin`. The downstream worker executes the command with the App's installation authority, with no role re-verification. **[F-07 HIGH VERIFIED]**

## 7. Database and filesystem mutation sinks

### 7.1 Database

**51 tables** receive writes (count corrected in C-2; the original "50" missed `webhook_deliveries`). The full table-by-writer map is in [§18.1](#18-full-database-writer-map); highlights:

- **`audit_trail_entries`** (`auditTrailService.js:63`) — append-only, no UPDATE/DELETE per the module header. Tamper-evident chain via `prev_hash`. **Race-fork risk (F-11, mechanism corrected in C-4):** the chain is computed via an unsynchronized `SELECT payload_hash ... ORDER BY seq DESC LIMIT 1` then a separate `INSERT` — no Redis lock, no transaction. Two concurrent writers can both read the same `prev_hash` and produce a forked chain. **[F-11 MEDIUM VERIFIED]**
- **`managed_actions`** — reconciled later by `reconciliationWorker`. The reconciliation step compares recorded actions against actual GitHub state. If an action was forged (via queue injection), reconciliation will *detect the drift* but cannot *prevent* it.
- **`policy_waivers`** — `revokeWaiver(waiverId)` accepts only an ID parameter. No tenant filter. **[F-02 HIGH VERIFIED]** (originally CRITICAL; re-rated in C-5 because under today's shared-key model every API-key holder already has fleet-wide authority — this is a design gap that becomes a tenant-crossing violation once per-caller identity exists).
- **`audit_exports`** — `INSERT` at `auditTrailService.js:479` stores `file_path` and `file_hash` but **never calls `writeFile`** — the JSONL body is built in memory and only its hash + a 500-char preview are persisted. Consumers that trust the path will fail. **[F-12 MEDIUM VERIFIED]**

### 7.2 Filesystem

**11 filesystem mutation sites** (count corrected in C-2 and re-corrected in W0-A-rev2: originally claimed 8, then 12, now 11 after dropping `sourceSnapshotProvider.js` whose `fs/promises` imports are dead code — the module fetches blobs into memory and persists metadata via `storeSourceSnapshot`, never invoking `mkdtemp`/`mkdir`/`writeFile`/`rm`). The full inventory is in [§18.2](#182-filesystem-mutation-sites). All production-path writes are ephemeral sandbox tempdirs; the rest are admin/build scripts. Summary:

| file:line | What's written | Notes |
|---|---|---|
| `packages/web/src/lib/sandboxExecutor.js:201,222-224` | `mkdtemp`, `mkdir`, `writeFile` for sandbox | Ephemeral |
| `packages/web/src/lib/dockerExecutorBackend.js:370,390-391` | same | Ephemeral |
| `packages/executor-service/src/validatorRunner.js:182,195-198` | `mkdtemp`, `chmod`, `mkdir`, `writeFile` | Ephemeral under `/workspace-tmp` |
| `scripts/benchmark.js:336-337` | `writeFileSync` results JSON | Admin, isolated env only |
| `scripts/generate-build-info.js:64` | overwrites `packages/core/src/buildInfo.js` | Build-time only |
| `scripts/backup.sh:25`, `scripts/deploy-release.sh:597`, `scripts/prepare-immutable-compose-transition.sh:195,253` | `mkdir -p` for staging dirs and marker file | Admin |

`packages/web/src/lib/sourceSnapshotProvider.js:20` is **excluded**: it imports `mkdtemp, mkdir, writeFile, rm` but never calls them — dead imports, not a mutation site.

No production-path filesystem mutation outside ephemeral sandbox tempdirs.

## 8. Service-to-service trust

App ↔ executor-service only.

- **App → executor-service:** HTTP `POST /v1/validate` with optional `Authorization: Bearer ${token}` (`executorServiceClient.js:55,116`). The client does not fail-closed if the token is absent.
- **executor-service auth:** `Bearer ${service_token}` exact-string compare, non-constant-time (`server.js:48`). **[F-04 HIGH VERIFIED]**
- **Primary defense:** private compose network only. Token is "a second layer."
- **executor-service authority:** minimal — no DB, no GitHub, no network egress, runs an allowlisted subset of `npm` commands in a `--network=none --read-only --user=1000:1000 --pids-limit --memory --tmpfs` container with no `--privileged` and no Docker socket (`validatorRunner.js:10-14,208-220`). Image pinned by digest (`validatorRunner.js:124-166`). **Smallest authority surface in the system.**

## 9. GitHub App installation authority

- **Token minting:** `getInstallationClient(installationId)` at `create-github.js:47-49`. The `@octokit/app` library handles JWT minting and installation-token exchange internally.
- **Scope:** **installation-wide**. The returned Octokit can act on any repo the installation can access, with any permission the App was granted. No per-repo token narrowing.
- **Per-repo scoping is application-layer policy only:** `.gitwire.yml` pillar gates, trigger filters, circuit breakers, file allowlists, confidence thresholds, waivers. Bypassable by any code path that calls `octokit.request` directly — and many do (49 sites in `services/`, 8 in `lib/webhookHandlers/`, ~10 in `workers/`).
- **`forEachInstallation`** (`create-github.js:55-66`) and **`forEachRepo`** (`:73-88`) iterate every installation/repo the App can see. Used by sync, maintainer, and phase3 fleet schedulers — they touch the entire fleet on every cron tick.
- **Single point of compromise:** a single leaked App private key compromises every installation.

## 10. Audit trail coverage

**What is audited:**

- Every worker decision logs to `decision_log` (why this action was taken / not taken).
- Every GitHub mutation records a `managed_actions` row for later reconciliation.
- Every policy/waiver/config change records an `audit_log` row (migration 005).
- A tamper-evident hash chain in `audit_trail_entries` (write-once, `prev_hash` link).

**What is NOT audited:**

- Read endpoints (`/api/issues`, `/api/pull-requests`, etc.) — no read audit. A leaked API key can enumerate cross-tenant data with no audit trail.
- Per-principal identity at decision time is unreliable: bot actions hardcode `"gitwire[bot]"`, human actions take actor from spoofable headers/body fields. **[F-03 HIGH VERIFIED]**
- The hash chain can race-fork under concurrent writers (mechanism corrected in C-4: no Redis lock; unsynchronized SELECT-then-INSERT). **[F-11 MEDIUM VERIFIED]**

**Consequence:** the audit trail can answer "what mutation was performed" but not reliably "who caused it." Cross-tenant reads are invisible.

## 11. Scripts and administrative paths

| Script | What it can do | Auth required |
|---|---|---|
| `scripts/migrate.js` | runs SQL migrations against `$DATABASE_URL` | none (env) |
| `scripts/backup.sh` | `pg_dump`, Redis RDB, copies `.env` + `docker-compose.yml` | none (env + Docker) |
| `scripts/restore.sh` | **replaces live DB** from backup (`pg_restore`) | interactive `y/N` prompt only |
| `scripts/deploy-release.sh` | **pulls digest-pinned images, recreates production containers** | refuses without workflow metadata (`WORKFLOW-OPERATED ONLY` per header) |
| `scripts/prepare-immutable-compose-transition.sh` | one-time operator tool, writes marker file | none |
| `scripts/update-webhook.js` | **mints App JWT from local `.pem`, updates webhook config** | none — uses caller-supplied `.pem` path |
| `scripts/create-test-issues.js` | **mints App JWT + installation token from local `.pem`, creates test issues** | none |
| `scripts/generate-build-info.js` | overwrites `packages/core/src/buildInfo.js` | none (build-time only) |
| `scripts/benchmark.js` | API load tests, writes JSON results | `API_KEY` + `GITWIRE_STRESS_ENV=isolated` (refuses production) |

Most scripts have **no auth of their own** — they execute with whatever credentials the environment provides.

## 12. Principal → action → resource → enforcement → sink matrix

> Each row is one (principal, action) pair. "Enforcement" is what actually
> gates the action, not what docs claim. "Sink" is the mutation target.

| Principal | Action | Resource | Enforcement | Sink |
|---|---|---|---|---|
| P-1 (any API-key holder) | mutate any repo's config | any repo, any installation | `apiKeyAuth` only — **no installation-scope check** | DB: `repo_config`, `config_history`; GitHub (for some handlers) |
| P-1 | grant/revoke any waiver | any waiver, any installation | `apiKeyAuth` only; `revokeWaiver(id)` has no tenant filter | DB: `policy_waivers` |
| P-1 | PUT branch protection on any repo | any repo | `apiKeyAuth` + `maintainer.js:354` | GitHub: `PUT .../branches/{branch}/protection` |
| P-1 | add/remove any collaborator | any repo | `apiKeyAuth` + `maintainer.js:235,271` | GitHub: `PUT/DELETE .../collaborators/{username}` |
| P-1 | merge any queued PR | any repo | `apiKeyAuth` + `phase2.js:91` (`admitToQueue`) | DB: `merge_queue_entries`; worker: `PUT .../pulls/{n}/merge` |
| P-1 | create transition rollout | any policy | `apiKeyAuth` + `rollouts.js:28` | DB: `policy_rollout_plans` |
| P-1 | impersonate any GitHub login in audit log | audit trail | **none** — `x-actor-login` header is trusted | DB: `audit_log`, `repo_config.updated_by`, `policy_waivers.granted_by` |
| P-1 | read cross-tenant data | all installations | `apiKeyAuth` only; list endpoints default to global | DB: SELECT |
| P-1 (session cookie holder) | same as API-key holder | same | session OR API key (cookie is equivalent to key) | same |
| P-4 (queue-injected job) | execute as any installation | any installation | **none** — `job.data.payload.installation.id` trusted | GitHub + DB across the installation |
| P-4 (comment-command) | execute `/gitwire fix`, `/gitwire close`, etc. | repo | role check **discarded** at queue time | GitHub: branch, commit, PR, comment |
| P-3 (worker cron, e.g. policy-reconcile) | PUT branch protection, PATCH repo settings | every repo | per-repo `.gitwire.yml` only; actor hardcoded `"scheduler"` | GitHub + DB |
| P-2 (App itself) | mint installation tokens | every installation | App private key | n/a (token source) |
| P-6 (executor-service) | run allowlisted npm in sandbox | caller-provided files | bearer token + private network | ephemeral tmpdir |
| P-7 (script operator) | migrate, restore, deploy, mint App JWTs | production | none beyond env | DB, Redis, GitHub, Docker |
| Anonymous | forge webhook deliveries | any repo in any installation where secret is unset/default | HMAC with `dev-secret` default | DB + GitHub + queue + Redis |
| Anonymous | login (exchange key for cookie) | session | shared API key | Redis |
| Anonymous | logout (delete own session) | session | cookie possession | Redis |

## 13. Findings, ranked

| ID | Severity | Confidence | Finding | Evidence |
|---|---|---|---|---|
| **F-01** | CRITICAL | VERIFIED | `GITHUB_WEBHOOK_SECRET` defaults to public `"dev-secret"` if env unset, in any environment. No production fail-closed check. | `packages/web/config/index.js:170` |
| **F-02** | ~~CRITICAL~~ → **HIGH** | VERIFIED | `revokeWaiver(waiverId)` accepts only an ID — no `repo_id`, no `installation_id`. **Re-rated to HIGH (C-5):** under today's shared-key model every API-key holder already has fleet-wide authority, so this is a global-admin/IDOR design gap that becomes a tenant-crossing violation only once per-caller identity exists. | `packages/web/src/services/waiverService.js:126-133`; called from `routes/waivers.js:123` |
| **F-03** | HIGH | VERIFIED | Audit-attribution forgery. `x-actor-login` header and `req.body.{created_by,actor,grantedBy,revokedBy}` are trusted as the audit principal, with no verification against the authenticated caller. The audit log cannot reliably bind a mutation to a human. | `routes/config.js:86,123,145,181`; `routes/maintainer.js:242,274,358`; `routes/rollouts.js:30,139,175,212,252,292`; `routes/waivers.js:90,109,123`; `routes/actions.js:124,136` |
| **F-04** | ~~HIGH~~ → **LOW** | VERIFIED | executor-service bearer token compare is non-constant-time (`!==`). **Re-rated to LOW (C-5):** executor-service is private-compose-network-only by design (`server.js:38-41`, `docker-compose.yml:67+` exposes no ports); no timing oracle demonstrated. Defense-in-depth hardening only. | `packages/executor-service/src/server.js:48` |
| **F-05** | HIGH | VERIFIED | Webhook replay/redelivery protection is weak. The `webhook_deliveries ON CONFLICT DO NOTHING` dedupe runs AFTER all side effects. **Reworded (C-5):** the realistic attack is GitHub's own **redelivery** of an already-valid signed request (same payload, same signature, same `X-GitHub-Delivery`), or capture-and-replay of a valid signed body by anyone who observed it. Re-signing requires the secret, which collapses into F-01. | `routes/webhooks.js:175` (dedupe); side effects at `:109,114,142` |
| **F-06** | ~~CRITICAL~~ → **HIGH** | VERIFIED | Trust-the-payload worker model. Workers mint installation tokens purely from `job.data.payload.installation.id` with no replay of the webhook signature. **Re-rated to HIGH (C-5):** impact is CRITICAL in principle, but exploitation requires Redis write access and Redis is documented as internal-Docker-network-only. Upgrade back to CRITICAL if a reachable injection vector is established. | `triageWorker.js:93`, `ciHealWorker.js:189`, `phase2Worker.js:22`, `ciEvidenceWorker.js:45`, `issueFix/context.js:42` |
| **F-07** | HIGH | VERIFIED | Comment-command authority discard — **reframed (C-5) as provenance loss dependent on F-06**: the `OWNER/MEMBER/COLLABORATOR` check at `commentRouter.js:27` is discarded when the job is enqueued (`handleIssueComment.js:40-47` carries only `authorLogin`). Once a job is in the queue (via F-06 or otherwise), the worker executes `/gitwire fix`, `/gitwire close`, etc. with the App's installation authority regardless of the original author's role. The role check exists only on the HTTP ingress path. | `commentRouter.js:27`; `handleIssueComment.js:40-47`; `handleFixCommand.js:5-10` |
| **F-08** | MEDIUM | VERIFIED | Non-production auto-generated API key is logged. In a staging environment that is accidentally reachable, anyone with log read has the key. | `middleware/auth.js:50-54` |
| **F-09** | HIGH | ~~REPORTED~~ → **VERIFIED (C-3a)** | List endpoints default to global scope — cross-tenant data leakage. Re-verified: `GET /api/issues` builds its WHERE from optional query params with **no installation_id condition and no caller-scope filter** (`routes/issues.js:44-75`). The `repo` filter matches by exact full name but does not verify the caller's authority over that repo. Same shape in `pullRequests.js`, `ciRuns.js`, `healHistory.js`, `activity.js`, `decisions.js`. | `routes/issues.js:44-75` (and siblings) |
| **F-10** | HIGH | ~~REPORTED~~ → **VERIFIED (C-3b, re-corrected in W0-A-rev2)** | Originally conflated two distinct authority paths. **Split:** **F-10a** — the fleet policy reconciler is cron-driven (`phase3Worker.js:124` nightly), the "Gate: enforcement pillar only" comment at `:57` is just a comment (no `isPillarEnabled` call), it directly awaits `runFleetReconciliation("scheduler")`, the per-repo bypass is `policy_repo_configs.reconcile_skip` (a DB column, NOT `.gitwire.yml`), and it performs GitHub PUT branch-protection / POST labels / PATCH repo-settings on every non-skipped repo nightly with actor `"scheduler"`. **F-10b** — the merge queue is event-driven (PR/check-suite/workflow triggers, not cron), gates on `isPillarEnabled("merge_queue", repoConfig)` at `phase2Worker.js:26` (a real `.gitwire.yml` check), and merges only the front-of-queue entry when eligibility passes (`mergeQueueService.js:208`); it does NOT execute on every reconciliation cron tick. F-10a carries the bulk of the risk. | F-10a: `phase3Worker.js:55-58,124`; `policyReconcilerService.js:84-86,228,263,278`. F-10b: `phase2Worker.js:26`; `mergeQueueService.js:208` |
| **F-11** | MEDIUM | VERIFIED | Audit hash chain can race-fork under concurrent writers. **Mechanism corrected (C-4):** `auditTrailService.js:59-78` performs an unsynchronized `SELECT payload_hash ... ORDER BY seq DESC LIMIT 1` then a separate `INSERT`. **No Redis lock** (the module imports no Redis client). The race is real; the original "computed under a Redis lock" wording was wrong. | `auditTrailService.js:59-78` |
| **F-12** | MEDIUM | VERIFIED | `audit_exports` INSERT stores `file_path` and `file_hash` but no file is ever written. DB claims a file that does not exist. | `auditTrailService.js:476-491` |
| **F-13** | LOW | VERIFIED | Adjacent SQL syntax bug at `routes/ciRuns.js:183` (`WHERE cr.id = ` with no placeholder). Out of Wave 0 authority scope; separated into issue #79. | `routes/ciRuns.js:183` |
| **F-14** | LOW | VERIFIED | `apiKeyAuth`'s `Set.has` is not provably constant-time. Practical timing-attack risk is low (short tokens, network jitter dominates). | `middleware/auth.js:100` |
| **F-15** | LOW | VERIFIED | Operator hygiene: a local-tree App private key exists at repo root (`gitwire-hq.2026-05-15.private-key.pem`). NOT tracked by git, NEVER committed, IS gitignored. Local-disk exfiltration target only, not a repo-distribution risk. Originally reported by an agent as a CRITICAL "committed private key" — see §14 (D-1) for the dispute and reclassification. | working-tree only; `.gitignore:*.pem`; `git ls-files` empty |

## 14. Disputed findings

> **Accounting convention (W0-A-rev2):** D-1 is the dispute path; F-15 is
> the resulting ranked finding. They are NOT two independent findings. The
> ledger is 15 ranked findings (F-01 through F-15) + 1 dispute resolution
> (D-1 → F-15).

One finding was reported by an exploration agent with a framing the local assistant **disagrees with** after re-verification.

### D-1: "Committed GitHub App private key" (originally CRITICAL) → resolved into F-15

**Agent's claim:** `gitwire-hq.2026-05-15.private-key.pem` is a committed GitHub App private key in the repo root, giving anyone with repo read access the App's full installation authority.

**Verification:**

```bash
$ ls gitwire-hq*.pem
gitwire-hq.2026-05-15.private-key.pem     # EXISTS on disk

$ git ls-files '*.pem'
(empty)                                    # NOT tracked

$ git log --all --oneline -- '*.pem'
(empty)                                    # NEVER committed

$ grep -E 'pem|private-key' .gitignore
*.pem
config/private-key.pem                     # IS gitignored
```

**Corrected classification: LOW (operator hygiene).**

The file exists in the local working tree of one developer (the local assistant's machine). It is **not** tracked by git, **never has been** committed, and **is** covered by `.gitignore`. The scripts that use it (`scripts/update-webhook.js:4`, `scripts/create-test-issues.js`) take the path via `process.argv[2]` (caller-supplied), not a hardcoded committed path. The risk is operator-hygiene-level: a private key sitting in a working tree is a local-disk exfiltration target, not a repo-distribution risk.

The inventory records this as **[F-15 LOW VERIFIED]** — operator hygiene, not the CRITICAL the agent flagged. If the control plane wants to treat working-tree private keys as a release blocker regardless, that's a separate policy decision and not contradicted by this finding.

## 15. Unknowns and unresolved questions

These are flagged for follow-up within Wave 0 or for Wave 1 to resolve:

| ID | Risk | Question |
|---|---|---|
| U-1 | LOW | Where is `check-heal-prs` enqueued? `ciHealWorker.js:129` handles it but no `.add("check-heal-prs")` call site was found. Dead code, scheduled elsewhere, or in a route not yet read? |
| U-2 | LOW | Where is `critic` enqueued? `criticWorker.js:18` consumes it but the producer (likely `verificationWorkerService` after a successful verify) was not located. |
| U-3 | MEDIUM | Writers to the `audit_log` table (migration 005) were not exhaustively traced. Likely `branchEnforcementService.js` or `policyReconcilerService.js`. |
| U-4 | LOW | Does `getInstallationClient(null)` at `routes/gates.js:173` return an unauthenticated Octokit or throw? |
| U-5 | LOW | `forEachInstallation` installation-list source — App-level (sees all installations) or scoped? If App-level, any code calling it acts on every installation simultaneously. |
| U-6 | MEDIUM | F-09's existence is VERIFIED (`routes/issues.js:44-75` confirms no installation_id condition), but exhaustive per-handler tenant-scoping classification remains incomplete: the inventory confirms the pattern for `issues.js`, `pullRequests.js`, `ciRuns.js`, `healHistory.js`, `activity.js`, `decisions.js` but does not classify every read endpoint in the remaining ~21 route files. One more pass would close this. |
| U-7 | LOW | Does a `gitwire-session` cookie grant exactly the same authority as the API key, or a narrower scope? (`auth.js:82-97` reads the session but doesn't attach any scope flag — appears identical to the key.) |
| U-8 | MEDIUM | CORS `origin` in production — `app.js:54-57` uses `config.server.baseUrl` as a single string. Worth verifying it is never falsy in any deployment. |

## 16. Coverage accounting

| Surface | Covered | Skipped and why |
|---|---|---|
| Route files | 29/29 | all handlers enumerated; full per-handler table in §17 |
| Route handlers | 173 route-file (4 anon + 169 auth) + 1 app-level `/health` = **174 endpoints** | convention: route-file handlers counted in §17; `/health` counted separately in §17.4 |
| Middleware modules | 3/3 | `auth.js`, `pagination.js`, `rateLimiter.js` fully read |
| Worker modules | 14/14 + `reconciliationWorker` | — |
| Scheduled jobs | 8 | — |
| DB tables with writes | **51** (corrected in C-2; was 50) | full writer map in §18.1 |
| DB write sites | 179 raw matches across 42 files | individual service-by-service audit not exhaustive; 27 service modules sampled (~20 fully traced, ~7 spot-checked) |
| Filesystem mutation sites | **11** (re-corrected; was 8, then 12 — `sourceSnapshotProvider.js` removed as dead imports) | full inventory in §18.2 |
| Scripts with mutation capability | 9 | — |
| Service-to-service auth boundaries | 1 | app ↔ executor-service |
| Principal types | 8 | — |
| Auth mechanisms | 4 | API key, session cookie, HMAC, executor-service bearer |
| Authz decision sites | see §3 | — |
| Findings | 15 ranked + 1 disputed | severities corrected in C-5; verification statuses in C-3 |
| Unknowns | 8 | — |

### Search commands used

- `command grep -rnE 'router\.(get\|post\|put\|patch\|delete\|all\|use)\(' packages/web/src/routes/`
- `command grep -nE 'apiKeyAuth\|paginationMiddleware\|rateLimiter\|requireAuth' packages/web/src/routes/`
- `command grep -rnE 'req\.headers\[.?x-actor\|req\.body\.(actor\|created_by\|grantedBy\|revokedBy)' packages/web/src/routes/`
- `command grep -rnE 'verifyAndReceive\|verify\|signature\|replay\|hmac\|timingSafeEqual'`
- `command grep -rnE 'getInstallationClient' packages/`
- `command grep -rnE 'INSERT INTO\|UPDATE\|DELETE FROM' packages/web/src/`
- `command grep -rnE 'writeFile\|appendFile\|createWriteStream\|fs\.write\|mkdtemp\|mkdir' packages/ scripts/`
- `command grep -rnE '\.add\(\|\.process\(\|new Worker\|new Queue' packages/web/src/`
- `git ls-files '*.pem'`, `git log --all --oneline -- '*.pem'`, `grep pem .gitignore`
- `find packages/web/db/migrations -name '*.sql'` + `grep '^CREATE TABLE'`

### Directories covered

`packages/web/src/{routes,middleware,workers,services,lib,webhookHandlers,config}`, `packages/web/db/migrations/`, `packages/runtime/src/`, `packages/core/src/`, `packages/executor-service/src/`, `scripts/`, `.gitignore`, repo root.

### Files skipped

- `node_modules/`, `*.test.js`, `jest.config.*` (tests / third-party)
- `packages/web-dashboard/` (frontend, no server-side mutations)
- `packages/rules/`, `packages/runtime/tests/` (pure logic)
- stub packages per `AGENTS.md` (`triage`, `healer`, `mcp`, `cli`, etc.)
- `docs/`, `landing/` (documentation/static)
- `backups/`, `validator-image/` (build artifacts)
- individual service modules beyond the ~20 sampled (flagged in U-3 and the synthesis commit message)

---

## What this inventory does NOT do

- Does not propose a permission model (that is W0-B).
- Does not design a schema (that is W0-C).
- Does not record ADRs (that is W0-D).
- Does not change any code.
- Does not rate findings by exploit difficulty beyond the severity definitions in the README; the control plane may reprioritize.

The next checkpoint (W0-B) will reference these findings by ID (F-01 through F-15) when proposing the canonical permission and resource model.

---

## 17. Full HTTP handler inventory

> W0-A correction C-1. The aggregate §5.2 stands; this section is the
> per-handler fill that was missing from `bf51160`.
>
> Mutation tags: `R` read-only · `DB` DB write · `GH` GitHub API call ·
> `Q` queue enqueue · `R2` Redis write · `file` filesystem write.
> Principal: `api-key` (any holder of the shared key) · `session` (cookie
> holder, equivalent to api-key) · `anon` (no auth) · `webhook` (HMAC).

### 17.1 Anonymous handlers (4 route-file handlers)

> Convention (applied across README, §5.2, §16, §17, and checkpoint totals):
> **route-file handlers** are those declared in `packages/web/src/routes/*.js`.
> The app-level `GET /health` handler at `app.js:88` is reported separately
> in §17.4 because it lives in `app.js`, not in a route file. This gives:
>
> ```text
> 29 route files / 173 route-file handlers (4 anonymous + 169 authenticated)
>   + 1 app-level handler (GET /health, anonymous, read-only)
>   = 174 total HTTP endpoints
> ```

| file:line | method | path | mutate | auth | principal | sink |
|---|---|---|---|---|---|---|
| `webhooks.js:29` | POST | `/webhooks/github` | DB+GH+Q+R2 | HMAC | webhook | see §2.3 + `webhookHandlers/index.js:61` |
| `auth.js:41` | POST | `/api/auth/login` | R2 | pre-`apiKeyAuth` mount | anon | `redis.setex` (`auth.js:55`) |
| `auth.js:76` | POST | `/api/auth/logout` | R2 | pre-`apiKeyAuth` mount | anon | `redis.del` (`auth.js:81`) |
| `auth.js:96` | GET | `/api/auth/check` | R | pre-`apiKeyAuth` mount | anon | Redis GET only |

### 17.2 Authenticated handlers (169 across 28 files)

The 28 authenticated route files are all files in `packages/web/src/routes/`
except `auth.js` (whose 3 handlers are all anonymous, per §17.1) and
`webhooks.js` (whose single handler is anonymous, per §17.1). Every
authenticated handler inherits `apiKeyAuth` (`app.js:85`); no per-route auth
overrides exist.

#### `routes/actions.js` (7)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `actions.js:27` | GET | `/api/actions/summary` | R | — |
| `actions.js:39` | GET | `/api/actions/abstentions` | R | — |
| `actions.js:76` | GET | `/api/actions` | R | — |
| `actions.js:96` | GET | `/api/actions/:id` | R | — |
| `actions.js:108` | POST | `/api/actions/:id/retry` | DB | `actionStateMachine.retry` |
| `actions.js:122` | POST | `/api/actions/:id/cancel` | DB | `actionStateMachine.cancel` |
| `actions.js:134` | POST | `/api/actions/:id/reconcile` | DB | `actionStateMachine.reconcile` |

#### `routes/activity.js` (2, read-only)

| file:line | method | path |
|---|---|---|
| `activity.js:33` | GET | `/api/activity` |
| `activity.js:108` | GET | `/api/activity/summary` |

#### `routes/auditBundles.js` (1, read-only)

| file:line | method | path |
|---|---|---|
| `auditBundles.js:26` | GET | `/api/audit-bundles/export` |

#### `routes/ciRuns.js` (5)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `ciRuns.js:18` | GET | `/api/ci/stats` | R | — |
| `ciRuns.js:73` | GET | `/api/ci` | R | — |
| `ciRuns.js:121` | GET | `/api/ci/:owner/:repo` | R | — |
| `ciRuns.js:150` | POST | `/api/ci/:runId/retry` | GH | `octokit POST .../actions/runs/{run_id}/rerun` (`:165`) |
| `ciRuns.js:177` | POST | `/api/ci/:runId/heal` | Q | `ciHealQueue.add("heal-run")` (`:190`). **Note:** the SELECT at `:181-185` has a SQL bug — see F-13. |

#### `routes/config.js` (12)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `config.js:23` | GET | `/api/config/:owner/:repo` | R | — |
| `config.js:58` | PUT | `/api/config/:owner/:repo` | DB | `setConfigOverrides` → `repo_config` + `config_history` (actor from `x-actor-login`, F-03) |
| `config.js:101` | PATCH | `/api/config/:owner/:repo` | DB | same |
| `config.js:140` | DELETE | `/api/config/:owner/:repo` | DB | `deleteConfigOverrides` |
| `config.js:161` | GET | `/api/config/:owner/:repo/history` | R | — |
| `config.js:176` | POST | `/api/config/:owner/:repo/restore/:historyId` | DB | `restoreConfigVersion` |
| `config.js:195` | GET | `/api/config/:owner/:repo/custom-rules` | R | — |
| `config.js:235` | POST | `/api/config/playground` | R | in-memory eval only |
| `config.js:305` | POST | `/api/config/validate` | R | in-memory only |
| `config.js:342` | POST | `/api/config/simulate` | R | in-memory only |
| `config.js:378` | POST | `/api/config/diff-impact` | R | in-memory only |
| `config.js:415` | POST | `/api/config/recommendations` | R | in-memory only |

#### `routes/decisions.js` (2, read-only)

`decisions.js:15` GET `/api/decisions`; `decisions.js:44` GET `/api/decisions/summary`.

#### `routes/duplicates.js` (7)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `duplicates.js:27` | GET | `/api/duplicates/stats` | R | — |
| `duplicates.js:66` | GET | `/api/duplicates` | R | — |
| `duplicates.js:119` | GET | `/api/duplicates/:owner/:repo` | R | — |
| `duplicates.js:153` | GET | `/api/duplicates/issue/:githubIssueId` | R | — |
| `duplicates.js:176` | POST | `/api/duplicates/:id/confirm` | DB+GH | `updateDuplicateStatus` + octokit via `resolveSignalAndAct` |
| `duplicates.js:185` | POST | `/api/duplicates/:id/dismiss` | DB+GH | same |
| `duplicates.js:195` | POST | `/api/duplicates/backfill/:owner/:repo` | DB | `backfillEmbeddings` |

#### `routes/enforcement.js` (11)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `enforcement.js:20` | GET | `/api/enforcement/stats` | R | — |
| `enforcement.js:72` | GET | `/api/enforcement/policies` | R | — |
| `enforcement.js:87` | POST | `/api/enforcement/policies` | DB | INSERT `policy_definitions` (`:102`) |
| `enforcement.js:120` | PUT | `/api/enforcement/policies/:id` | DB | UPDATE `policy_definitions` (`:140`) |
| `enforcement.js:149` | DELETE | `/api/enforcement/policies/:id` | DB | DELETE `policy_definitions` (`:151`) |
| `enforcement.js:160` | GET | `/api/enforcement/violations` | R | — |
| `enforcement.js:194` | GET | `/api/enforcement/violations/:owner/:repo` | R | — |
| `enforcement.js:210` | POST | `/api/enforcement/violations/:id/suppress` | DB | UPDATE `enforcement_violations` status='suppressed' (`:212`) |
| `enforcement.js:225` | POST | `/api/enforcement/run` | GH+DB | `enforceRepo` / `runEnforcementForAll` |
| `enforcement.js:257` | GET | `/api/enforcement/config-results` | R | — |
| `enforcement.js:296` | GET | `/api/enforcement/config-results/:owner/:repo` | R | — |

#### `routes/fix.js` (3)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `fix.js:16` | POST | `/api/fix/:owner/:repo/issues/:number` | Q | `issueFixQueue.add("fix-issue")` (`:29`) |
| `fix.js:51` | GET | `/api/fix/:owner/:repo/issues/:number` | R | — |
| `fix.js:80` | GET | `/api/fix/:owner/:repo/attempts` | R | — |

#### `routes/gates.js` (8)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `gates.js:31` | GET | `/api/gates` | R | — |
| `gates.js:42` | GET | `/api/gates/:owner/:repo` | R | — |
| `gates.js:94` | POST | `/api/gates/:owner/:repo` | DB | `saveGate` → `quality_gates` |
| `gates.js:138` | DELETE | `/api/gates/:owner/:repo/:name` | DB | `deleteGate` |
| `gates.js:158` | POST | `/api/gates/:owner/:repo/evaluate` | DB+GH | `evaluateGatesForRepo`/`evaluateGatesForPR`; note `getInstallationClient(null)` at `:173` (U-4) |
| `gates.js:205` | GET | `/api/gates/:owner/:repo/history` | R | — |
| `gates.js:245` | GET | `/api/gates/:owner/:repo/metrics` | R | — |
| `gates.js:263` | GET | `/api/gates/:owner/:repo/trends` | R | — |

#### `routes/githubRelay.js` (3, read-only)

`githubRelay.js:17` GET `/api/github-relay/stats`; `:35` `/rate-limits`; `:50` `/cooldowns`.

#### `routes/healHistory.js` (4, read-only)

`healHistory.js:17` GET `/api/heal/stats`; `:52` `/api/heal`; `:98` `/api/heal/:owner/:repo`; `:127` `/api/heal/run/:githubRunId`.

#### `routes/insights.js` (4, read-only)

`insights.js:14` GET `/api/insights/overview`; `:64` `/repos`; `:129` `/velocity`; `:171` `/ci-trend`.

#### `routes/issues.js` (3, read-only)

| file:line | method | path | Note |
|---|---|---|---|
| `issues.js:14` | GET | `/api/issues/stats` | global scope (F-09) |
| `issues.js:43` | GET | `/api/issues` | global scope; optional `repo` filter, no installation check (F-09 VERIFIED via `:44-75`) |
| `issues.js:108` | GET | `/api/issues/:owner/:repo` | path-scoped, no authority check |

#### `routes/maintainer.js` (17)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `maintainer.js:67` | GET | `/api/maintainer/members` | R | — |
| `maintainer.js:116` | POST | `/api/maintainer/members/sync` | DB+GH | `syncMembers` |
| `maintainer.js:138` | GET | `/api/maintainer/members/:login` | R | — |
| `maintainer.js:167` | GET | `/api/maintainer/collaborators` | R | — |
| `maintainer.js:215` | GET | `/api/maintainer/collaborators/:owner/:repo` | R | — |
| `maintainer.js:235` | PUT | `/api/maintainer/collaborators/:owner/:repo/:login` | GH+DB | octokit `PUT .../collaborators/{username}` (`:254`); actor from `x-actor-login` (F-03) |
| `maintainer.js:271` | DELETE | `/api/maintainer/collaborators/:owner/:repo/:login` | GH+DB | octokit `DELETE .../collaborators/{username}` (`:279`) |
| `maintainer.js:301` | GET | `/api/maintainer/branch-rules` | R | — |
| `maintainer.js:338` | GET | `/api/maintainer/branch-rules/:owner/:repo` | R | — |
| `maintainer.js:354` | PUT | `/api/maintainer/branch-rules/:owner/:repo/:pattern` | GH+DB | octokit `PUT .../branches/{branch}/protection` (`:382`); actor from `x-actor-login` (F-03) |
| `maintainer.js:408` | GET | `/api/maintainer/audit` | R | — |
| `maintainer.js:449` | GET | `/api/maintainer/:owner/:repo/settings` | R | — |
| `maintainer.js:467` | PATCH | `/api/maintainer/:owner/:repo/settings` | DB | `maintainerService.upsertSettings` → `maintainer_settings` |
| `maintainer.js:480` | GET | `/api/maintainer/:owner/:repo/actions` | R | — |
| `maintainer.js:492` | GET | `/api/maintainer/:owner/:repo/stats` | R | — |
| `maintainer.js:505` | POST | `/api/maintainer/:owner/:repo/stale-scan` | Q | `maintainerQueue.add("stale-scan")` (`:511`) |
| `maintainer.js:520` | POST | `/api/maintainer/:owner/:repo/branch-cleanup` | Q | `maintainerQueue.add("branch-cleanup")` (`:526`) |

#### `routes/phase2.js` (14)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `phase2.js:20` | GET | `/api/phase2/queue` | R | — |
| `phase2.js:49` | GET | `/api/phase2/queue/:owner/:repo` | R | — |
| `phase2.js:63` | POST | `/api/phase2/queue/:owner/:repo/config` | DB | UPSERT `merge_queue_config` (`:71`) |
| `phase2.js:91` | POST | `/api/phase2/queue/:owner/:repo/:pr/admit` | DB+GH | `admitToQueue` + octokit `GET .../pulls/{pull_number}` (`:98`) |
| `phase2.js:106` | POST | `/api/phase2/queue/:owner/:repo/:pr/remove` | DB | `removeFromQueue` |
| `phase2.js:119` | GET | `/api/phase2/feedback` | R | — |
| `phase2.js:128` | POST | `/api/phase2/feedback` | DB | INSERT `feedback_rules` (`:137`); actor from body (F-03) |
| `phase2.js:147` | PUT | `/api/phase2/feedback/:id` | DB | UPDATE `feedback_rules` (`:157`) |
| `phase2.js:165` | DELETE | `/api/phase2/feedback/:id` | DB | DELETE `feedback_rules` (`:167`) |
| `phase2.js:176` | GET | `/api/phase2/telemetry/summary` | R | — |
| `phase2.js:198` | GET | `/api/phase2/telemetry/events` | R | — |
| `phase2.js:225` | GET | `/api/phase2/telemetry/throughput` | R | — |
| `phase2.js:235` | GET | `/api/phase2/telemetry/ci-health` | R | — |
| `phase2.js:250` | GET | `/api/phase2/rollbacks` | R | — |

#### `routes/phase3.js` (15)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `phase3.js:34` | GET | `/api/phase3/flaky/stats` | R | — |
| `phase3.js:49` | GET | `/api/phase3/flaky` | R | — |
| `phase3.js:83` | GET | `/api/phase3/flaky/:owner/:repo` | R | — |
| `phase3.js:100` | POST | `/api/phase3/flaky/:id/graduate` | DB | UPDATE `flaky_tests` (`:102`) |
| `phase3.js:111` | POST | `/api/phase3/flaky/:id/dismiss` | DB | UPDATE `flaky_tests` (`:113`) |
| `phase3.js:126` | GET | `/api/phase3/reconciler/runs` | R | — |
| `phase3.js:137` | GET | `/api/phase3/reconciler/repos` | R | — |
| `phase3.js:166` | POST | `/api/phase3/reconciler/run` | GH+DB | `reconcileRepo` / `runFleetReconciliation` |
| `phase3.js:189` | PUT | `/api/phase3/reconciler/repos/:owner/:repo` | DB | UPDATE `policy_repo_configs` (`:196`) |
| `phase3.js:208` | GET | `/api/phase3/dependencies/stats` | R | — |
| `phase3.js:223` | GET | `/api/phase3/dependencies/vulnerabilities` | R | — |
| `phase3.js:257` | GET | `/api/phase3/dependencies/:owner/:repo` | R | — |
| `phase3.js:271` | POST | `/api/phase3/dependencies/:owner/:repo/scan` | GH+DB | `scanRepo` |
| `phase3.js:281` | POST | `/api/phase3/dependencies/:owner/:repo/batch-pr` | GH+DB | `openBatchUpdatePR` (opens a PR) |
| `phase3.js:294` | POST | `/api/phase3/dependencies/vuln/:id/dismiss` | DB | UPDATE `vulnerability_advisories` (`:297`) |

#### `routes/phase4.js` (13; mounted at `/api`, not `/api/phase4`)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `phase4.js:50` | GET | `/api/review/stats` | R | — |
| `phase4.js:91` | GET | `/api/review/results` | R | — |
| `phase4.js:132` | GET | `/api/review/results/:owner/:repo` | R | — |
| `phase4.js:157` | GET | `/api/review/config/:owner/:repo` | R | — |
| `phase4.js:169` | POST | `/api/review/config/:owner/:repo` | DB | UPSERT `ai_review_config` (`:181`) |
| `phase4.js:227` | POST | `/api/review/trigger/:owner/:repo/:pr` | GH+DB | octokit `GET .../pulls/{pull_number}` (`:235`); `reviewPR` |
| `phase4.js:252` | GET | `/api/audit/stats` | R | — |
| `phase4.js:307` | GET | `/api/audit/entries` | R | — |
| `phase4.js:347` | GET | `/api/audit/verify` | R | `verifyChain` |
| `phase4.js:356` | POST | `/api/audit/export` | DB+file* | `exportNightly` → `audit_exports` (file is never written — F-12) |
| `phase4.js:368` | GET | `/api/audit/reports` | R | — |
| `phase4.js:384` | POST | `/api/audit/reports` | DB+file* | `generateReport` → `compliance_reports` |
| `phase4.js:405` | GET | `/api/audit/reports/:id` | R | — |

#### `routes/pullRequests.js` (3, read-only; global scope — F-09)

`pullRequests.js:14` GET `/api/pull-requests/stats`; `:41` `/api/pull-requests`; `:96` `/api/pull-requests/:owner/:repo`.

#### `routes/readiness.js` (2, read-only)

`readiness.js:191` GET `/api/readiness`; `:269` GET `/api/readiness/:owner/:repo`.

#### `routes/repairs.js` (6)

| file:line | method | path | mutate | Note |
|---|---|---|---|---|
| `repairs.js:33` | GET | `/api/repairs` | R | — |
| `repairs.js:52` | GET | `/api/repairs/:id` | R | — |
| `repairs.js:67` | GET | `/api/repairs/:id/events` | R | — |
| `repairs.js:84` | POST | `/api/repairs` | **none** | hard-coded 403 (`:84-88`) |
| `repairs.js:91` | PATCH | `/api/repairs/:id/evidence` | **none** | hard-coded 403 (`:91-95`) |
| `repairs.js:98` | POST | `/api/repairs/:id/transition` | **none** | hard-coded 403 (`:98-102`) |

#### `routes/repos.js` (3)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `repos.js:15` | GET | `/api/repos` | R | — |
| `repos.js:90` | GET | `/api/repos/:owner/:repo` | R | — |
| `repos.js:126` | POST | `/api/repos/:owner/:repo/sync` | Q | `syncQueue.add("sync-repo")` (`:136`) |

#### `routes/rollouts.js` (9)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `rollouts.js:28` | POST | `/api/rollouts` | DB | `createRolloutPlan`; actor from body (F-03) |
| `rollouts.js:59` | GET | `/api/rollouts` | R | — |
| `rollouts.js:83` | GET | `/api/rollouts/:id` | R | — |
| `rollouts.js:108` | PATCH | `/api/rollouts/:id/evidence` | DB | `attachEvidence` |
| `rollouts.js:136` | POST | `/api/rollouts/:id/transition` | DB | `transitionRolloutPlan`; actor from body |
| `rollouts.js:172` | POST | `/api/rollouts/:id/approve` | DB | `approveRolloutPlan`; actor from body |
| `rollouts.js:209` | POST | `/api/rollouts/:id/reject` | DB | `rejectRolloutPlan`; actor from body |
| `rollouts.js:248` | POST | `/api/rollouts/:id/promote` | DB | `promoteRolloutPlan` — "the ONLY path that writes policy" (source comment) |
| `rollouts.js:289` | POST | `/api/rollouts/:id/rollback` | DB | `rollbackRolloutPlan` |

#### `routes/setup.js` (3, read-only)

`setup.js:17` GET `/api/setup`; `:29` GET `/api/setup/templates`; `:39` GET `/api/setup/templates/:id`.

#### `routes/transfers.js` (3; mounted at `/api/repos`)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `transfers.js:15` | GET | `/api/repos/reconcile` | R | `detectOrphans` |
| `transfers.js:26` | POST | `/api/repos/reconcile/merge` | DB | `mergeOrphan` |
| `transfers.js:43` | POST | `/api/repos/reconcile/discard` | DB | `discardOrphan` |

#### `routes/waivers.js` (4)

| file:line | method | path | mutate | sink |
|---|---|---|---|---|
| `waivers.js:16` | GET | `/api/waivers` | R | — |
| `waivers.js:58` | GET | `/api/waivers/check` | R | — |
| `waivers.js:88` | POST | `/api/waivers` | DB | `grantWaiver` (waivers table); `grantedBy` from body (F-03) |
| `waivers.js:121` | DELETE | `/api/waivers/:id` | DB | `revokeWaiver(id)` — **no tenant filter (F-02)**; `revokedBy` from body |

#### `routes/webhookDeliveries.js` (5, read-only; mounted at `/api/webhooks/deliveries`)

`webhookDeliveries.js:19` GET `/api/webhooks/deliveries/stats`; `:55` `/events`; `:76` `/timeline`; `:100` `` (list); `:157` `/:id`.

### 17.3 Aggregate counts (re-verified)

Applies to the 173 route-file handlers only. The app-level `/health` handler (§17.4) is counted separately.

| Mutation type | Count |
|---|---|
| Read-only (DB SELECT only) | ~127 |
| DB write | 31 |
| GitHub mutation | 13 |
| Queue enqueue | 8 |
| File write (claimed-but-never-written, see F-12) | 2 |
| **Total route-file handlers** | **173** (4 anonymous + 169 authenticated) |

### 17.4 App-level handler (outside route files)

| file:line | method | path | mutate | auth | principal | sink |
|---|---|---|---|---|---|---|
| `app.js:88` | GET | `/health` | R | `apiKeyAuth` skip list (`auth.js:68`) | anon | DB SELECT |

**Grand total: 173 route-file handlers + 1 app-level handler = 174 HTTP endpoints.**

---

## 18. Full table inventory and known-writer map

> W0-A correction C-2. Renamed from "Full database writer map" in W0-A-rev2:
> `audit_log` writers are explicitly untraced (U-3), so this is a table
> inventory with known-writer mapping, not a complete writer map. The
> original §7.1 omitted this with "regenerate by grep." Verified count:
> **51 tables** receive writes (not 50; the original count missed
> `webhook_deliveries`).
>
> Writers are route handlers (`routes/`), workers (`workers/`), or services
> called by either (`services/`). SQL is parameterized throughout; no string
> interpolation of user input was found.

| table | writers (file:line) | what it stores |
|---|---|---|
| `action_reconciliation_log` | `services/actionStateMachine.js:300` | drift-detection results |
| `ai_review_config` | `routes/phase4.js:181` | per-repo AI-review config |
| `ai_reviews` | `services/aiReviewService.js` (via `phase4Worker.js`) | AI PR-review results |
| `audit_exports` | `services/auditTrailService.js:479` | nightly JSONL export metadata (file_path never written — F-12) |
| `audit_log` | governance writers not fully traced (U-3) | permission/rule change history |
| `audit_trail_entries` | `services/auditTrailService.js:63` (append-only, race-prone — F-11 corrected mechanism) | tamper-evident event chain |
| `backend_isolation_evidence` | `services/backendEvidenceStore.js:111` | sandbox isolation proof |
| `branch_rules` | `services/maintainerService.js` (`syncBranchRules`); `routes/maintainer.js:382` | repo branch-protection rules |
| `ci_runs` | `workers/ciHealWorker.js:944,771`; `workers/syncWorker.js:298`; `services/ciService.saveHealResult` | workflow runs + heal status |
| `compliance_reports` | `services/auditTrailService.js:415` | compliance report artifacts |
| `config_history` | `services/configService.js` | `.gitwire.yml` change history |
| `config_validation_results` | `services/configValidationService.js` | `.gitwire.yml` validation outcomes |
| `decision_log` | `services/decisionLogService.js` (called from `triageWorker.js:115`, `ciHealWorker.js:219`, `phase4Worker.js`) | per-worker decision rationale |
| `dependency_manifests` | `services/dependencyService.js` | SBOM per repo |
| `dependency_update_batches` | `services/dependencyService.js:281-289` | dep-update PR batches |
| `duplicate_signals` | `services/duplicateDetectionService.js` | duplicate-issue matches |
| `enforcement_violations` | `routes/enforcement.js:213`; `services/branchEnforcementService.js` | branch-protection violations |
| `execution_receipts` | `services/executionReceiptStore.js:49,158` | write-once sandbox receipts |
| `feedback_rules` | `routes/phase2.js:138,158,167` | feedback-rule definitions |
| `fix_attempts` | `issueFix/helpers.js` (`upsertFixAttempt`); `issueFix/submit.js:125,131` | autonomous-fix attempt tracking |
| `flaky_tests` | `services/flakyTestService.js`; `routes/phase3.js:103,114` | quarantined tests + graduation |
| `gate_evaluations` | `services/qualityGateService.js` | per-PR quality-gate results |
| `heal_prs` | `workers/ciHealWorker.js:760`; `workers/reconciliationWorker.js:207` | auto-heal PRs + outcome |
| `installations` | `workers/webhookWorker.js:30,42`; `workers/syncWorker.js:224` | App installations |
| `issue_embeddings` | `services/embeddingService.js` | vector embeddings |
| `issues` | `workers/syncWorker.js:256`; `services/issueService.saveTriage` | issue state + triage |
| `maintainer_actions` | `services/maintainerService.recordAction` (called across `maintainerWorker.js`) | stale/cleanup action audit |
| `maintainer_settings` | `services/maintainerService.upsertSettings` | per-repo maintainer config |
| `managed_actions` | `services/actionStateMachine.js:73,81,172,271,277,424`; `services/managedActionService.js:56,63,96,208`; `workers/ciHealWorker.js:1111,1136`; `workers/reconciliationWorker.js:34,40,231,246` | every GitHub mutation (reconciled later) |
| `members` | `services/maintainerService.js` (`syncMembers`) | org members |
| `merge_queue_config` | `routes/phase2.js:71` | per-repo merge-queue config |
| `merge_queue_entries` | `services/mergeQueueService.js` (`admitToQueue`, `removeFromQueue`) | PR merge queue |
| `patch_artifacts` | `services/patchArtifactStore.js` | candidate patches |
| `pipeline_events` | `services/pipelineEvents.js` | CI pipeline events |
| `policy_definitions` | `routes/enforcement.js:103,141,151` | policy-as-code definitions |
| `policy_repo_configs` | `services/policyReconcilerService.js`; `routes/phase3.js:197` | per-repo policy overrides |
| `policy_rollout_plans` | `services/policyRolloutService.js`; `routes/rollouts.js` | staged policy rollout |
| `policy_waivers` | `services/waiverService.grantWaiver`; `revokeWaiver` (F-02) | time-limited pillar exceptions |
| `pull_requests` | `workers/syncWorker.js:277` | PR state |
| `quality_gates` | `routes/gates.js:94` (`saveGate`); DELETE at `routes/gates.js:138` | gate definitions |
| `reconciliation_runs` | `services/policyReconcilerService.js` | reconciliation audit |
| `repair_proposal_events` | `services/repairProposalService.js:838,879,1136,1156,1300,1319,1441,1462,1851,1874,2264,2286,3212,3233` | governed CI repair workflow |
| `repair_proposals` | `services/repairProposalService.js` (multiple) | repair proposals (`can_write_repository` hard-coded false per migration 031) |
| `repo_collaborators` | `services/maintainerService.js` (`syncCollaborators`); `routes/maintainer.js:282` (DELETE) | repo collaborators |
| `repo_config` | `routes/config.js` via `setConfigOverrides`/`deleteConfigOverrides` | per-repo config overrides |
| `repositories` | `workers/webhookWorker.js:62`; `workers/syncWorker.js:235,131`; `reconcileRepository.js` | one row per repo |
| `rollback_events` | `services/errorRecoveryService.js:97-127` | auto-revert events |
| `source_snapshots` | `services/sourceSnapshotStore.js` | immutable source snapshot hashes |
| `test_results` | `services/flakyTestService.js` (`ingestTestResults`) | per-run test outcomes |
| `vulnerability_advisories` | `services/dependencyService.js`; `routes/phase3.js:298` | vuln scan results |
| `webhook_deliveries` | `routes/webhooks.js:175` (with `ON CONFLICT DO NOTHING`) | delivery audit (dedupe site — F-05) |

**Total: 51 tables receiving writes.**

### 18.2 Filesystem mutation sites

> Original §7.2 said 8 sites; first re-verification said 12; second
> re-verification says **11** after excluding `sourceSnapshotProvider.js`
> (its `fs/promises` imports are dead code — the module fetches blobs into
> memory and persists metadata via `storeSourceSnapshot`; it never calls
> `mkdtemp`/`mkdir`/`writeFile`/`rm`). Sites outside `node_modules`, tests,
> and docs. All production-path writes are ephemeral sandbox tempdirs; the
> rest are admin/build scripts.

| file:line | what's written | category |
|---|---|---|
| `packages/web/src/lib/sandboxExecutor.js:201` | `mkdtemp(join(tmpdir(), "gitwire-sandbox-"))` | ephemeral sandbox |
| `packages/web/src/lib/sandboxExecutor.js:222-224` | `mkdir` + `writeFile(filePath, file.content)` | ephemeral sandbox |
| `packages/web/src/lib/dockerExecutorBackend.js:370` | `mkdtemp(join(tmpdir(), "gitwire-docker-"))` | ephemeral sandbox |
| `packages/web/src/lib/dockerExecutorBackend.js:390-391` | `mkdir` + `writeFile` | ephemeral sandbox |
| `packages/executor-service/src/validatorRunner.js:182` | `mkdtemp(join(WORKSPACE_TMP, "gitwire-validator-"))` | ephemeral sandbox |
| `packages/executor-service/src/validatorRunner.js:195-198` | `chmod`, `mkdir`, `writeFile` | ephemeral sandbox |
| `scripts/benchmark.js:336-337` | `writeFileSync(outPath, JSON.stringify(...))` | admin (isolated env only) |
| `scripts/generate-build-info.js:64` | `writeFile(corePath, coreContent)` — overwrites `packages/core/src/buildInfo.js` | build-time only |
| `scripts/backup.sh:25` | `mkdir -p "${BACKUP_DIR}"` | admin |
| `scripts/deploy-release.sh:597` | `mkdir -p "$staging_dir"` | admin |
| `scripts/prepare-immutable-compose-transition.sh:195,253` | `mkdir -p` for staging + marker file | admin |

**Excluded:** `packages/web/src/lib/sourceSnapshotProvider.js:20` — imports `mkdtemp, mkdir, writeFile, rm` but never calls them. Dead imports, not a mutation site.

**Total: 11 filesystem mutation sites** (6 production-path ephemeral; 5 admin/build).

---

## 19. `security.md` discrepancy matrix

> W0-A correction C-6. The existing [`docs/architecture/security.md`](../security.md)
> (80 lines) describes the intended model. Four specific claims diverge
> from current code. This matrix reconciles them; resolving the divergences
> (update docs vs. update code) is a control-plane decision, not a Wave 0
> design output.

| # | `security.md` claim | location | Actual code behavior | Evidence | Authority finding |
|---|---|---|---|---|---|
| SD-1 | "All API endpoints require a Bearer token" | `security.md:7-11` | Two auth mechanisms exist (Bearer **or** `gitwire-session` cookie), and 3 anonymous routes mutate state (`/webhooks/github` by HMAC design; `/api/auth/login`, `/api/auth/logout` because they mount before `apiKeyAuth`). | `middleware/auth.js:64-105`; `app.js:82,85,112` | §2.1, §2.2, §5.3 |
| SD-2 | "If no key is set, a random key is generated on startup and logged once" | `security.md:15` | Production THROWS at module load if no key is configured (fail-closed); auto-generation happens only in non-production. | `middleware/auth.js:43-54` | §2.1, F-08 |
| SD-3 | "Max requests: 100 per IP per window" + "Key: Client IP address" | `security.md:25,27` | Actual limit is **120** per window; the identity key is the Bearer token if present, else IP, else literal `"unknown"`; Redis errors fail-**open** (request allowed, logged). | `middleware/rateLimiter.js:8-9,22-25,51-55` | §2 (rate limiter) |
| SD-4 | Webhook verification section omits any mention of the `dev-secret` fallback | `security.md:31-39` | `GITHUB_WEBHOOK_SECRET` defaults to the public string `"dev-secret"` if the env var is unset, in any environment. No production fail-closed check. | `config/index.js:170` | §2.3, F-01 (CRITICAL VERIFIED) |

### Additional divergences noted but not blocking

These are accuracy gaps in `security.md` that don't rise to the level of the four above; recorded for completeness:

- `security.md:42-47` "GitHub App Token Scope" describes installation scoping as the boundary. The inventory's §9 confirms token-level scoping is installation-wide — but the doc does not mention that per-repo narrowing is **application-layer policy only** (`.gitwire.yml`), bypassable by any code path that calls `octokit.request` directly.
- `security.md:53-58` "Data Storage" says Redis has "No password (internal Docker network only)." The inventory's F-06 (corrected to HIGH) shows that Redis write access yields installation-wide authority via the trust-the-payload worker model — the "internal network only" mitigation is the only barrier, and a single compromised in-network service yields that barrier.
- `security.md:71-78` "Recommendations" lists strong-key/rotation guidance but does not mention that the audit log cannot reliably bind a mutation to a human (F-03 corrected scope).

### Resolution options (for control plane; not Wave 0 design)

Each discrepancy has two possible resolutions:

1. **Update `security.md`** to match current code (cheapest; documents the gap honestly).
2. **Update the code** to match `security.md`'s claim (closes the gap; may overlap with Wave 1+ work).

Wave 0 does not pick. W0-B's permission model will reference these discrepancies by SD-* ID when proposing which claims should become enforceable invariants.
