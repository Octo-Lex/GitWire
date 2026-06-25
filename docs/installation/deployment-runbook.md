# Deployment Runbook

> **Read this before and after every release.**
> This runbook documents the exact steps to deploy GitWire to production and
> verify the deployment is healthy. It exists because version drift, missed
> migrations, and unverified deploys have caused real problems.

## Prerequisites

- SSH key access to CT 115 (`ssh root@192.168.3.151`)
- Or SSH access via Proxmox host (`ssh root@192.168.3.5` → `pct exec 115 -- bash`)
- The repository cloned at `/opt/gitwire` inside CT 115

---

## Post-Release Deployment Checklist

**Run this after every merge to `master` or version tag.**

### Step 1: Pull the Latest Code

```bash
ssh root@192.168.3.151
cd /opt/gitwire
git pull origin master
```

**Verify:**
```bash
git log --oneline -1
# Must show the latest commit / release tag
```

### Step 2: Apply Database Migrations

> **⚠️ CRITICAL:** PostgreSQL's `docker-entrypoint-initdb.d` only runs on
> *first database creation*. New migration files are NOT applied
> automatically on container restart by Postgres itself.

> **v0.20.1+:** The app container's entrypoint (`docker-entrypoint.sh`)
> runs `node scripts/migrate.js` automatically on every start, before the
> app boots. So after v0.20.1, migrations apply as part of the rebuild
> (Step 3) and this manual step is only needed for one-off reconciliation
> or if the entrypoint is bypassed.

**Canonical path — the migration runner (idempotent, transactional):**

```bash
docker exec -w /app gitwire-gitwire-app-1 node scripts/migrate.js
```

This reads `DATABASE_URL` from the app container's environment (already
correct — it resolves to the `postgres` service hostname on the Docker
network, not `localhost`). It skips already-applied migrations and wraps
each new one in its own transaction, recording it in `schema_migrations`
only after the SQL succeeds.

**Fallback: manual migration recovery** (only if the runner is unavailable
or you need to reconcile a partial-apply state — see Troubleshooting below):

```bash
# Check current migration status
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub \
  -c "SELECT version FROM schema_migrations ORDER BY version;"

# List all migration files available
ls /opt/gitwire/packages/web/db/migrations/*.sql | sort
```

The manual per-file `psql < "$mig"` + separate `INSERT INTO schema_migrations`
loop is **less safe** than the runner because the insert runs as a separate
statement — if it fails after the SQL applied, you get a silently-applied-
but-unrecorded migration. Prefer the runner.

**Verify:**
```bash
# Migration count must match file count
echo "Files: $(ls /opt/gitwire/packages/web/db/migrations/*.sql | wc -l)"
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub \
  -c "SELECT COUNT(*) FROM schema_migrations;"
```


### Step 3: Rebuild and Restart Containers

> **⚠️ Two operational blind spots this step guards against** (learned from
> the v0.22.0 deploy on 2026-06-21):
>
> 1. **Stale git_sha in `/health`.** If `GITWIRE_COMMIT_SHA` is not exported
>    in the shell before `docker compose build`, the image's
>    `generate-build-info.js` writes `git_sha: "unknown"` into `buildInfo.js`.
>    `/health.git_sha` then reports `"unknown"` forever, breaking the
>    "git_sha matches deployed commit" acceptance check.
> 2. **Container not recreated.** `docker compose up -d --build` rebuilds the
>    image but does NOT always recreate the container — compose may leave an
>    existing healthy container running on the OLD image. The v0.22.0 deploy
>    shipped v0.22.0 in the image while the container kept serving v0.21.0
>    code until `--force-recreate` was used.

```bash
cd /opt/gitwire

# Export the commit SHA so the build bakes it into /health.git_sha.
# Must be set BEFORE `docker compose build`, not just before `up`.
export GITWIRE_COMMIT_SHA="$(git rev-parse --short=12 HEAD)"

# v0.23.0+: Export the Docker socket GID so the executor-service container
# (running as non-root uid 1000) can access /var/run/docker.sock.
# The socket is typically root:docker (gid ~998) with 0660 permissions.
# Without this, docker info inside the executor service fails with
# "permission denied". Default 998 matches most Debian/Ubuntu systems.
export DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"
echo "Docker socket GID: $DOCKER_SOCKET_GID"

# Rebuild with --no-cache to guarantee the new code lands in the image layer
# (cache hits on an identical-looking context can otherwise ship stale code).
docker compose build --no-cache

# Force-recreate so the running container actually adopts the new image.
# `up -d --build` alone is NOT sufficient — see the warning above.
docker compose up -d --force-recreate
```

