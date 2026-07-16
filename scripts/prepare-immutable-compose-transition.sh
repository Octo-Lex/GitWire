#!/usr/bin/env bash
# scripts/prepare-immutable-compose-transition.sh
#
# ONE-TIME operator tool. Run BEFORE the first immutable deployment.
#
# The four secondary application services (bot, landing, docs, demo) are not
# published to GHCR by the release pipeline — only gitwire-app,
# gitwire-executor-service, and dashboard are. Production Compose now requires
# every service to reference an image (no build: blocks). This script captures
# the four secondary services' CURRENTLY RUNNING images and tags them with
# persistent local references, so production.env can name them and the
# deployment preflight can resolve them.
#
# This script is INDEPENDENT of the new Compose interpolation: it discovers
# containers via Docker's com.docker.compose.project/service labels, not by
# parsing docker-compose.yml. (The new ${VAR:?} guards would otherwise make
# this circular before production.env exists.)
#
# Usage:
#   bash scripts/prepare-immutable-compose-transition.sh
#   bash scripts/prepare-immutable-compose-transition.sh --force   # overwrite existing tags
#
# On success, writes the marker:
#   /opt/gitwire/releases/.immutable-transition-ready
# The deployment preflight (deploy-release.sh require_secondary_preflight)
# requires this marker before proceeding.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/opt/gitwire}"
PROJECT="gitwire"
MARKER="$REPO_ROOT/releases/.immutable-transition-ready"
FORCE=false

[[ "${1:-}" == "--force" ]] && FORCE=true

log() { printf '[transition] %s\n' "$*" >&2; }
die() { printf '[transition][ERROR] %s\n' "$*" >&2; exit 1; }

# Map of compose service name -> persistent local tag.
# These MUST match the references the operator places in production.env.
declare -A TAGS=(
  [bot]="gitwire-local/bot:pre-immutable"
  [landing]="gitwire-local/landing:pre-immutable"
  [docs]="gitwire-local/docs:pre-immutable"
  [demo]="gitwire-local/demo:pre-immutable"
)

SERVICES=(bot landing docs demo)

log "discovering running containers via Docker labels (project=$PROJECT)"

for svc in "${SERVICES[@]}"; do
  # Find the running container by Compose labels — does NOT parse compose yaml.
  cid="$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$svc" \
    --format '{{.ID}}' \
    | head -1 || true)"

  [[ -n "$cid" ]] || die "no running container found for service '$svc' (project=$PROJECT). Start the stack under the old compose model first."

  # Resolve the image ID the container is actually running.
  image_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  [[ -n "$image_id" ]] || die "could not resolve image ID for $svc container $cid"

  target="${TAGS[$svc]}"

  # Refuse to clobber an existing tag pointing to a different image unless --force.
  existing="$(docker image inspect --format '{{.Id}}' "$target" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "$image_id" ]]; then
    if [[ "$FORCE" != "true" ]]; then
      die "tag '$target' already exists pointing to a different image ($existing). Re-run with --force to overwrite."
    fi
    log "overwriting existing tag '$target' (--force)"
  fi

  docker tag "$image_id" "$target"
  log "  $svc: container $cid (image $image_id) -> $target"
done

# Verify all four tags resolve.
for svc in "${SERVICES[@]}"; do
  docker image inspect "${TAGS[$svc]}" >/dev/null \
    || die "post-tag verify failed: ${TAGS[$svc]} does not resolve"
done

# ── Snapshot the three release services into a bootstrap release record ────
# This gives the FIRST immutable deployment a coherent rollback target. Without
# it, a failed first deploy would have nothing to roll back to.
log "snapshotting release services into a bootstrap release record"

RELEASE_SERVICES=(gitwire-app gitwire-executor-service dashboard)
declare -A RELEASE_TAGS
BOOTSTRAP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
BOOTSTRAP_DIR="$REPO_ROOT/releases/bootstrap-$BOOTSTRAP_TS"
BOOTSTRAP_STAGING="$REPO_ROOT/releases/.bootstrap-$BOOTSTRAP_TS.$$"

for svc in "${RELEASE_SERVICES[@]}"; do
  cid="$(docker ps \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$svc" \
    --format '{{.ID}}' | head -1 || true)"
  [[ -n "$cid" ]] || die "no running container for release service '$svc'"

  image_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  [[ -n "$image_id" ]] || die "could not resolve image ID for $svc"

  # Tag with an image-ID-derived reference.
  prefix="${image_id#sha256:}"
  prefix="${prefix:0:12}"
  case "$svc" in
    gitwire-app)              tag="gitwire-local/gitwire-app:bootstrap-$prefix" ;;
    gitwire-executor-service) tag="gitwire-local/gitwire-executor-service:bootstrap-$prefix" ;;
    dashboard)                tag="gitwire-local/gitwire-dashboard:bootstrap-$prefix" ;;
  esac
  RELEASE_TAGS[$svc]="$tag"

  docker tag "$image_id" "$tag"
  log "  $svc: container $cid (image $image_id) -> $tag"
