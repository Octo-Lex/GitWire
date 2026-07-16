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

# Write the transition marker.
mkdir -p "$(dirname "$MARKER")"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$MARKER"

log "transition complete. Marker written: $MARKER"
log ""
log "Next: ensure production.env references these four tags:"
log "  GITWIRE_BOT_IMAGE=${TAGS[bot]}"
log "  GITWIRE_LANDING_IMAGE=${TAGS[landing]}"
log "  GITWIRE_DOCS_IMAGE=${TAGS[docs]}"
log "  GITWIRE_DEMO_IMAGE=${TAGS[demo]}"
log ""
log "Then the automated workflow_run deployment can proceed."