> **⚠️ Compose env sourcing (v0.23.0+):** The executor-service token and
> validator image env vars are **Compose-time substitutions** (`${VAR:-...}`
> in the `environment:` block). Compose resolves these from the **shell
> environment or a project-root `.env` file** — NOT from `packages/web/.env`
> (which is the app container's `env_file`, read at container runtime, not
> at Compose interpolation time). Set these in the shell or project-root
> `.env` before `docker compose up`:
>
> ```bash
> # Generate a shared token (must be identical in both containers — compose
> # interpolates it into both services' environment blocks).
> echo "GITWIRE_EXECUTOR_SERVICE_TOKEN=$(openssl rand -hex 32)" >> .env
>
> # Validator image identity (optional pre-Task-8; required for pass-capable).
> # echo "GITWIRE_VALIDATOR_IMAGE_REF=registry.example.com/v@sha256:..." >> .env
> # echo "GITWIRE_VALIDATOR_IMAGE_DIGEST=sha256:..." >> .env
> ```

**Verify all containers are healthy:**
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep gitwire
# All 10 containers must show "(healthy)" — no "restarting" or "unhealthy"
# (v0.23.0+: includes gitwire-executor-service)
```

### Step 4: Verify Version String AND git_sha

> The running container must match the tag on **both** axes: version label
> AND git_sha. A version match alone is insufficient — a stale image could
> report the right version string with the wrong code if build-info wasn't
> regenerated.

```bash
# 4a. Container package.json version must match the git tag.
docker exec gitwire-gitwire-app-1 cat /app/package.json | grep '"version"'
# Expected: the version you just released (e.g. "0.22.0")

# If mismatched, the package.json files need bumping — see Version Hygiene below.

# 4b. /health.version + /health.git_sha must both match the deployed tag.
curl -s http://localhost:3000/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
assert h['version'] == 'EXPECTED_VERSION', f\"version: {h['version']}\"
assert h['git_sha'] != 'unknown', 'git_sha is unknown — GITWIRE_COMMIT_SHA was not exported at build time (see Step 3)'
assert h['git_sha'] == 'EXPECTED_SHA_PREFIX', f\"git_sha: {h['git_sha']}\"
print('OK: version={} git_sha={}'.format(h['version'], h['git_sha']))
"
# Replace EXPECTED_VERSION and EXPECTED_SHA_PREFIX with the tag's values.

# git_sha="unknown" is a RELEASE VERIFICATION FAILURE. It means the deploy
# cannot prove which commit is running. Rebuild with GITWIRE_COMMIT_SHA
# exported (Step 3) and redeploy.
```

### Step 4.5: Verify the Container is Using the New Image

> Belt-and-suspenders check for the "container not recreated" blind spot.
> Even with `--force-recreate`, confirm the container's image ID is the one
> you just built.

```bash
# Image ID the container is running:
docker inspect -f '{{.Image}}' gitwire-gitwire-app-1
# Image ID of the freshly built image:
docker images --format '{{.ID}}' gitwire-gitwire-app:latest
# These must match. If they differ, the container is on a stale image —
# re-run `docker compose up -d --force-recreate`.
```

### Step 4.7: Verify Executor Service (v0.23.0+)

> The executor service runs validator containers via the CT-local Docker socket.
> It is a compose sibling of `gitwire-app` — the app has zero Docker authority;
> only the executor service holds the socket. This step verifies the service is
> healthy, reachable from the app, and correctly configured.

```bash
# 4.7a. Executor service container is healthy.
docker inspect -f '{{.State.Health.Status}}' gitwire-gitwire-executor-service-1
# Expected: "healthy"

# 4.7b. Executor service /health responds.
docker exec gitwire-gitwire-executor-service-1 wget -qO- http://localhost:3003/health | python3 -m json.tool
# Expected fields:
#   status = "ok"
#   executor_service_id = "executor-service"
#   deployment_mode = "compose-local"
#   container_runtime = "docker" (or "podman")
#   runtime_version = detected
#   ready = true ONLY when runtime reachable + validator identity configured
#   ready = false when validator image not yet configured (expected before Task 8)

