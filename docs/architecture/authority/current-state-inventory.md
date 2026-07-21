# Current-State Authority Inventory (W0-A)

> Disk-verified map of GitWire's authority surface as of base
> `7b8cdc62b4262b5913dbebaedcb4401f2acef29a`. Every claim cites `file:line`.
> See [`README.md`](./README.md) for methodology, risk-rating key, and scope.

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

**29 route files, 173 handlers.** Full per-handler table (with method, path, read/mutate tag, auth, principal, mutation sink) is in the [synthesis commit's long-form inventory](#); the structural summary:

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

**[F-10 HIGH REPORTED]** `policy-reconcile-fleet` performs branch-protection PUTs and repo-settings PATCHes on every repo on every cron tick, with actor `"scheduler"` and no human-in-the-loop. The only gate is per-repo `.gitwire.yml`.

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

50 tables receive writes. The full table-by-writer map is too long for this document and is regenerated trivially with `command grep -rnE 'INSERT INTO|UPDATE|DELETE FROM' packages/web/src/`. Highlights:

- **`audit_trail_entries`** (`auditTrailService.js:64`) — append-only, no UPDATE/DELETE per the module header. Tamper-evident chain via `prev_hash`. **However:** the chain is computed at write time under a Redis lock (`auditTrailService.js`); concurrent writers can race the `prev_hash` read, producing a forked chain. **[F-11 MEDIUM REPORTED]**
- **`managed_actions`** — reconciled later by `reconciliationWorker`. The reconciliation step compares recorded actions against actual GitHub state. If an action was forged (via queue injection), reconciliation will *detect the drift* but cannot *prevent* it.
- **`policy_waivers`** — `revokeWaiver(waiverId)` accepts only an ID parameter. No tenant filter. **[F-02 CRITICAL VERIFIED]**
- **`audit_exports`** — `INSERT` at `auditTrailService.js:479` stores `file_path` and `file_hash` but **never calls `writeFile`** — the JSONL body is built in memory and only its hash + a 500-char preview are persisted. Consumers that trust the path will fail. **[F-12 MEDIUM REPORTED]**

### 7.2 Filesystem

| file:line | What's written | Notes |
|---|---|---|
| `packages/web/src/lib/sandboxExecutor.js:201,222-224` | `mkdtemp`, `writeFile` for sandbox | Ephemeral |
| `packages/web/src/lib/dockerExecutorBackend.js:370,390-391` | same | Ephemeral |
| `packages/executor-service/src/validatorRunner.js:182-198` | `mkdtemp`, `chmod`, `mkdir`, `writeFile` | Ephemeral under `/workspace-tmp` |
| `scripts/benchmark.js:336-337` | `writeFileSync` results JSON | Admin script, isolated env only |
| `scripts/generate-build-info.js:64` | overwrites `packages/core/src/buildInfo.js` | Build-time only |

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
- The hash chain can race-fork under concurrent writers. **[F-11 MEDIUM REPORTED]**

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
| **F-02** | CRITICAL | VERIFIED | `revokeWaiver(waiverId)` accepts only an ID — no `repo_id`, no `installation_id`. Any API-key holder can revoke any waiver by guessing/enumerating IDs. | `packages/web/src/services/waiverService.js:126-133`; called from `routes/waivers.js:123` |
| **F-03** | HIGH | VERIFIED | Audit-attribution forgery. `x-actor-login` header and `req.body.{created_by,actor,grantedBy,revokedBy}` are trusted as the audit principal, with no verification against the authenticated caller. The audit log cannot reliably bind a mutation to a human. | `routes/config.js:86,123,145,181`; `routes/maintainer.js:242,274,358`; `routes/rollouts.js:30,139,175,212,252,292`; `routes/waivers.js:90,109,123`; `routes/actions.js:124,136` |
| **F-04** | HIGH | VERIFIED | executor-service bearer token compare is non-constant-time (`!==`). Network boundary is primary defense; token is "a second layer." | `packages/executor-service/src/server.js:48` |
| **F-05** | HIGH | VERIFIED | Webhook replay protection is weak. The `webhook_deliveries ON CONFLICT DO NOTHING` dedupe runs AFTER all side effects. A replayed-and-resigned delivery with the same ID re-triggers queue dispatch, custom-rule eval, and Telegram egress. | `routes/webhooks.js:175` (dedupe); side effects at `:109,114,142` |
| **F-06** | CRITICAL | VERIFIED | Trust-the-payload worker model. Workers mint installation tokens purely from `job.data.payload.installation.id` with no replay of the webhook signature. Anyone with Redis write access can inject a job that executes with arbitrary installation authority. | `triageWorker.js:93`, `ciHealWorker.js:189`, `phase2Worker.js:22`, `ciEvidenceWorker.js:45`, `issueFix/context.js:42` |
| **F-07** | HIGH | VERIFIED | Comment-command authority discard. The `OWNER/MEMBER/COLLABORATOR` check at `commentRouter.js:27` is dropped at queue time; the queued job carries only `authorLogin`. Downstream workers execute `/gitwire fix`, `/gitwire close`, etc. with the App's installation authority and no role re-verification. | `commentRouter.js:27`; `handleIssueComment.js:40-47`; `handleFixCommand.js:5-10` |
| **F-08** | MEDIUM | VERIFIED | Non-production auto-generated API key is logged. In a staging environment that is accidentally reachable, anyone with log read has the key. | `middleware/auth.js:50-54` |
| **F-09** | HIGH | REPORTED | List endpoints default to global scope — cross-tenant data leakage. (Per agent; not re-verified per-handler in this pass.) | `routes/issues.js`, `routes/pullRequests.js`, `routes/ciRuns.js`, etc. |
| **F-10** | HIGH | REPORTED | Fleet-wide scheduled authority without a human principal. `policy-reconcile-fleet` performs branch-protection PUTs and repo-settings PATCHes on every repo nightly with actor `"scheduler"`; `merge_queue` worker can merge PRs. Only gate is `.gitwire.yml`. | `phase3Worker.js:124,57`; `policyReconcilerService.js:228,263,278`; `mergeQueueService.js:208` |
| **F-11** | MEDIUM | REPORTED | Audit hash chain can race-fork under concurrent writers. | `auditTrailService.js` (Redis lock + `prev_hash`) |
| **F-12** | MEDIUM | REPORTED | `audit_exports` INSERT stores `file_path` and `file_hash` but no file is ever written. DB claims a file that does not exist. | `auditTrailService.js:476-491` |
| **F-13** | LOW | VERIFIED | Adjacent SQL syntax bug at `routes/ciRuns.js:183` (`WHERE cr.id = ` with no placeholder). Out of Wave 0 authority scope but flagged for a separate ticket. | `routes/ciRuns.js:183` |
| **F-14** | LOW | VERIFIED | `apiKeyAuth`'s `Set.has` is not provably constant-time. Practical timing-attack risk is low (short tokens, network jitter dominates). | `middleware/auth.js:100` |

## 14. Disputed findings

One finding was reported by an exploration agent with a framing the local assistant **disagrees with** after re-verification.

### D-1: "Committed GitHub App private key" (originally CRITICAL)

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
| U-6 | MEDIUM | Per-handler read-endpoint tenant scoping (F-09) was reported at the structural level; the full list of which list endpoints accept a tenant filter vs which default to global needs one more pass. |
| U-7 | LOW | Does a `gitwire-session` cookie grant exactly the same authority as the API key, or a narrower scope? (`auth.js:82-97` reads the session but doesn't attach any scope flag — appears identical to the key.) |
| U-8 | MEDIUM | CORS `origin` in production — `app.js:54-57` uses `config.server.baseUrl` as a single string. Worth verifying it is never falsy in any deployment. |

## 16. Coverage accounting

| Surface | Covered | Skipped and why |
|---|---|---|
| Route files | 29/29 | all handlers enumerated |
| Route handlers | 173 | — |
| Middleware modules | 3/3 | `auth.js`, `pagination.js`, `rateLimiter.js` fully read |
| Worker modules | 14/14 + `reconciliationWorker` | — |
| Scheduled jobs | 8 | — |
| DB tables with writes | 50 | — |
| DB write sites | 179 raw matches across 42 files | individual service-by-service audit not exhaustive; 27 service modules sampled (~20 fully traced, ~7 spot-checked) |
| Filesystem mutation sites | 8 | — |
| Scripts with mutation capability | 9 | — |
| Service-to-service auth boundaries | 1 | app ↔ executor-service |
| Principal types | 8 | — |
| Auth mechanisms | 4 | API key, session cookie, HMAC, executor-service bearer |
| Authz decision sites | see §3 | — |
| Findings | 15 ranked + 1 disputed | — |
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
