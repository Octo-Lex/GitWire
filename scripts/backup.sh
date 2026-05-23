#!/usr/bin/env bash
# GitWire Backup Script
# Usage: ./scripts/backup.sh [destination_dir]
#
# Backs up:
#   1. PostgreSQL database (pg_dump, compressed)
#   2. Redis state (RDB snapshot)
#   3. Environment config (.env files)
#   4. Docker compose files
#
# Restorable with: ./scripts/restore.sh <backup_dir>

set -euo pipefail

DEST="${1:-/opt/gitwire/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${DEST}/${TIMESTAMP}"

echo "╔══════════════════════════════════════════════╗"
echo "║       GitWire Backup — ${TIMESTAMP}     ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Create backup directory
mkdir -p "${BACKUP_DIR}"
echo "✓ Backup dir: ${BACKUP_DIR}"

# ── 1. PostgreSQL ──────────────────────────────────────────────────────────
echo ""
echo "Backing up PostgreSQL..."
docker exec gitwire-postgres-1 pg_dump \
  -U gitwire \
  -d gitops_hub \
  --format=custom \
  --compress=9 \
  > "${BACKUP_DIR}/gitops_hub.dump"

DB_SIZE=$(stat -c%s "${BACKUP_DIR}/gitops_hub.dump" 2>/dev/null || stat -f%z "${BACKUP_DIR}/gitops_hub.dump" 2>/dev/null || echo "?")
echo "✓ PostgreSQL: $(numfmt --to=iec ${DB_SIZE} 2>/dev/null || echo ${DB_SIZE} bytes)"
echo "  Tables: $(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | tr -d ' ')"

# ── 2. Redis ───────────────────────────────────────────────────────────────
echo ""
echo "Backing up Redis..."
# Trigger a BGSAVE first
docker exec gitwire-redis-1 redis-cli BGSAVE
sleep 2

# Copy the RDB file
docker cp gitwire-redis-1:/data/dump.rdb "${BACKUP_DIR}/redis_dump.rdb" 2>/dev/null \
  && echo "✓ Redis: RDB snapshot saved" \
  || echo "⚠ Redis: RDB not available (transient data, safe to skip)"

# Also export BullMQ queue names for reference
docker exec gitwire-redis-1 redis-cli KEYS "bull:*" > "${BACKUP_DIR}/redis_keys.txt" 2>/dev/null || true

# ── 3. Environment config ──────────────────────────────────────────────────
echo ""
echo "Backing up config..."
cp /opt/gitwire/packages/web/.env "${BACKUP_DIR}/web.env"
cp /opt/gitwire/docker-compose.yml "${BACKUP_DIR}/docker-compose.yml"
[ -f /opt/gitwire/docker-compose.prod.yml ] && cp /opt/gitwire/docker-compose.prod.yml "${BACKUP_DIR}/docker-compose.prod.yml"

echo "✓ Config: .env + docker-compose.yml"

# ── 4. PEM key (if mounted as Docker volume) ───────────────────────────────
PEM_PATH=$(docker exec gitwire-gitwire-app-1 printenv GITHUB_PRIVATE_KEY_PATH 2>/dev/null || echo "")
if [ -n "${PEM_PATH}" ] && docker exec gitwire-gitwire-app-1 test -f "${PEM_PATH}" 2>/dev/null; then
  docker cp "gitwire-gitwire-app-1:${PEM_PATH}" "${BACKUP_DIR}/gitwire-hq.pem" 2>/dev/null \
    && echo "✓ PEM key: saved" \
    || echo "⚠ PEM key: could not copy"
else
  # Check if PEM is in the env file (base64 or inline)
  grep -q "GITHUB_PRIVATE_KEY" /opt/gitwire/packages/web/.env 2>/dev/null \
    && echo "✓ PEM key: embedded in .env" \
    || echo "⚠ PEM key: not found — check GITHUB_PRIVATE_KEY_PATH"
fi

# ── 5. Metadata ────────────────────────────────────────────────────────────
cat > "${BACKUP_DIR}/manifest.json" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "date": "$(date -Iseconds)",
  "gitwire_version": "$(cd /opt/gitwire && git log --oneline -1 | cut -d' ' -f1 2>/dev/null || echo unknown)",
  "postgres_size": "${DB_SIZE}",
  "tables": $(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"),
  "repos": $(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A -c "SELECT count(*) FROM repositories" 2>/dev/null || echo "?"),
  "containers": {
    "gitwire-app": "$(docker inspect --format='{{.Image}}' gitwire-gitwire-app-1 2>/dev/null | cut -c1-19 || echo unknown)",
    "dashboard": "$(docker inspect --format='{{.Image}}' gitwire-dashboard-1 2>/dev/null | cut -c1-19 || echo unknown)",
    "postgres": "$(docker inspect --format='{{.Image}}' gitwire-postgres-1 2>/dev/null | cut -c1-19 || echo unknown)"
  }
}
EOF

echo "✓ Manifest: ${BACKUP_DIR}/manifest.json"

# ── Summary ────────────────────────────────────────────────────────────────
TOTAL_SIZE=$(du -sh "${BACKUP_DIR}" | cut -f1)
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Backup complete                             ║"
echo "║  Location: ${BACKUP_DIR}"
echo "║  Size: ${TOTAL_SIZE}"
echo "║                                              ║"
echo "║  Restore with:                               ║"
echo "║  ./scripts/restore.sh ${BACKUP_DIR}"
echo "╚══════════════════════════════════════════════╝"

# ── Cleanup: keep last 10 backups ──────────────────────────────────────────
echo ""
BACKUP_COUNT=$(ls -1d "${DEST}"/*/ 2>/dev/null | wc -l)
if [ "${BACKUP_COUNT}" -gt 10 ]; then
  OLDEST=$(ls -1d "${DEST}"/*/ | head -1)
  echo "Pruning old backup: ${OLDEST}"
  rm -rf "${OLDEST}"
  echo "✓ Kept 10 most recent backups"
fi
