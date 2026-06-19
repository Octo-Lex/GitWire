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
> automatically on container restart. You must run them manually.

```bash
# Check current migration status
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub \
  -c "SELECT version FROM schema_migrations ORDER BY version;"

# List all migration files available
ls /opt/gitwire/packages/web/db/migrations/*.sql | sort

# Find the gap — migrations in files but NOT in the database
# Run each missing migration in order
for mig in /opt/gitwire/packages/web/db/migrations/0NN_*.sql; do
  basename=$(basename "$mig")
  exists=$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -tAc \
    "SELECT 1 FROM schema_migrations WHERE version='$basename'")
  if [ "$exists" != "1" ]; then
    echo "APPLYING: $basename"
    docker exec -i gitwire-postgres-1 psql -U gitwire -d gitops_hub < "$mig"
    docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -c \
      "INSERT INTO schema_migrations (version) VALUES ('$basename');"
  fi
done
```

**Verify:**
```bash
# Migration count must match file count
echo "Files: $(ls /opt/gitwire/packages/web/db/migrations/*.sql | wc -l)"
docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub \
  -c "SELECT COUNT(*) FROM schema_migrations;"
```

### Step 3: Rebuild and Restart Containers

```bash
cd /opt/gitwire
docker compose up -d --build
```

**Verify all containers are healthy:**
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep gitwire
# All 9 containers must show "(healthy)" — no "restarting" or "unhealthy"
```

### Step 4: Verify Version String

```bash
# Container version must match the git tag
docker exec gitwire-gitwire-app-1 cat /app/package.json | grep '"version"'
# Expected: the version you just released

# If mismatched, the package.json files need bumping — see Version Hygiene below
```

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

```bash
# Set 256 MB limit with LRU eviction
docker exec gitwire-redis-1 redis-cli CONFIG SET maxmemory 256mb
docker exec gitwire-redis-1 redis-cli CONFIG SET maxmemory-policy allkeys-lru

# Verify
docker exec gitwire-redis-1 redis-cli CONFIG GET maxmemory
docker exec gitwire-redis-1 redis-cli CONFIG GET maxmemory-policy

# To persist across restarts, update docker-compose.yml Redis command:
# command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
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
| New tables exist | `\dt` in psql | Includes release-specific tables |
| Container version matches | `docker exec gitwire-gitwire-app-1 cat /app/package.json \| grep version` | Release version |
| All containers healthy | `docker ps` | 9 containers, all `(healthy)` |
| API responds | `curl localhost:3000/health` | `{"status":"ok"}` |
| External URL works | `curl https://gitwire.erlab.uk/health` | `{"status":"ok"}` |
| No errors in logs | `docker logs gitwire-gitwire-app-1 --tail 50` | No exceptions |