# 4.7c. App sees the executor service as the selected backend.
curl -s http://localhost:3000/health | python3 -c "
import sys, json
h = json.load(sys.stdin)
ex = h.get('executor', {})
print('selected_backend_id:', ex.get('selected_backend_id'))
print('selected_backend_reachable:', ex.get('selected_backend_reachable'))
print('selected_pass_capable:', ex.get('selected_pass_capable'))
v = h.get('validator', {})
print('validator.pass_capable:', v.get('pass_capable'))
print('validator.reason:', v.get('reason'))
"
# Expected after Task 7 (no validator image configured yet):
#   selected_backend_id = executor-service
#   selected_backend_reachable = true (or false if socket issue)
#   selected_pass_capable = false (validator identity not configured)
#   validator.pass_capable = false
#   validator.reason = "validator_image_not_configured"
#
# After Task 8 (validator image configured):
#   selected_backend_id = executor-service
#   selected_backend_reachable = true
#   selected_pass_capable = true
#   validator.pass_capable = true
#   validator.reason = "configured_and_pass_capable"
```

> **⚠️ Docker socket troubleshooting:** If `selected_backend_reachable = false`
> and the executor service's `/health` shows `ready = false` with
> `container_runtime = null`, the Docker socket mount or group access may have
> failed. Check:
> ```bash
> # 1. Verify the socket GID was exported before compose up.
> echo "DOCKER_SOCKET_GID=$DOCKER_SOCKET_GID"
> # If empty, export it and recreate the executor-service container:
> export DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)"
> docker compose up -d --force-recreate gitwire-executor-service
>
> # 2. Verify docker info works inside the executor container.
> docker exec gitwire-gitwire-executor-service-1 docker info
> # "permission denied" → group_add didn't match the socket's gid.
> #   Fix: ensure DOCKER_SOCKET_GID matches stat -c '%g' /var/run/docker.sock.
> # "cannot connect" → host Docker daemon not running or socket path differs.
> ```

### Step 5: Verify Database Schema

```bash
# Check that new tables from the release exist
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;"
```

### Step 6: Smoke Test the API

```bash
# Health endpoint
curl -s http://localhost:3000/health | python3 -m json.tool

# Readiness endpoint
curl -s http://localhost:3000/readiness | python3 -m json.tool
```

### Step 7: Check Logs for Errors

```bash
# Last 50 lines of app logs — look for errors/exceptions
docker logs gitwire-gitwire-app-1 --tail 50 2>&1 | grep -i error

# Worker startup confirmation
docker logs gitwire-gitwire-app-1 --tail 100 2>&1 | grep -i "worker\|started"
```

### Step 8: Verify External Access

```bash
# API must respond through the tunnel
curl -s https://gitwire.erlab.uk/health | python3 -m json.tool

# Dashboard must load
curl -sI https://gitwire.erlab.uk/dashboard | head -5
```

---

## Version Hygiene

The root `package.json` is the source of truth for the version number.
Sub-package versions must be kept in sync.

### When bumping the version

```bash
VERSION="0.20.0"

# Root
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" package.json

# Web package
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/web/package.json

# Dashboard package
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/web-dashboard/package.json

# Core package
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/core/package.json

# Runtime package
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/runtime/package.json

# Rules package
sed -i "s/\"version\": \".*\"/\"version\": \"$VERSION\"/" packages/rules/package.json

# Verify
grep '"version"' package.json packages/*/package.json
```

### Version drift test

A CI test should verify all package versions match:

```bash
ROOT_VERSION=$(node -p "require('./package.json').version")
for pkg in packages/*/package.json; do
  PKG_VERSION=$(node -p "require('./$pkg').version")
  if [ "$ROOT_VERSION" != "$PKG_VERSION" ]; then
    echo "VERSION DRIFT: $pkg has $PKG_VERSION, root has $ROOT_VERSION"
    exit 1
  fi
done
echo "All packages at v$ROOT_VERSION"
```

---

## Operational Tasks

### Clean Redis Stale Jobs

Redis accumulates completed/stalled BullMQ jobs. Clean periodically:

```bash
# Check total keys
docker exec gitwire-redis-1 redis-cli DBSIZE

# Flush completed jobs (keeps active/repeat jobs)
docker exec gitwire-redis-1 redis-cli --scan --pattern 'bull:*:completed' | \
  while read key; do
    docker exec gitwire-redis-1 redis-cli DEL "$key"
  done

# Flush stalled-check artifacts
docker exec gitwire-redis-1 redis-cli DEL bull:*stalled-check 2>/dev/null

