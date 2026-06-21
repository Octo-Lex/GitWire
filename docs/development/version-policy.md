# Version Policy

## Source of truth

**Root `package.json` is the single source of truth for the release version.**

All other version surfaces must match it. The `check-version-drift.js` script
enforces this in CI.

## Required to match

| Surface | Location |
|---|---|
| Root package.json | `package.json` |
| Lockfile | `package-lock.json` |
| All workspace packages | `packages/*/package.json` |
| Core build-info fallback | `packages/core/src/buildInfo.js` |
| Dashboard build-info fallback | `packages/web-dashboard/src/lib/buildInfo.ts` |
| Docker compose defaults | `GITWIRE_VERSION` default in `docker-compose.yml` |

## Build-info architecture

Build-info is split into two modules:

### Backend (`packages/core/src/buildInfo.js`)

- Committed fallback carries the current release version.
- `scripts/generate-build-info.js` overwrites it during Docker builds with the
  real version, git SHA, and timestamp.
- `VERSION` is re-exported from here via `packages/core/src/index.js`.
- The health endpoint (`deploymentInfo.js`) reads `VERSION` and
  `process.env.GITWIRE_COMMIT_SHA`.

### Dashboard (`packages/web-dashboard/src/lib/buildInfo.ts`)

- Env-aware: reads `NEXT_PUBLIC_GITWIRE_VERSION`,
  `NEXT_PUBLIC_GITWIRE_COMMIT_SHA`, `NEXT_PUBLIC_GITWIRE_BUILT_AT`.
- The dashboard Dockerfile sets these as build args.
- Falls back to committed defaults when env vars are absent (local dev, tests).
- Does NOT need to be overwritten by the generator script — the env vars handle
  it at build time.

## Docker injection

The app Dockerfile accepts `GITWIRE_COMMIT_SHA` as a build arg and runs the
generator before the entrypoint. The dashboard Dockerfile accepts
`GITWIRE_VERSION`, `GITWIRE_COMMIT_SHA`, and `GITWIRE_BUILT_AT` as build args,
exposing them as `NEXT_PUBLIC_*` env vars for Next.js to bundle.

When building locally:

```bash
GITWIRE_COMMIT_SHA=$(git rev-parse --short=12 HEAD) docker compose build
```

## Version bump procedure

When bumping the version for a release:

1. Update root `package.json` version.
2. Run `npm run build-info:generate` (overwrites the fallback).
3. Update all workspace `package.json` files and `package-lock.json`.
4. Update the `GITWIRE_VERSION` default in `docker-compose.yml`.
5. Run `npm run build-info:check` — must pass.
6. Commit with `-s` (DCO).

Or use the runbook's sed loop for mechanical bumps across all package.json files.

## CI enforcement

`scripts/check-version-drift.js` runs in the `syntax-check` CI job, before
`npm install`. It verifies all surfaces agree and fails the build on drift.
