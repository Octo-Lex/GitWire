# AGENTS.md — GitWire AI Agent Guide

This file provides context for AI coding agents interacting with the GitWire codebase and API.

## ⚠️ READ FIRST: Production Deployment Context

GitWire is not just a repository — it is a **running production system**. Before
starting any work, read these two files:

1. **`docs/installation/infrastructure.md`** — Proxmox VE host, CT 115 config,
   Docker containers, database, Redis, Cloudflare tunnel, GitHub App, LLM provider.
2. **`docs/installation/deployment-runbook.md`** — Step-by-step post-release
   checklist: pull, apply migrations, rebuild, verify, smoke test.

**Before tagging any release**, you MUST follow the deployment runbook and
verify the running system matches the release. Do not assume `git push` +
`git tag` means the release is deployed.

### SSH Access

```bash
ssh gitwire    # Direct to CT 115 (192.168.3.151)
ssh pve        # Proxmox host (192.168.3.5)
```

## About GitWire

GitWire is a self-hosted GitHub App that automates repository management using AI (Claude). It's an open-source monorepo (MIT license) with a Node.js backend and Next.js dashboard. Current version: **0.20.0**.

## Repository Structure

```
GitWire/
├── packages/
│   ├── web/                 # Express API server + 9 background workers
│   │   ├── src/
│   │   │   ├── app.js           # Express app setup, route mounting
│   │   │   ├── index.js         # Entry: starts server + all workers
│   │   │   ├── routes/          # 22 route files
│   │   │   ├── services/        # 27 business logic modules
│   │   │   ├── workers/         # 10 BullMQ background workers (incl. reconciliation)
│   │   │   ├── lib/             # GitHub client, queue helpers, DB
│   │   │   └── middleware/      # Auth, pagination, rate limiting
│   │   ├── db/migrations/       # 36 SQL migrations (001-036)
│   │   ├── tests/               # Unit + integration tests (Jest)
│   │   └── docker-compose.prod.yml
│   ├── web-dashboard/       # Next.js 16 + Tailwind + SWR
│   │   └── src/
│   │       ├── app/             # 25 pages (App Router)
│   │       ├── components/      # UI components (Sidebar, panels)
│   │       └── lib/             # API client, types
│   ├── rules/               # @gitwire/rules — config, expression engine, quality gates
│   ├── runtime/             # @gitwire/runtime — DB, Redis, logger, GitHub factories
│   ├── core/                # @gitwire/core shared constants
│   │   └── src/index.js         # QUEUES, HEAL_STATUS, FAILURE_TYPES, etc.
│   └── (stubs: triage, healer, maintainer, mcp, cli, quality-gate, ai-skills, insights)
├── docs/                    # VitePress documentation site (114+ pages)
└── docker-compose.yml
```

## Critical Constraints

When modifying this codebase, ALWAYS follow these rules:

### Octokit Usage
- `@octokit/app` returns **core Octokit WITHOUT `rest` plugin**
- Use `octokit.request('GET /repos/:owner/:repo')` style
- NEVER use `octokit.rest.repos.*` — it will crash
- NEVER use `octokit.graphql()` — the GraphQL plugin is not included

### Database
- **`issues` table has NO `body` column** — only `title`, `state`, `labels`, triage fields
- Column naming: `triage_type`, `triage_priority`, `triage_summary` (not `type`/`priority`)
- CI runs: `heal_failure_type` (not `failure_type`)
- Pull requests: `head_branch` (not `head_ref`)
- Use `addParam()` or `$N` placeholders for ALL parameters including LIMIT/OFFSET
- NEVER interpolate user input into SQL strings
- Append `::text` to ILIKE parameters for type casting

### Error Handling
- NEVER use `.catch(() => {})` — always log: `.catch(err => logger.warn('context:', err.message))`
- Sync errors must always be logged, never silently caught

### Workers
- Job names for sync worker must be exactly: `full-sync`, `sync-installation`, or `sync-repo`
- Queue names come from `@gitwire/core` QUEUES constant

### API Patterns
- All routes use `reposRouter.get("/")` style (camelCase variable + method)
- API key auth via `Authorization: Bearer KEY` header
- Pagination via `page` + `limit` query params
- Responses: `{ data: [...], pagination: { page, limit, total, pages } }` or `{ data: [...], meta: { total, limit, offset } }`