# Verify
docker exec gitwire-redis-1 redis-cli DBSIZE
```

### Set Redis Memory Limit

> **Eviction policy must be `noeviction`, NOT `allkeys-lru`.**
> BullMQ stores active/delayed/waiting job state as Redis keys. Evicting
> them with `allkeys-lru` silently drops jobs — no error, no retry, no
> record. `noeviction` makes Redis refuse writes when full, which BullMQ
> surfaces as loud, retryable failures.

**v0.20.1+:** Redis memory limits are durable via the compose `command:`
(see `docker-compose.yml`). They survive container recreation and do not
need to be re-applied manually.

**Ephemeral fallback (pre-v0.20.1, or if the compose command is bypassed):**

```bash
# These are process-memory only — Redis runs without a config file in this
# image (CONFIG REWRITE returns "running without a config file"), so they
# are LOST on any container recreation. Use only as a stopgap.
docker exec gitwire-redis-1 redis-cli CONFIG SET maxmemory 256mb
docker exec gitwire-redis-1 redis-cli CONFIG SET maxmemory-policy noeviction

# Verify
docker exec gitwire-redis-1 redis-cli CONFIG GET maxmemory        # 268435456
docker exec gitwire-redis-1 redis-cli CONFIG GET maxmemory-policy # noeviction
```

The durable fix is the compose `command:` block (already in place post-v0.20.1):

```yaml
redis:
  command:
    - redis-server
    - --appendonly
    - "yes"
    - --maxmemory
    - 256mb
    - --maxmemory-policy
    - noeviction
```


### Adjust CT 115 Resources

```bash
# SSH to Proxmox host
ssh root@192.168.3.5

# Increase RAM (requires container restart)
pct set 115 --memory 4096

# Increase cores if needed
pct set 115 --cores 4

# Increase disk if needed
pct resize 115 rootfs +8G

# Apply changes
pct reboot 115
```

### Backup the Database

```bash
# Dump the database
docker exec gitwire-postgres-1 pg_dump -U gitwire gitops_hub > \
  /opt/gitwire/backups/gitwire-$(date +%Y%m%d-%H%M%S).sql

# Verify the dump
ls -lh /opt/gitwire/backups/

# Restore (if needed)
# docker exec -i gitwire-postgres-1 psql -U gitwire -d gitops_hub < backup.sql
```

### View Queue Depths

```bash
for q in webhook-events triage issue-fix ci-healing sync maintainer phase2 phase3 phase4; do
  count=$(docker exec gitwire-redis-1 redis-cli KEYS "bull:$q:*" 2>/dev/null | wc -l)
  echo "$q: $count keys"
done
```

---

## Operational Gotchas

### CRLF normalization during emergency `scp` hotfixes

CT 115 is Linux. Some emergency edits originate from Windows working copies.
Files transferred via `scp` arrive with CRLF line endings, while the repo
uses LF. Git then sees the *entire file* as changed (every line's ending
flipped), producing noisy full-file diffs that obscure the real change and
create review risk during incident response.

**Always normalize after `scp`-ing from a Windows host:**

```bash
# On CT 115, after copying the file:
sed -i 's/\r$//' path/to/file
```

Then verify the diff is surgical (only the intended lines), not a full-file
rewrite:

```bash
git diff --stat -- path/to/file   # should show a small line count
```

### Fail-closed entrypoint behavior (v0.20.1+)

The app container's entrypoint runs migrations before starting the app. If a
migration fails, the container **exits non-zero** and the app never starts.
This is intentional: running newer workers against an uncertain schema is
the drift class this entrypoint exists to prevent.

Symptom: container shows `Exited (1)` shortly after start, and logs show:

```
[entrypoint] running database migrations
❌ Migration failed: ...
```

Resolution: inspect the failed migration, fix the underlying issue, and
restart. Do not bypass the entrypoint to force-start the app.

### Deployment drift is now externally detectable

`/health` reports `db_migrations_applied`, `db_migrations_available`, and
`db_migration_status` (derived from the comparison). After any deploy, a
single curl confirms disk/container/database alignment without SSH:

```bash
curl -s https://gitwire.erlab.uk/health | python3 -m json.tool
# db_migration_status should be "current"
```

---

## Troubleshooting

### Container won't start after rebuild

```bash
# Check build output for errors
docker compose up -d --build 2>&1 | tail -30

# Check if the PEM key exists
ls -la /opt/gitwire/secrets/gitwire-hq.pem

# Check .env file exists
ls -la /opt/gitwire/packages/web/.env
```

### Migration fails with "already exists"

A migration may partially succeed on a previous attempt. Fix by either:

1. Dropping the partially-created objects and re-running the migration
2. Recording the migration as applied and moving on:
   ```sql
   INSERT INTO schema_migrations (version) VALUES ('0NN_name.sql');
   ```

### App crashes on startup

```bash
# Check for missing env vars
docker logs gitwire-gitwire-app-1 --tail 50

