# AGENTS.md — GitWire AI Agent Guide

This file provides context for AI coding agents interacting with the GitWire codebase and API.

## About GitWire

GitWire is a self-hosted GitHub App that automates repository management using AI (Claude). It's an open-source monorepo (MIT license) with a Node.js backend and Next.js dashboard.

## Repository Structure

```
GitWire/
├── packages/
│   ├── web/                 # Express API server + 9 background workers
│   │   ├── src/
│   │   │   ├── app.js           # Express app setup, route mounting
│   │   │   ├── index.js         # Entry: starts server + all workers
│   │   │   ├── routes/          # 14 route files, 102 endpoints
│   │   │   ├── services/        # 17 business logic modules
│   │   │   ├── workers/         # 9 BullMQ background workers
│   │   │   ├── lib/             # GitHub client, queue helpers, DB
│   │   │   └── middleware/      # Auth, pagination, rate limiting
│   │   ├── db/migrations/       # 11 SQL migrations (36 tables)
│   │   ├── tests/               # 49 integration tests (Jest + supertest)
│   │   └── docker-compose.prod.yml
│   ├── web-dashboard/       # Next.js 16 + Tailwind + SWR
│   │   └── src/
│   │       ├── app/             # 12 pages (App Router)
│   │       ├── components/      # UI components
│   │       └── lib/             # API client, types
│   └── core/                # @gitwire/core shared constants
│       └── src/index.js         # QUEUES, HEAL_STATUS, FAILURE_TYPES, etc.
├── docs/                    # VitePress documentation site (83 pages)
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
- Use `addParam()` for ALL parameters including LIMIT/OFFSET in paginated queries
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
- Responses: `{ data: [...], pagination: { page, limit, total, pages } }`

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
docker exec -it gitwire-postgres psql -U gitwire -d gitops_hub -f /docker-entrypoint-initdb.d/001_initial_schema.sql

# Start the API server
cd packages/web
npm run dev

# Run tests (against live API at https://gitwire.erlab.uk)
cd packages/web
npm test
```

## Testing

- 49 integration tests across 9 test suites
- Tests use `fetch()` against the live production API
- Located in `packages/web/tests/`
- Run with `npm test` (uses Jest)

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

## Style Guide

- **JavaScript** (not TypeScript for backend) — JSDoc comments for type hints
- **2-space indentation**
- **Async/await** — no raw promises or callbacks
- **ESM** — use `import`/`export`, not `require()`
- **Parameterized queries** — never string-concatenate SQL

## No Co-Authored-By

Do NOT add `Co-Authored-By: Craft Agent` or any AI co-authorship to commits.