### Dashboard Patterns
- Object-shaped API responses use raw `useSWR<T>` with `fetcher`
- Array-shaped responses use `useApi<T>` hook (auto-unwraps)
- UI components: Badge, StatCard, EmptyState, PageHeader from `@/components/ui`
- NO Card, Table, MetricGrid — use raw HTML `<div className="card">` and `<table>`
- Turbopack parser requires `catch (_e)` not bare `catch`

### Rules Package
- Expression engine: recursive-descent parser with precedence levels
- Plugin files use CJS `module.exports` (sandbox wraps in `new Function()`)
- Exports map must include both extensionless and `.js` patterns for ESM
- `some()`/`all()` evaluate inner expression per array element
- Named expressions pre-resolved before rule evaluation

## Running Locally

```bash
# Install dependencies
npm install

# Set up environment
cp packages/web/.env.example packages/web/.env
# Edit .env with your values

# Start PostgreSQL + Redis (Docker)
cd packages/web
docker compose up -d postgres redis

# Run migrations
npm run db:migrate

# Start the API server
cd packages/web
npm run dev

# Run tests
npm test                    # All workspaces (251 tests)
cd packages/rules && npm test   # 184 rules tests
cd packages/runtime && npm test # 16 runtime tests
```

## Testing

- **2,196 tests** across 60 suites:
  - `@gitwire/rules`: expression engine, gates, parsing, plugins, helpers
  - `@gitwire/runtime`: factory patterns, compat layer
  - `@gitwire/web`: 60 suites — services, repair proposals, execution receipts, isolation evidence, pass-capable unlock
  - `@gitwire/web-dashboard`: API client, components
- Run all: `cd packages/web && NODE_OPTIONS="--experimental-vm-modules" npx jest --config jest.config.js --no-coverage`
- Rules/engine tests require `--experimental-vm-modules`

## Common Tasks

### Adding a new API endpoint
1. Add route handler in `packages/web/src/routes/<route>.js`
2. Mount in `packages/web/src/app.js` with `app.use("/api/path", router)`
3. Add test in `packages/web/tests/api.<route>.test.js`

### Adding a new database table
1. Create migration in `packages/web/db/migrations/NNN_name.sql`
2. Follow naming: `snake_case`, plural table names, `BIGSERIAL PRIMARY KEY`
3. Always include `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

### Adding a new worker
1. Create worker in `packages/web/src/workers/<name>Worker.js`
2. Add queue name to `packages/core/src/index.js` QUEUES constant
3. Import and start in `packages/web/src/index.js`

### Adding a new dashboard page
1. Create page at `packages/web-dashboard/src/app/<slug>/page.tsx`
2. Add sidebar entry in `packages/web-dashboard/src/components/Sidebar.tsx`
3. Add API URL helper in `packages/web-dashboard/src/lib/api.ts`

## Style Guide

- **JavaScript** (not TypeScript for backend) — JSDoc comments for type hints
- **TypeScript** for dashboard (strict mode)
- **2-space indentation**
- **Async/await** — no raw promises or callbacks
- **ESM** — use `import`/`export`, not `require()`
- **Parameterized queries** — never string-concatenate SQL

## No Co-Authored-By

Do NOT add `Co-Authored-By: Craft Agent` or any AI co-authorship to commits.

## DCO Sign-Off

All commits MUST be signed off:
```bash
git commit -s -m "your message"
```

## Pre-Release Checklist

Before tagging ANY release:

1. Run the full test suite — all suites must pass
2. Update version in ALL package.json files (root + every package)
3. Run `git commit -s` with the release message
4. Tag: `git tag -a v0.XX.0 -m "release notes"`
5. Push: `git push origin master && git push origin v0.XX.0`
6. Create GitHub release
7. **Follow `docs/installation/deployment-runbook.md`** to deploy to CT 115
   (export `GITWIRE_COMMIT_SHA` before `docker compose build`, use `--force-recreate`)
8. Verify the running container version matches the tag
9. Verify `/health.git_sha` is NOT `"unknown"` and matches the deployed commit
   (if `"unknown"`, GITWIRE_COMMIT_SHA was not exported at build time — rebuild)
10. Verify all migrations are applied in the production database
11. Smoke test the API at `https://gitwire.erlab.uk/health`

Steps 7-11 are MANDATORY. A release is not complete until the running system
reflects it — and `git_sha="unknown"` does NOT count as reflecting it.
