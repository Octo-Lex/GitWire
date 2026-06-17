# Backup & Restore

GitWire includes built-in backup and restore scripts for disaster recovery.

## Automated Backups

A daily cron job runs at **03:00 UTC** on the production server:

```bash
# /etc/cron.d/gitwire-backup
0 3 * * * root /opt/gitwire/scripts/backup.sh >> /var/log/gitwire-backup.log 2>&1
```

## What's Backed Up

| Component | Method | Size (typical) |
|-----------|--------|---------------|
| PostgreSQL | `pg_dump` (custom format, compressed) | ~200KB |
| Redis | `BGSAVE` + RDB copy | ~50KB |
| Environment | `.env` + `docker-compose.yml` | ~2KB |
| Manifest | `manifest.json` with metadata | ~1KB |

**Total**: ~4.8MB (compressed)

Backups are stored at `/opt/gitwire/backups/` and auto-pruned to keep the **last 10**.

## Backup Script

```bash
# Located at scripts/backup.sh
# Usage:
./scripts/backup.sh
```

Output structure:

```
backups/20260523_030000/
├── gitwire_db.dump          # pg_dump custom format
├── gitwire_redis.rdb        # Redis RDB snapshot
├── .env                     # Environment variables
├── docker-compose.yml       # Docker configuration
└── manifest.json            # Backup metadata
```

### manifest.json

```json
{
  "timestamp": "2026-05-23T03:00:00Z",
  "version": "0.8.0",
  "tables": 39,
  "repos": 19,
  "db_size": 199000,
  "backup_size": "4.8M"
}
```

## Restore Script

```bash
# Located at scripts/restore.sh
# Usage:
./scripts/restore.sh /opt/gitwire/backups/20260523_030000
```

The restore script:

1. **Prompts for confirmation** — shows what will be restored
2. **Drops and recreates** the `gitops_hub` database
3. **Restores** from the pg_dump file
4. **Copies** the Redis RDB snapshot
5. **Restarts** all GitWire services
6. **Verifies** health endpoint

::: danger Data Loss
Restore drops the existing database. Make a fresh backup before restoring if you want to preserve current data.
:::

## Manual Backup

```bash
# On the production server
ssh root@your-server
cd /opt/gitwire
./scripts/backup.sh
```

## Offsite Backup

Copy the latest backup to your local machine:

```bash
# From your local machine
scp -r root@your-server:/opt/gitwire/backups/$(ssh root@your-server 'ls -t /opt/gitwire/backups/ | head -1') ./backups/
```

## Database Migrations

Migrations run separately via the migration script:

```bash
# Apply pending migrations
node scripts/migrate.js
```

Migrations are **not** included in backups — they're version-controlled in `packages/web/db/migrations/`. After restoring, run migrations if the backup is from an older version.

→ [Docker Compose](/installation/docker-compose) | [Environment Variables](/installation/environment-variables)