done

# Verify all three bootstrap tags resolve and record their image IDs.
declare -A BOOTSTRAP_IMAGE_IDS
for svc in "${RELEASE_SERVICES[@]}"; do
  tag="${RELEASE_TAGS[$svc]}"
  docker image inspect "$tag" >/dev/null \
    || die "bootstrap tag verify failed: $tag does not resolve"
  BOOTSTRAP_IMAGE_IDS[$svc]="$(docker image inspect --format '{{.Id}}' "$tag")"
done

# ── Verify the currently-running services are healthy before committing ───
log "verifying running services are healthy before committing bootstrap"
# App: status=ok, migrations current.
app_health="$(docker exec gitwire-gitwire-app-1 wget -qO- http://localhost:3000/health 2>/dev/null || true)"
[[ -n "$app_health" ]] || die "app /health not responding — cannot bootstrap from an unhealthy stack"
printf '%s' "$app_health" >/tmp/bootstrap-app-health.json
node --input-type=module -e '
  import fs from "node:fs";
  const h = JSON.parse(fs.readFileSync("/tmp/bootstrap-app-health.json", "utf8"));
  if (h.status !== "ok") { console.error("app status="+h.status); process.exit(1); }
  if (h.db_migration_status !== "current") { console.error("migrations="+h.db_migration_status); process.exit(1); }
' || die "app health check failed — fix the running stack before bootstrapping"

# Executor: status=ok.
exec_health="$(docker exec gitwire-gitwire-executor-service-1 wget -qO- http://localhost:3003/health 2>/dev/null || true)"
[[ -n "$exec_health" ]] || die "executor /health not responding"
printf '%s' "$exec_health" >/tmp/bootstrap-exec-health.json
node --input-type=module -e '
  import fs from "node:fs";
  const h = JSON.parse(fs.readFileSync("/tmp/bootstrap-exec-health.json", "utf8"));
  if (h.status !== "ok") { console.error("executor status="+h.status); process.exit(1); }
' || die "executor health check failed"

# Dashboard responds.
docker exec gitwire-dashboard-1 wget -qO- "http://0.0.0.0:3001/dashboard" >/dev/null 2>&1 \
  || die "dashboard /dashboard not responding"

# ── Create the bootstrap release record atomically ────────────────────────
rm -rf "$BOOTSTRAP_STAGING"
mkdir -p "$BOOTSTRAP_STAGING"

cat >"$BOOTSTRAP_STAGING/images.env" <<EOF
GITWIRE_APP_IMAGE=${RELEASE_TAGS[gitwire-app]}
GITWIRE_EXECUTOR_IMAGE=${RELEASE_TAGS[gitwire-executor-service]}
GITWIRE_DASHBOARD_IMAGE=${RELEASE_TAGS[dashboard]}
EOF

cat >"$BOOTSTRAP_STAGING/release.json" <<EOF
{
  "schema_version": 1,
  "kind": "bootstrap",
  "release_id": "bootstrap-$BOOTSTRAP_TS",
  "git_sha": null,
  "workflow_run_id": null,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "images": {
    "app": "${RELEASE_TAGS[gitwire-app]}",
    "executor": "${RELEASE_TAGS[gitwire-executor-service]}",
    "dashboard": "${RELEASE_TAGS[dashboard]}"
  },
  "bootstrap_image_ids": {
    "app": "${BOOTSTRAP_IMAGE_IDS[gitwire-app]}",
    "executor": "${BOOTSTRAP_IMAGE_IDS[gitwire-executor-service]}",
    "dashboard": "${BOOTSTRAP_IMAGE_IDS[dashboard]}"
  }
}
EOF

# Atomic rename staging → final.
rm -rf "$BOOTSTRAP_DIR"
mv "$BOOTSTRAP_STAGING" "$BOOTSTRAP_DIR"

# Point current at the bootstrap release (atomic temp-symlink + mv -Tf).
current_link="$REPO_ROOT/releases/current"
tmp_link="$REPO_ROOT/releases/.current.bootstrap.$$"
ln -s "$BOOTSTRAP_DIR" "$tmp_link"
mv -Tf "$tmp_link" "$current_link"
log "bootstrap release record created; current -> bootstrap-$BOOTSTRAP_TS"

# ── Write the transition marker (only after everything above succeeded) ───
mkdir -p "$(dirname "$MARKER")"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MARKER"

log "transition complete. Marker written: $MARKER"
log ""
log "Bootstrap release: $BOOTSTRAP_DIR"
log "Secondary tags:"
log "  GITWIRE_BOT_IMAGE=${TAGS[bot]}"
log "  GITWIRE_LANDING_IMAGE=${TAGS[landing]}"
log "  GITWIRE_DOCS_IMAGE=${TAGS[docs]}"
log "  GITWIRE_DEMO_IMAGE=${TAGS[demo]}"
log ""
log "The first immutable deployment can now proceed (and has a rollback target)."
