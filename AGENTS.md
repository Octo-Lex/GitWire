# AGENTS.md — GitWire AI Agent Guide

This file provides context for AI coding agents interacting with the GitWire codebase and API.

## About GitWire

GitWire is a self-hosted GitHub App that automates repository management using AI (Claude). It's an open-source monorepo (MIT license) with a Node.js backend and Next.js dashboard. Current version: **0.11.0**.

## Repository Structure

```
GitWire/
├── packages/
│   ├── web/                 # Express API server + 9 background workers
│   │   ├── src/
│   │   │   ├── app.js           # Express app setup, route mounting
│   │   │   ├── index.js         # Entry: starts server + all workers
│   │   │   ├── routes/          # 21 route files
│   │   │   ├── services/        # 25 business logic modules
│   │   │   ├── workers/         # 9 BullMQ background workers
│   │   │   ├── lib/             # GitHub client, queue helpers, DB
│   │   │   └── middleware/      # Auth, pagination, rate limiting
│   │   ├── db/migrations/       # 18 SQL migrations (44 tables + 1 view)
│   │   ├── tests/               # Unit + integration tests (Jest)
│   │   └── docker-compose.prod.yml
│   ├── web-dashboard/       # Next.js 16 + Tailwind + SWR
│   │   └── src/
│   │       ├── app/             # 24 pages (App Router)
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

- **251 tests total** across 4 suites:
  - `@gitwire/rules`: 184 tests (expression engine, gates, parsing, plugins, helpers)
  - `@gitwire/runtime`: 16 tests (factory patterns, compat layer)
  - `@gitwire/web`: 44 service unit tests (+ integration tests requiring live API)
  - `@gitwire/web-dashboard`: 66 tests (API client, components)
- Run all: `npm test` (root, uses `--workspaces --if-present`)
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
