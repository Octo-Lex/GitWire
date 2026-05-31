# Package Dependencies

## Current State (v0.12.0)

```mermaid
graph TD
    core["@gitwire/core<br/>Constants + Enums<br/>72 lines, 0 deps"]
    runtime["@gitwire/runtime<br/>db, queue, logger, GitHub client<br/>8 deps: pg, bullmq, ioredis, pino, @octokit/*"]
    rules["@gitwire/rules<br/>Config schema, validation, helpers<br/>251 tests"]
    web["@gitwire/web<br/>Express API + Workers + Routes<br/>34 services, 10 workers"]
    dashboard["@gitwire/web-dashboard<br/>Next.js dashboard<br/>22 pages"]
    bot["@gitwire/bot<br/>Telegram bot (grammy)<br/>13 commands"]
    demo["@gitwire/demo-dashboard<br/>Static demo site<br/>15 pages"]

    web -->|"QUEUES, enums"| core
    web -->|"initRuntime(config)"| runtime
    web -->|"isPillarEnabled, scoreCIRisk"| rules
    runtime -->|"QUEUES"| core
    dashboard -->|"fetches from API"| web
    bot -->|"notifications bridge"| web

    style core fill:#4ade80,color:#000
    style runtime fill:#60a5fa,color:#000
    style rules fill:#fbbf24,color:#000
```

## @gitwire/runtime Architecture

### Factory Pattern

Each infrastructure module is a factory function that accepts config — no config imports:

| Factory | Accepts | Returns |
|---------|---------|---------|
| `createLogger({ logLevel, env })` | Server config | pino Logger |
| `createDatabase({ url, logger })` | DB URL + logger | `{ query, transaction, end, pool }` |
| `createRedisConnection(url, { logger })` | Redis URL + logger | IORedis instance |
| `createQueue(redis, name)` | Redis + queue name | BullMQ Queue |
| `createWorker(redis, name, processor, opts)` | Redis + processor | BullMQ Worker |
| `createGitHubApp({ appId, privateKey, ... })` | GitHub credentials | `{ getWebhookApp, getInstallationClient, forEachInstallation, forEachRepo }` |

### Init Pattern

```javascript
// Called once at startup (src/index.js)
import { initRuntime } from "@gitwire/runtime";
const runtime = initRuntime(config);  // { logger, db, redis, github, QUEUES }
```

### Compat Layer (backward compatibility)

`compat/` modules provide lazy proxies that delegate to the runtime. This means all existing imports keep working:

```javascript
// Old code still works — zero changes needed
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redis, createQueue, webhookQueue } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
```

The `lib/*.js` files are now thin re-exports from `@gitwire/runtime/compat/*`.

### Auto-initialization

Workers call `createQueue()` at module top level (before `main()` runs). The compat layer handles this via `ensureRuntime()` which picks up the config set by `config/index.js` through `setConfig()`.

## Dependency Inventory

### What lives where

| Module | Package | Lines | Dependencies |
|--------|---------|-------|--------------|
| Constants/enums | `@gitwire/core` | 72 | None |
| DB client | `@gitwire/runtime` (factory) | 67 | pg |
| Queue factory | `@gitwire/runtime` (factory) | 72 | bullmq, ioredis |
| Logger | `@gitwire/runtime` (factory) | 24 | pino |
| GitHub client | `@gitwire/runtime` (factory) | 91 | @octokit/app |
| Config schema + helpers | `@gitwire/rules` | ~600 | js-yaml, minimatch |
| Config validation | `@gitwire/web/config/` | 172 | zod, dotenv |
| Services (34) | `@gitwire/web/src/services/` | ~8,000 | runtime, rules, anthropic |
| Workers (10) | `@gitwire/web/src/workers/` | ~4,000 | runtime, rules, services |
| Routes (26) | `@gitwire/web/src/routes/` | ~3,000 | runtime, services |

### Test coverage

| Package | Tests | Type |
|---------|-------|------|
| `@gitwire/core` | — | Constants only |
| `@gitwire/rules` | 251 | Pure unit tests |
| `@gitwire/runtime` | 16 | Factory + init tests |
| `@gitwire/web` | 245 unit + 80 E2E | Unit, integration, stress |
| **Total** | **512** | |

## Package Role Taxonomy

| Package | Role | Runtime deps | Pure/testable without DB? |
|---------|------|-------------|--------------------------|
| `@gitwire/core` | Constants, enums | None | ✅ Yes |
| `@gitwire/runtime` | DB, queue, logger, GitHub | pg, bullmq, ioredis, pino, @octokit/* | ❌ No — needs Postgres, Redis |
| `@gitwire/rules` | Config schema, validation, scoring | None | ✅ Yes |
| `@gitwire/web` | API surface, orchestration | express, helmet, cors, everything | ❌ No |
| `@gitwire/web-dashboard` | Browser UI | next, swr, tailwind | ✅ Yes (mock API) |
| `@gitwire/bot` | Telegram bot | grammy | ❌ No — needs Redis + API |
| `@gitwire/demo-dashboard` | Static demo | next (export) | ✅ Yes |
