# Local Development

How to set up and run GitWire locally for development.

## Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| Node.js | 20 LTS | [nodejs.org](https://nodejs.org/) |
| npm | 10+ | Included with Node.js |
| Docker | 24+ | [docker.com](https://www.docker.com/) |
| Git | 2.40+ | [git-scm.com](https://git-scm.com/) |

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/Elephant-Rock-Lab/GitWire.git
cd GitWire
npm install
```

### 2. Configure Environment

```bash
cp packages/web/.env.example packages/web/.env
```

Edit `packages/web/.env`:

```bash
# Required for local dev
GITHUB_APP_ID=your_app_id
GITHUB_WEBHOOK_SECRET=your_secret
GITHUB_PRIVATE_KEY_PATH=./config/private-key.pem
DATABASE_URL=postgresql://gitwire:password@localhost:5432/gitops_hub
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=your-key
APP_BASE_URL=http://localhost:3000
```

### 3. Start Dependencies

```bash
cd packages/web
docker compose up -d postgres redis
```

This starts PostgreSQL 16 and Redis 7 in Docker. Migrations run automatically on first start.

### 4. Start the API Server

```bash
cd packages/web
npm run dev
```

The server starts at `http://localhost:3000`. You should see:

```
GitWire API v0.11.0 running on :3000
9 workers started
Connected to PostgreSQL
Connected to Redis
```

### 5. Start the Dashboard (Optional)

```bash
cd packages/web-dashboard
npm run dev
```

The dashboard starts at `http://localhost:3001`.

### 6. Start the Docs (Optional)

```bash
cd docs
npm run docs:dev
```

Documentation site at `http://localhost:5173/docs/`.

## Running Tests

```bash
cd packages/web
npm test
```

251 tests across rules (184), runtime (16), web service (44), and dashboard (66) suites. Integration tests run against the **live production API** at `https://gitwire.erlab.uk` (not localhost). Ensure you have network access. Unit/service tests can run offline with `--testPathPattern="unit"`.

## Project Structure

```
packages/web/
├── src/
│   ├── app.js              # Express setup + route mounting
│   ├── index.js             # Entry point (server + workers)
│   ├── config/index.js      # Environment config
│   ├── routes/              # API endpoint handlers
│   ├── services/            # Business logic
│   ├── workers/             # BullMQ background workers
│   ├── lib/
│   │   ├── db.js            # PostgreSQL connection pool
│   │   ├── github.js        # @octokit/app setup
│   │   ├── queue.js         # BullMQ queue factory
│   │   └── commentRouter.js # /gitwire command router
│   └── middleware/
│       ├── auth.js          # API key authentication
│       ├── pagination.js    # Page/limit parsing
│       └── rateLimiter.js   # Redis rate limiting
├── db/migrations/           # SQL migrations (001–018)
├── tests/                   # Unit + integration tests
├── docker/                  # Docker configs
└── docker-compose.prod.yml  # Production Docker Compose
```

## Database

### Migrations

Migrations are plain SQL files in `db/migrations/`. They run automatically via PostgreSQL's `docker-entrypoint-initdb.d` on first container start.

To add a new migration:

1. Create `packages/web/db/migrations/012_your_feature.sql`
2. Use `CREATE TABLE IF NOT EXISTS` for idempotency
3. Follow the naming conventions: `snake_case`, plural table names

### Connecting Manually

```bash
docker exec -it gitwire-postgres psql -U gitwire -d gitops_hub

# List tables
\dt

# Check a table
SELECT * FROM issues LIMIT 5;
```

## Debugging

### Worker Issues

```bash
# Check worker logs
docker compose logs -f gitwire-app

# Check Redis queues
docker exec -it gitwire-redis redis-cli
> KEYS bull:*
> LLEN bull:webhook-events:wait
```

### API Issues

```bash
# Health check
curl http://localhost:3000/health

# Test an endpoint
curl http://localhost:3000/api/repos \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Database Issues

```bash
# Check connection
docker exec -it gitwire-postgres pg_isready -U gitwire

# Check migrations
docker exec -it gitwire-postgres psql -U gitwire -d gitops_hub -c "\dt"
```

## Common Tasks

### Add a New API Endpoint

1. Create handler in `src/routes/yourRoute.js`
2. Mount in `src/app.js`: `app.use("/api/your-route", yourRouter)`
3. Add test in `tests/api.your-route.test.js`

### Add a New Database Table

1. Create migration in `db/migrations/NNN_name.sql`
2. Include `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
3. Use `BIGSERIAL PRIMARY KEY` for ID columns
4. Use `BIGINT REFERENCES table(column)` for foreign keys

### Add a New Worker

1. Create `src/workers/yourWorker.js`
2. Add queue name to `packages/core/src/index.js` QUEUES constant
3. Import and start in `src/index.js`