# Common causes:
# - Missing GITHUB_PRIVATE_KEY_PATH file
# - Wrong DATABASE_URL (should use 'postgres' hostname, not localhost)
# - Missing ANTHROPIC_API_KEY
```

### Workers not processing jobs

```bash
# Check Redis connectivity from the app
docker exec gitwire-gitwire-app-1 wget -qO- http://localhost:3000/health

# Check Redis
docker exec gitwire-redis-1 redis-cli ping

# Check if workers are running (look for "worker" in process list)
docker exec gitwire-gitwire-app-1 ps aux | grep node
```

---

## Post-Deployment Verification Summary

After a deployment, confirm all of the following:

| Check | Command | Expected |
|-------|---------|----------|
| Git HEAD matches release | `cd /opt/gitwire && git log --oneline -1` | Release tag |
| All migrations applied | `SELECT COUNT(*) FROM schema_migrations` | Matches file count |
| Migration status current | `curl localhost:3000/health` | `db_migration_status: "current"` |
| New tables exist | `\dt` in psql | Includes release-specific tables |
| Container version matches | `curl localhost:3000/health` (`.version`) | Release version |
| Container git_sha matches | `curl localhost:3000/health` (`.git_sha`) | Release commit SHA — **NOT `"unknown"`** |
| Container on fresh image | `docker inspect -f '{{.Image}}' gitwire-gitwire-app-1` | Matches `docker images gitwire-gitwire-app:latest -q` |
| All containers healthy | `docker ps` | 10 containers, all `(healthy)` (v0.23.0+: includes executor-service) |
| API responds | `curl localhost:3000/health` | `{"status":"ok"}` |
| External URL works | `curl https://gitwire.erlab.uk/health` | `{"status":"ok"}` |
| No errors in logs | `docker logs gitwire-gitwire-app-1 --tail 50` | No exceptions |
| Redis memory durable | `redis-cli CONFIG GET maxmemory` | `268435456` (after recreate) |
| Executor service healthy | `docker inspect -f '{{.State.Health.Status}}' gitwire-gitwire-executor-service-1` | `"healthy"` |
| Executor service reachable from app | `curl localhost:3000/health` (`.executor.selected_backend_id`) | `"executor-service"` |
| App has NO Docker socket | `docker exec gitwire-gitwire-app-1 ls /var/run/docker.sock 2>&1` | `No such file or directory` |

> `git_sha: "unknown"` in `/health` is a **release verification failure**.
> It means `GITWIRE_COMMIT_SHA` was not exported at build time (Step 3).
> The deploy cannot prove which commit is running — rebuild with the env var
> set and redeploy before considering the release complete.

---

## Repository ID Reconciliation (after repo deletion/recreation)

When deleting and recreating a monitored GitHub repository under the same
owner/name, GitHub assigns a new `repository.id`. GitWire tables may reference
that GitHub repository id directly as `repo_id` (not the internal
`repositories.id` primary key). Before deleting any repository row, inspect all
FK/reference usage and update child `repo_id` values from the old GitHub id to
the new GitHub id.

### Steps

```bash
# 1. Capture the NEW repo identity
NEW_REPO_ID=$(gh api repos/<owner>/<repo> --jq .id)

# 2. Inspect existing repository rows (look for duplicates after sync)
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -c "
  SELECT id, github_id, full_name, last_synced_at
  FROM repositories WHERE full_name = '<owner>/<repo>' ORDER BY id;"

# 3. Find ALL FK references to repositories(github_id)
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -c "
  SELECT tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'repositories'
  ORDER BY tc.table_name;"

# 4. Take a DB backup
docker exec gitwire-postgres-1 pg_dump -U gitwire -d gitops_hub > /opt/gitwire/backups/pre-recon.sql

# 5. Update all child tables, then remove the old repository row
#    (run in a single transaction so partial failures roll back)
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub <<SQL
BEGIN;
-- Replace OLD_ID and NEW_ID with the actual values from step 1-2
UPDATE managed_actions SET repo_id = NEW_ID WHERE repo_id = OLD_ID;
-- ... repeat for every table found in step 3 ...
DELETE FROM repositories WHERE github_id = OLD_ID;
UPDATE repositories SET last_synced_at = NOW() WHERE github_id = NEW_ID;
COMMIT;
SQL

# 6. Verify exactly one row remains with the new github_id
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -c "
  SELECT id, github_id, full_name FROM repositories WHERE full_name = '<owner>/<repo>';"
```

### Acceptance

- Exactly one repository row for the repo
- Its `github_id` equals the new GitHub repository id
- No orphaned `repo_id` references to the old GitHub id in any child table
- Production `/health` reports `db_migration_status: current`
- Webhook deliveries resume normally
