# Source-of-Truth Inventory

> Derived from `16b9291c9bc9a3eacf95de5d350cfa34046cc944` (master tip, 2026-07-19).
> Every value in this table was read from the checked-out code, not from memory
> or documentation. This document is the authoritative basis for the P1
> documentation reconciliation.

## Verified facts

| Claim | Authoritative source | Verified value |
|---|---|---|
| **Service count** | `docker-compose.yml` (service: blocks only, excluding volumes/networks) | **10** (gitwire-app, gitwire-executor-service, postgres, redis, bot, landing, tunnel, dashboard, docs, demo) |
| **Worker count** | `packages/web/src/index.js` (`start*Worker()` calls) | **14** (webhook, triage, CIHeal, CIEvidence, diagnosis, patch, verification, critic, sync, maintainer, issueFix, mergeQueue, phase3, phase4) |
| **Reconciliation** | `packages/web/src/index.js` (scheduled separately) | Every 6h via `setInterval` + initial run after 5 min |
| **Migration count** | `packages/web/db/migrations/` (file count) | **37** (001–037) |
| **Redis policy** | `docker-compose.yml` (redis service command) | `maxmemory 256mb`, `maxmemory-policy noeviction` |
| **Application image** | Root `Dockerfile` | `ENTRYPOINT ["docker-entrypoint.sh"]` + `CMD ["node", "src/index.js"]`; entrypoint runs `node scripts/migrate.js` fail-closed |
| **Migration startup** | Root `docker-entrypoint.sh` | Runs `node scripts/migrate.js` before `exec "$@"`; exits non-zero on failure |
| **Package version** | `package.json` (root) | `0.23.1` |
| **Secondary Dockerfile** | `packages/web/Dockerfile` | **Deleted** — the only consumer was `packages/web/docker-compose.prod.yml` (a stale legacy package-local Compose file). CI and dev overrides use root `Dockerfile`. Both `packages/web/Dockerfile` and `packages/web/docker-compose.prod.yml` deleted in P1 as retired legacy deployment surfaces. |

## Discrepancies found

| Document | Claim | Actual | Correction |
|---|---|---|---|
| `AGENTS.md` | Version `0.20.0` | `0.23.1` | Update to `0.23.1` |
| `AGENTS.md` | `9 background workers` | `14` worker handles | Update to `14` |
| `AGENTS.md` | `10 BullMQ background workers` | `14` worker handles (reconciliation scheduled separately) | Consolidate: "14 BullMQ worker handles plus reconciliation scheduled separately" |
| `AGENTS.md` | `36 SQL migrations (001-036)` | `37` (001–037) | Update to `37` |
| `infrastructure.md` | `9 services` | `10` services (omits executor-service) | Update to `10` |
| `infrastructure.md` | `Express API + 9 background workers` | `14` worker handles | Update to `14` |
| `infrastructure.md` | `no migration runner in the app startup code` | Root `docker-entrypoint.sh` runs `node scripts/migrate.js` fail-closed | Document the entrypoint |
| `infrastructure.md` | `No maxmemory limit is configured` + recommends `allkeys-lru` | `256mb` + `noeviction` is configured in compose | Correct to `noeviction`/`256mb` |
| `packages/web/Dockerfile` | Implies it is a production image (has `HEALTHCHECK`, `EXPOSE 3000`) | Referenced only by stale `packages/web/docker-compose.prod.yml`; CI and dev override both use root `Dockerfile` | **Retire both** — legacy package-local deployment surfaces |

## Secondary Dockerfile resolution

`packages/web/Dockerfile` was referenced only by `packages/web/docker-compose.prod.yml` — a stale legacy package-local Compose file that predates the immutable root Compose model. Neither file is referenced by CI, the root `docker-compose.yml`, the dev override, or any deployment script.

Decision: **Delete both** as retired legacy deployment surfaces. Add a static check in CI preventing reintroduction of a second app Dockerfile.

## Authoritative source hierarchy

When documentation disagrees with code:

1. **`docker-compose.yml`** is the authoritative source for the production service topology, Redis policy, and image references.
2. **`packages/web/src/index.js`** is the authoritative source for the worker count.
3. **`packages/web/db/migrations/`** is the authoritative source for the migration count.
4. **Root `Dockerfile`** is the authoritative source for the production app image (build, entrypoint, CMD).
5. **Root `package.json`** is the authoritative source for the version number.
6. **`docker-entrypoint.sh`** is the authoritative source for the migration-on-startup behavior.
