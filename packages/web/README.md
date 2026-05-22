# @gitwire/web

GitWire Backend — API server and background workers for the [GitWire](https://github.com/Elephant-Rock-Lab/GitWire) AI GitHub App platform.

## Stack

- **Express** — REST API with JSON body parsing
- **PostgreSQL 16** — persistent storage (36 tables, 11 migrations)
- **Redis 7 + BullMQ** — 9 background job queues
- **Octokit** — GitHub API via `@octokit/app` (REST only)
- **Anthropic Claude** — AI triage, CI diagnosis, issue fixes, PR review

## Structure

```
src/
  app.js             Express app setup, middleware, routes, error handler
  index.js           Server startup + worker initialization
  config/index.js    Environment config with runtime secret guard

  routes/            HTTP endpoints (14 route files)
    repos.js         Repository CRUD + sync trigger
    issues.js        Issue listing + triage results
    pullRequests.js  PR listing + review data
    ciRuns.js        CI run history
    webhooks.js      GitHub webhook ingest → queue dispatch
    duplicates.js    Duplicate detection results
    maintainer.js    Stale management, branch cleanup, settings
    fix.js           Autonomous issue fix attempts
    healHistory.js   CI healing history
    enforcement.js   Branch/config policy violations
    phase2.js        Merge queue + error recovery
    phase3.js        Flaky tests, dependencies, policy reconciliation
    phase4.js        AI review, audit trail
    insights.js      Cross-repo aggregation

  services/          Business logic (17 service files)
  workers/           BullMQ job processors (9 workers)
  lib/               Shared: db, queue, logger, github client, comment router

db/
  migrations/        001–011 SQL migrations
```

## Authentication

- **API endpoints** require `Authorization: Bearer <API_KEY>` header
- **Webhooks** verify GitHub HMAC signature (`X-Hub-Signature-256`)

## Workers

| Queue | Worker | Purpose |
|-------|--------|---------|
| `webhook` | `webhookWorker` | Routes GitHub events to downstream queues |
| `triage` | `triageWorker` | AI issue/PR classification + duplicate detection |
| `ci-healing` | `ciHealWorker` | CI failure diagnosis + auto-patch PRs |
| `sync` | `syncWorker` | Repo data sync, member/collaborator backfill |
| `maintainer` | `maintainerWorker` | Stale scans, branch cleanup, comment commands |
| `issue-fix` | `issueFixWorker` | Autonomous issue fixing via `/gitwire fix` |
| `phase2` | `phase2Worker` | Merge queue processing |
| `phase3` | `phase3Worker` | Trust workflows (flaky tests, deps, policies) |
| `phase4` | `phase4Worker` | AI PR review + audit reports |

## Development

```bash
# From monorepo root
npm install
npm run --workspace=@gitwire/web db:migrate   # Apply database migrations
npm run --workspace=@gitwire/web dev           # Start with nodemon

# Or from this directory
npm run dev
```

Requires a running PostgreSQL and Redis. Configure via `.env` (see `.env.example`).

## Testing

```bash
npm test
```

395 tests across unit, service mock, stress, and dashboard suites.

## Deployment

See the monorepo `docker-compose.yml` for the full production deployment (backend, dashboard, PostgreSQL, Redis, Cloudflare Tunnel).
