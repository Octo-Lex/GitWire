#!/usr/bin/env bash
# scripts/deploy-release.sh
#
# Immutable production deployment control plane for GitWire.
#
# Consumes digest-pinned release images published by the CI publish-release-
# images job. Pulls the three release services (gitwire-app,
# gitwire-executor-service, dashboard) by digest and recreates them with
# --no-build --no-deps in staged order (executor → app → dashboard), gating
# each stage before advancing.
#
# This script is WORKFLOW-OPERATED ONLY. It is invoked by the deploy.yml
# workflow_run job, which passes explicit workflow trust metadata via
# environment variables. There is no implicit manual fallback: missing
# workflow variables are a hard failure, not a signal to run manually. A
# future --manual mode (with its own manifest verification) is deferred.
#
# Usage (by deploy.yml):
#   bash scripts/deploy-release.sh <release_sha> <manifest.json> <production.env>
#
# Sourceable: pure validation functions can be exercised in CI without
# invoking Docker. See the BASH_SOURCE guard at the bottom.
#
# Exit codes:
#   0 — all gates passed, release references persisted, current advanced
#   1 — any gate failed (preflight, health, identity, non-interference)

set -euo pipefail

# ────────────────────────────────────────────────────────────────────────────
# Globals — ALL fields referenced by write_summary / the EXIT trap are
# initialized here so an early failure under `set -u` cannot terminate the
# trap itself on an unbound variable.
# ────────────────────────────────────────────────────────────────────────────
# Repository root. On the production host (CT 115) the deploy.yml workflow
# sets REPO_ROOT=/opt/gitwire. When unset (e.g. sourced for CI tests, or run
# from a checkout elsewhere), resolve from this script's location so the
# bundled helpers (validate-release-manifest.js, read-strict-env.mjs) are found
# relative to the repo, not hardcoded to /opt/gitwire.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROD_ENV=""
MANIFEST_PATH=""
RELEASE_SHA="${RELEASE_SHA:-unknown}"
WORKFLOW_RUN_ID="${WORKFLOW_RUN_ID:-unknown}"

# Staged release env (written from the manifest, used DURING deployment).
# releases/current/images.env is for operator commands AFTER success.
STAGED_RELEASE_ENV=""

# Atomic current-symlink temp link (for EXIT-trap cleanup on failure).
CURRENT_TMP_LINK=""

# Per-release image references (extracted from the manifest).
GITWIRE_APP_IMAGE=""
GITWIRE_EXECUTOR_IMAGE=""
GITWIRE_DASHBOARD_IMAGE=""

# Stable production values (read via read_prod_env, never sourced).
GITWIRE_BOT_IMAGE=""
GITWIRE_LANDING_IMAGE=""
GITWIRE_DOCS_IMAGE=""
GITWIRE_DEMO_IMAGE=""
GITWIRE_VALIDATOR_IMAGE_REF=""
GITWIRE_VALIDATOR_IMAGE_DIGEST=""

# Gate states for the summary.
FINAL_STATUS="failed"
FAILURE_STAGE="initialization"
APP_GATE="not-run"
EXECUTOR_GATE="not-run"
DASHBOARD_GATE="not-run"
IMAGE_GATE="not-run"
NON_INTERFERENCE_GATE="not-run"

# Non-release service baseline (captured before, compared after).
# Lines: "<state>" or "<container-id> <image-id>"
NON_RELEASE_BASELINE=""

# ── Deployment transaction state ──────────────────────────────────────────
# MUTATION_STARTED is set true immediately before the first container
# recreation (executor). Failures before that point are pre-mutation and do
# NOT trigger rollback (nothing was changed). Failures after it trigger
# coherent restoration of the previously-validated release.
MUTATION_STARTED=false
ROLLBACK_REQUIRED=false
ROLLBACK_ATTEMPTED=false
ROLLBACK_STATUS="not-required"
ROLLBACK_FAILURE_STAGE=""

# Previous release (the rollback target). Resolved + validated BEFORE mutation.
PREVIOUS_RELEASE_DIR=""
PREVIOUS_RELEASE_ENV=""
PREVIOUS_RELEASE_ID=""
PREVIOUS_RELEASE_KIND=""   # "immutable" or "bootstrap"
PREVIOUS_APP_IMAGE=""
PREVIOUS_EXECUTOR_IMAGE=""
PREVIOUS_DASHBOARD_IMAGE=""

# Database migration list captured before deploy; compared after to warn about
# schema changes on rollback (service-image rollback only, never reverse SQL).
MIGRATION_LIST_BEFORE=""

# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────

log() { printf '[deploy] %s\n' "$*" >&2; }
fail() {
  FAILURE_STAGE="${FAILURE_STAGE:-unknown}"
  printf '[deploy][FAIL] %s (stage: %s)\n' "$*" "$FAILURE_STAGE" >&2
  exit 1
}

# Non-evaluating single-value lookup from production.env via the strict
# dotenv reader. Never sources the file; never passes secrets as CLI args.
read_prod_env() {
  node "$REPO_ROOT/scripts/read-strict-env.mjs" --get "$1" "$PROD_ENV"
}

# Deployment-time Compose wrapper. Uses the STAGED release env (from the
# manifest), NOT releases/current — which may not exist yet (first deploy)
# or may point to the previous release.
compose_release() {
  docker compose \
    --project-directory "$REPO_ROOT" \
    -f "$COMPOSE_FILE" \
    -p gitwire \
    --env-file "$PROD_ENV" \
    --env-file "$STAGED_RELEASE_ENV" \
    "$@"
}

# Post-deploy operator Compose wrapper. Uses releases/current. Documented in
# the runbook for operator commands (ps, logs, manual inspection). NOT used
# during deployment.
compose_current() {
  docker compose \
    --project-directory "$REPO_ROOT" \
    -f "$COMPOSE_FILE" \
    -p gitwire \
    --env-file "$REPO_ROOT/config/production.env" \
    --env-file "$REPO_ROOT/releases/current/images.env" \
    "$@"
}

# HTTP GET with retries. $1 = url (with port), $2 = attempts.
wait_for_http() {
  local url="$1"
  local attempts="${2:-30}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    local body
    body="$(docker exec gitwire-gitwire-app-1 wget -qO- "$url" 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 2
  done
  return 1
}

# ────────────────────────────────────────────────────────────────────────────
# Pure validation functions (no Docker mutation — exercised in PR CI)
# ────────────────────────────────────────────────────────────────────────────

# Validate the workflow_run trust context passed explicitly by deploy.yml.
# Under set -u, dereference with :? so a missing variable is a deliberate
# error message rather than an unbound-variable termination.
validate_workflow_context() {
  : "${WORKFLOW_CONCLUSION:?WORKFLOW_CONCLUSION required}"
  : "${WORKFLOW_EVENT:?WORKFLOW_EVENT required}"
  : "${WORKFLOW_HEAD_BRANCH:?WORKFLOW_HEAD_BRANCH required}"
  : "${WORKFLOW_HEAD_REPOSITORY:?WORKFLOW_HEAD_REPOSITORY required}"
  : "${EXPECTED_REPOSITORY:?EXPECTED_REPOSITORY required}"
  : "${WORKFLOW_RUN_ID:?WORKFLOW_RUN_ID required}"

  [[ "$WORKFLOW_CONCLUSION" == "success" ]] ||
    fail "workflow conclusion=$WORKFLOW_CONCLUSION, expected success"
  [[ "$WORKFLOW_EVENT" == "push" ]] ||
    fail "workflow event=$WORKFLOW_EVENT, expected push"
  [[ "$WORKFLOW_HEAD_BRANCH" == "master" ]] ||
    fail "workflow head branch=$WORKFLOW_HEAD_BRANCH, expected master"
  [[ "$WORKFLOW_HEAD_REPOSITORY" == "$EXPECTED_REPOSITORY" ]] ||
    fail "cross-repository workflow run rejected: $WORKFLOW_HEAD_REPOSITORY != $EXPECTED_REPOSITORY"
}

# Validate the manifest via the existing validator and extract digests.
# Sets GITWIRE_APP_IMAGE / EXECUTOR / DASHBOARD as full digest-qualified refs.
validate_manifest() {
  FAILURE_STAGE="validate_manifest"
  [[ -f "$MANIFEST_PATH" ]] || fail "manifest not found: $MANIFEST_PATH"

  node "$REPO_ROOT/scripts/validate-release-manifest.js" \
    "$MANIFEST_PATH" "$RELEASE_SHA" "$WORKFLOW_RUN_ID" \
    || fail "manifest validation failed"

  # Extract digest-qualified references via Node (not grep/jq-on-host).
  local refs
  refs="$(node --input-type=module -e '
    import fs from "node:fs";
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const k of ["app", "executor", "dashboard"]) {
      if (!m.images?.[k]?.reference) { console.error(`missing images.${k}.reference`); process.exit(1); }
    }
    console.log(m.images.app.reference);
    console.log(m.images.executor.reference);
    console.log(m.images.dashboard.reference);
  ' "$MANIFEST_PATH")" || fail "could not extract image references from manifest"

  GITWIRE_APP_IMAGE="$(printf '%s\n' "$refs" | sed -n '1p')"
  GITWIRE_EXECUTOR_IMAGE="$(printf '%s\n' "$refs" | sed -n '2p')"
  GITWIRE_DASHBOARD_IMAGE="$(printf '%s\n' "$refs" | sed -n '3p')"

  [[ -n "$GITWIRE_APP_IMAGE" ]] || fail "app reference empty"
  [[ -n "$GITWIRE_EXECUTOR_IMAGE" ]] || fail "executor reference empty"
  [[ -n "$GITWIRE_DASHBOARD_IMAGE" ]] || fail "dashboard reference empty"

  log "manifest validated: sha=${RELEASE_SHA:0:12} run=$WORKFLOW_RUN_ID"
}

# Strict-parse production.env syntax + read the stable values we need.
strict_parse_production_env() {
  FAILURE_STAGE="strict_parse_production_env"
  [[ -f "$PROD_ENV" ]] || fail "production.env not found: $PROD_ENV"

  # Syntax-validate the whole file first (rejects malformed/duplicate lines).
  node "$REPO_ROOT/scripts/read-strict-env.mjs" "$PROD_ENV" \
    DB_PASSWORD \
    GITWIRE_EXECUTOR_SERVICE_TOKEN \
    GITWIRE_BOT_IMAGE \
    GITWIRE_LANDING_IMAGE \
    GITWIRE_DOCS_IMAGE \
    GITWIRE_DEMO_IMAGE \
    GITWIRE_VALIDATOR_IMAGE_REF \
    GITWIRE_VALIDATOR_IMAGE_DIGEST \
    || fail "production.env validation failed"

  # Read individual values (non-evaluating).
  GITWIRE_BOT_IMAGE="$(read_prod_env GITWIRE_BOT_IMAGE)"
  GITWIRE_LANDING_IMAGE="$(read_prod_env GITWIRE_LANDING_IMAGE)"
  GITWIRE_DOCS_IMAGE="$(read_prod_env GITWIRE_DOCS_IMAGE)"
  GITWIRE_DEMO_IMAGE="$(read_prod_env GITWIRE_DEMO_IMAGE)"
  GITWIRE_VALIDATOR_IMAGE_REF="$(read_prod_env GITWIRE_VALIDATOR_IMAGE_REF)"
  GITWIRE_VALIDATOR_IMAGE_DIGEST="$(read_prod_env GITWIRE_VALIDATOR_IMAGE_DIGEST)"
}

# Write the staged release env from the manifest-extracted refs.
write_staged_release_env() {
  FAILURE_STAGE="write_staged_release_env"
  STAGED_RELEASE_ENV="$(mktemp "${RUNNER_TEMP:-/tmp}/gitwire-release.XXXXXX.env")"
  chmod 600 "$STAGED_RELEASE_ENV"
  {
    printf 'GITWIRE_APP_IMAGE=%s\n' "$GITWIRE_APP_IMAGE"
    printf 'GITWIRE_EXECUTOR_IMAGE=%s\n' "$GITWIRE_EXECUTOR_IMAGE"
    printf 'GITWIRE_DASHBOARD_IMAGE=%s\n' "$GITWIRE_DASHBOARD_IMAGE"
  } >"$STAGED_RELEASE_ENV"
  log "staged release env written: $STAGED_RELEASE_ENV"
}

# Validate the full Compose configuration resolves (production.env + staged).
# --quiet so resolved secrets are not emitted to logs.
compose_config_check() {
  FAILURE_STAGE="compose_config_check"
  compose_release config --quiet \
    || fail "compose config failed to resolve (check production.env + staged release env)"
}

# Validator identity format check (pure — no Docker mutation).
validate_validator_ref_format() {
  FAILURE_STAGE="validate_validator_ref_format"
  [[ -n "$GITWIRE_VALIDATOR_IMAGE_REF" ]] || fail "validator ref empty"
  [[ -n "$GITWIRE_VALIDATOR_IMAGE_DIGEST" ]] || fail "validator digest empty"

  # Digest must be exactly sha256: followed by 64 lowercase hex chars.
  # Using grep -E (not a hand-expanded case pattern) to avoid miscounting.
  printf '%s' "$GITWIRE_VALIDATOR_IMAGE_DIGEST" \
    | grep -qE '^sha256:[0-9a-f]{64}$' \
    || fail "validator digest format invalid (expected sha256:<64 hex>): $GITWIRE_VALIDATOR_IMAGE_DIGEST"

  # The ref must be digest-qualified and end with the configured digest.
  case "$GITWIRE_VALIDATOR_IMAGE_REF" in
    *@"$GITWIRE_VALIDATOR_IMAGE_DIGEST") ;;
    *) fail "validator ref does not end with the configured digest: $GITWIRE_VALIDATOR_IMAGE_REF" ;;
  esac
}

# Preflight: transition marker + secondary image refs resolve + production.env
# mode 0600 + project name gitwire.
require_secondary_preflight() {
  FAILURE_STAGE="require_secondary_preflight"
  local marker="$REPO_ROOT/releases/.immutable-transition-ready"
  [[ -f "$marker" ]] ||
    fail "transition marker missing ($marker). Run scripts/prepare-immutable-compose-transition.sh once first."

  # production.env must be mode 0600.
  local mode
  mode="$(stat -c '%a' "$PROD_ENV" 2>/dev/null || stat -f '%A' "$PROD_ENV")"
  [[ "$mode" == "600" ]] ||
    fail "production.env mode is $mode, expected 600 (secrets file)"

  # Secondary image references must resolve to existing local images.
  local ref
  for ref in "$GITWIRE_BOT_IMAGE" "$GITWIRE_LANDING_IMAGE" "$GITWIRE_DOCS_IMAGE" "$GITWIRE_DEMO_IMAGE"; do
    [[ -n "$ref" ]] || fail "a secondary image reference is empty in production.env"
    docker image inspect "$ref" >/dev/null 2>&1 \
      || fail "secondary image '$ref' does not resolve locally. Run the transition script."
  done

  # Current Compose project must be gitwire (matches existing container names).
  local project
  project="$(docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" -p gitwire ps --format json 2>/dev/null | head -1 || true)"
  # If no containers running yet (first deploy), skip the live-project check;
  # otherwise verify the running project name is gitwire.
  if [[ -n "$project" ]]; then
    echo "$project" | grep -q '"Project":"gitwire"' \
      || echo "$project" | grep -q '"project":"gitwire"' \
      || fail "running Compose project is not 'gitwire' — refusing to deploy"
  fi

  log "secondary preflight passed (marker + 4 refs + mode 600 + project gitwire)"
}

# ────────────────────────────────────────────────────────────────────────────
# Mutating functions
# ────────────────────────────────────────────────────────────────────────────

verify_infra_health() {
  FAILURE_STAGE="verify_infra_health"
  docker exec gitwire-postgres-1 pg_isready -U gitwire -d gitops_hub >/dev/null 2>&1 \
    || fail "PostgreSQL not ready (required because deploy uses --no-deps)"
  docker exec gitwire-redis-1 redis-cli ping >/dev/null 2>&1 \
    || fail "Redis not ready (required because deploy uses --no-deps)"
  log "infra healthy (postgres + redis)"
}

pull_validator_image() {
  FAILURE_STAGE="pull_validator_image"
  docker pull "$GITWIRE_VALIDATOR_IMAGE_REF" \
    || fail "could not pull validator image $GITWIRE_VALIDATOR_IMAGE_REF (independently published dependency)"
  log "validator image pulled"
}

# Capture the state of all NON-release services (bot, landing, docs, demo,
# postgres, redis, tunnel). Each line is either "absent" or "<cid> <image-id>".
capture_non_release_state() {
  FAILURE_STAGE="capture_non_release_state"
  local svc cid img
  NON_RELEASE_BASELINE=""
  for svc in bot landing docs demo postgres redis tunnel; do
    cid="$(docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" -p gitwire ps -q "$svc" 2>/dev/null || true)"
    if [[ -z "$cid" ]]; then
      NON_RELEASE_BASELINE+="${svc}:absent"$'\n'
    else
      img="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo unknown)"
      NON_RELEASE_BASELINE+="${svc}:${cid}:${img}"$'\n'
    fi
  done
  log "captured non-release baseline (7 services)"
}

pull_release_images() {
  FAILURE_STAGE="pull_release_images"
  compose_release pull gitwire-app gitwire-executor-service dashboard \
    || fail "pull of release images failed"
  log "pulled 3 release images by digest"
}

deploy_executor() {
  FAILURE_STAGE="deploy_executor"
  compose_release up -d --no-build --no-deps --force-recreate gitwire-executor-service \
    || fail "executor recreate failed"
}

verify_executor() {
  FAILURE_STAGE="verify_executor"
  local body
  body=""
  local i
  for ((i = 1; i <= 30; i++)); do
    body="$(docker exec gitwire-gitwire-executor-service-1 wget -qO- http://localhost:3003/health 2>/dev/null || true)"
    [[ -n "$body" ]] && break
    sleep 2
  done
  [[ -n "$body" ]] || fail "executor /health did not respond"

  # Verify fields via Node.
  printf '%s' "$body" >/tmp/executor-health.json
  EXPECTED_SHA="$RELEASE_SHA" \
  EXPECTED_REF="$GITWIRE_VALIDATOR_IMAGE_REF" \
  EXPECTED_DIGEST="$GITWIRE_VALIDATOR_IMAGE_DIGEST" \
  node --input-type=module -e '
    import fs from "node:fs";
    const h = JSON.parse(fs.readFileSync("/tmp/executor-health.json", "utf8"));
    const checks = [
      ["status", h.status, "ok"],
      ["ready", String(h.ready), "true"],
      ["git_sha", h.git_sha, process.env.EXPECTED_SHA],
      ["container_runtime non-empty", h.container_runtime ? "set" : "empty", "set"],
      ["validator_image_ref", h.validator_image_ref, process.env.EXPECTED_REF],
      ["validator_image_digest", h.validator_image_digest, process.env.EXPECTED_DIGEST],
    ];
    for (const [name, got, want] of checks) {
      if (got !== want) { console.error(`executor gate: ${name}=${got}, expected ${want}`); process.exit(1); }
    }
    console.log("✓ executor gate passed");
  ' || fail "executor gate failed"
  EXECUTOR_GATE="passed"
}

deploy_app() {
  FAILURE_STAGE="deploy_app"
  compose_release up -d --no-build --no-deps --force-recreate gitwire-app \
    || fail "app recreate failed"
}

verify_app() {
  FAILURE_STAGE="verify_app"
  local body
  body="$(wait_for_http http://localhost:3000/health 45 || true)"
  [[ -n "$body" ]] || fail "app /health did not respond"

  printf '%s' "$body" >/tmp/app-health.json
  EXPECTED_SHA="$RELEASE_SHA" \
  node --input-type=module -e '
    import fs from "node:fs";
    const h = JSON.parse(fs.readFileSync("/tmp/app-health.json", "utf8"));
    const checks = [
      ["status", h.status, "ok"],
      ["db_migration_status", h.db_migration_status, "current"],
      ["git_sha", h.git_sha, process.env.EXPECTED_SHA],
    ];
    for (const [name, got, want] of checks) {
      if (got !== want) { console.error(`app gate: ${name}=${got}, expected ${want}`); process.exit(1); }
    }
    console.log("✓ app gate passed");
  ' || fail "app gate failed"
  APP_GATE="passed"
}

deploy_dashboard() {
  FAILURE_STAGE="deploy_dashboard"
  compose_release up -d --no-build --no-deps --force-recreate dashboard \
    || fail "dashboard recreate failed"
}

verify_dashboard() {
  FAILURE_STAGE="verify_dashboard"
  local i ok
  ok=false
  for ((i = 1; i <= 30; i++)); do
    if docker exec gitwire-dashboard-1 wget -qO- "http://0.0.0.0:3001/dashboard" >/dev/null 2>&1; then
      ok=true; break
    fi
    sleep 2
  done
  [[ "$ok" == "true" ]] || fail "dashboard /dashboard did not respond"
  DASHBOARD_GATE="passed"
}

# Verify the running containers' image IDs match the pulled images, and that
# the pulled images carry the manifest's registry digests in RepoDigests.
#
# Registry digest (in the manifest, e.g. sha256:abc...) is NOT the same as the
# local image/config ID (what `docker inspect CONTAINER --format '{{.Image}}'`
# returns). We resolve the expected local ID from the digest-qualified
# reference via `docker image inspect --format '{{.Id}}'`, then compare that to
# the running container's image ID. We separately confirm RepoDigests carries
# the manifest's registry digest.
verify_image_identity() {
  FAILURE_STAGE="verify_image_identity"
  local expected_id cid running_id repo_digests

  verify_one_image() {
    local service="$1" ref="$2"
    expected_id="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    [[ -n "$expected_id" ]] || fail "could not inspect pulled image $ref"
    cid="$(docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" -p gitwire ps -q "$service" 2>/dev/null || true)"
    [[ -n "$cid" ]] || fail "no running container for $service"
    running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
    [[ "$running_id" == "$expected_id" ]] \
      || fail "$service running image ($running_id) != pulled ($expected_id)"
    # RepoDigests must carry a digest matching the manifest reference. The
    # registry digest is the part after '@' in the digest-qualified ref.
    repo_digests="$(docker image inspect --format '{{json .RepoDigests}}' "$ref" 2>/dev/null || echo '[]')"
    printf '%s' "$repo_digests" | grep -q "${ref##*@}" \
      || fail "$service RepoDigests ($repo_digests) do not carry the manifest digest (${ref##*@})"
    log "  $service image identity verified"
  }

  verify_one_image gitwire-app "$GITWIRE_APP_IMAGE"
  verify_one_image gitwire-executor-service "$GITWIRE_EXECUTOR_IMAGE"
  verify_one_image dashboard "$GITWIRE_DASHBOARD_IMAGE"
  IMAGE_GATE="passed"
}

# Assert all 7 non-release services are unchanged from the baseline.
verify_non_interference() {
  FAILURE_STAGE="verify_non_interference"
  local svc cid img now line
  now=""
  for svc in bot landing docs demo postgres redis tunnel; do
    cid="$(docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" -p gitwire ps -q "$svc" 2>/dev/null || true)"
    if [[ -z "$cid" ]]; then
      now+="${svc}:absent"$'\n'
    else
      img="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo unknown)"
      now+="${svc}:${cid}:${img}"$'\n'
    fi
  done
  if [[ "$now" != "$NON_RELEASE_BASELINE" ]]; then
    printf 'non-interference violation:\n--- expected ---\n%s\n--- actual ---\n%s\n' \
      "$NON_RELEASE_BASELINE" "$now" >&2
    fail "a non-release service changed state during deployment"
  fi
  NON_INTERFERENCE_GATE="passed"
}

# ────────────────────────────────────────────────────────────────────────────
# Release records (release.json) — atomic persistence
# ────────────────────────────────────────────────────────────────────────────

# Write a release.json record for the incoming release.
write_release_json() {
  local dir="$1" kind="$2" rel_id="$3"
  local sha="null" run_id="null"
  if [[ "$kind" == "immutable" ]]; then
    sha="\"$RELEASE_SHA\""
    run_id="\"$WORKFLOW_RUN_ID\""
  fi
  cat >"$dir/release.json" <<EOF
{
  "schema_version": 1,
  "kind": "$kind",
  "release_id": "$rel_id",
  "git_sha": $sha,
  "workflow_run_id": $run_id,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "images": {
    "app": "$GITWIRE_APP_IMAGE",
    "executor": "$GITWIRE_EXECUTOR_IMAGE",
    "dashboard": "$GITWIRE_DASHBOARD_IMAGE"
  }
}
EOF
}

# Atomically persist the incoming release: write to a temp dir, validate, then
# rename to releases/<sha>. Finally advance current via temp-symlink + mv -Tf.
# The whole release record (images.env + release.json) is transactional, not
# just the symlink.
persist_release_refs() {
  FAILURE_STAGE="persist_release_refs"
  local staging_dir release_dir current_link tmp_link
  staging_dir="$REPO_ROOT/releases/.release-${RELEASE_SHA}.$$"
  release_dir="$REPO_ROOT/releases/$RELEASE_SHA"

  rm -rf "$staging_dir"
  mkdir -p "$staging_dir"
  umask 022

  # images.env
  {
    printf 'GITWIRE_APP_IMAGE=%s\n' "$GITWIRE_APP_IMAGE"
    printf 'GITWIRE_EXECUTOR_IMAGE=%s\n' "$GITWIRE_EXECUTOR_IMAGE"
    printf 'GITWIRE_DASHBOARD_IMAGE=%s\n' "$GITWIRE_DASHBOARD_IMAGE"
  } >"$staging_dir/images.env"

  # release.json
  write_release_json "$staging_dir" immutable "$RELEASE_SHA"

  # Validate the staged record before committing.
  validate_release_dir "$staging_dir" immutable "$RELEASE_SHA" \
    || { rm -rf "$staging_dir"; fail "staged release record failed validation"; }

  # Atomic rename: temp dir → final dir.
  rm -rf "$release_dir"
  mv "$staging_dir" "$release_dir"

  # Atomic symlink replacement: temp link + mv -Tf.
  current_link="$REPO_ROOT/releases/current"
  tmp_link="$REPO_ROOT/releases/.current.${RELEASE_SHA}.$$"
  CURRENT_TMP_LINK="$tmp_link"
  ln -s "$release_dir" "$tmp_link"
  mv -Tf "$tmp_link" "$current_link"
  CURRENT_TMP_LINK=""  # success — clear so EXIT trap won't remove the live link
  log "release record persisted; current -> $RELEASE_SHA"
}

# ────────────────────────────────────────────────────────────────────────────
# Previous-release validation (rollback target)
# ────────────────────────────────────────────────────────────────────────────

# Validate a release directory has a coherent three-service record.
# $1 = dir, $2 = expected kind (immutable|bootstrap, empty=any), $3 = expected id (empty=any)
validate_release_dir() {
  local dir="$1" exp_kind="${2:-}" exp_id="${3:-}"
  [[ -d "$dir" ]] || { log "validate_release_dir: not a directory: $dir"; return 1; }
  [[ -f "$dir/images.env" ]] || { log "validate_release_dir: missing images.env in $dir"; return 1; }
  [[ -f "$dir/release.json" ]] || { log "validate_release_dir: missing release.json in $dir"; return 1; }

  local img_env="$dir/images.env"
  local app exec dash
  app="$(grep -E '^GITWIRE_APP_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"
  exec="$(grep -E '^GITWIRE_EXECUTOR_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"
  dash="$(grep -E '^GITWIRE_DASHBOARD_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"
  [[ -n "$app" && -n "$exec" && -n "$dash" ]] || { log "validate_release_dir: incomplete image set in $dir"; return 1; }

  # Validate release.json via Node.
  local rj="$dir/release.json"
  node --input-type=module -e '
    import fs from "node:fs";
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (r.schema_version !== 1) throw new Error("schema_version");
    if (!["immutable","bootstrap"].includes(r.kind)) throw new Error("kind");
    if (!r.release_id) throw new Error("release_id");
    if (r.kind === "immutable" && !r.git_sha) throw new Error("git_sha required for immutable");
    for (const k of ["app","executor","dashboard"]) if (!r.images?.[k]) throw new Error("images."+k);
    const expKind = process.argv[2] || "";
    const expId = process.argv[3] || "";
    if (expKind && r.kind !== expKind) throw new Error("kind mismatch: "+r.kind+" != "+expKind);
    if (expId && r.release_id !== expId) throw new Error("id mismatch: "+r.release_id+" != "+expId);
  ' "$rj" "${exp_kind}" "${exp_id}" || { log "validate_release_dir: release.json invalid in $dir"; return 1; }

  return 0
}

# Resolve and validate releases/current as the rollback target. Must run BEFORE
# any container mutation. Sets PREVIOUS_* globals. Fails closed if there is no
# coherent rollback target (the first immutable deploy relies on bootstrap).
validate_previous_release() {
  FAILURE_STAGE="validate_previous_release"
  local current_link="$REPO_ROOT/releases/current"

  # Missing current → no rollback target. This is fatal: every immutable
  # deploy must have a bootstrap or prior immutable target.
  [[ -L "$current_link" ]] || fail "no releases/current symlink — run the bootstrap transition first"

  # Resolve the target, guarding against path traversal / out-of-tree symlinks.
  local target
  target="$(readlink -f "$current_link" 2>/dev/null || true)"
  [[ -n "$target" ]] || fail "releases/current is a dangling symlink"
  [[ "$target" == "$REPO_ROOT/releases/"* ]] || fail "releases/current points outside /opt/gitwire/releases: $target"

  PREVIOUS_RELEASE_DIR="$target"

  # Validate the record.
  validate_release_dir "$target" "" "" \
    || fail "rollback target at $target is incomplete or malformed"

  # Read the previous release metadata.
  local rj="$target/release.json"
  PREVIOUS_RELEASE_KIND="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$rj','utf8')).kind)")"
  PREVIOUS_RELEASE_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$rj','utf8')).kind === 'bootstrap' ? JSON.parse(require('fs').readFileSync('$rj','utf8')).release_id : JSON.parse(require('fs').readFileSync('$rj','utf8')).git_sha)")"

  # Read the previous image references.
  local img_env="$target/images.env"
  PREVIOUS_APP_IMAGE="$(grep -E '^GITWIRE_APP_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"
  PREVIOUS_EXECUTOR_IMAGE="$(grep -E '^GITWIRE_EXECUTOR_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"
  PREVIOUS_DASHBOARD_IMAGE="$(grep -E '^GITWIRE_DASHBOARD_IMAGE=' "$img_env" | head -1 | cut -d= -f2-)"

  # Reject: rollback target equals the incoming release (no-op / re-deploy of same).
  if [[ "$PREVIOUS_RELEASE_ID" == "$RELEASE_SHA" ]]; then
    fail "rollback target is the same as the incoming release ($RELEASE_SHA)"
  fi

  # Write a release env for the previous release (used by rollback).
  PREVIOUS_RELEASE_ENV="$(mktemp "${RUNNER_TEMP:-/tmp}/gitwire-prev.XXXXXX.env")"
  chmod 600 "$PREVIOUS_RELEASE_ENV"
  {
    printf 'GITWIRE_APP_IMAGE=%s\n' "$PREVIOUS_APP_IMAGE"
    printf 'GITWIRE_EXECUTOR_IMAGE=%s\n' "$PREVIOUS_EXECUTOR_IMAGE"
    printf 'GITWIRE_DASHBOARD_IMAGE=%s\n' "$PREVIOUS_DASHBOARD_IMAGE"
  } >"$PREVIOUS_RELEASE_ENV"

  # Pull/verify previous images BEFORE mutation. For immutable releases these
  # are digest-qualified GHCR refs; for bootstrap they are local tags.
  local ref
  for ref in "$PREVIOUS_APP_IMAGE" "$PREVIOUS_EXECUTOR_IMAGE" "$PREVIOUS_DASHBOARD_IMAGE"; do
    if [[ "$PREVIOUS_RELEASE_KIND" == "immutable" ]]; then
      docker pull "$ref" >/dev/null 2>&1 \
        || fail "could not pull previous release image $ref (rollback prerequisite)"
    else
      docker image inspect "$ref" >/dev/null 2>&1 \
        || fail "bootstrap rollback image $ref does not resolve locally"
    fi
  done

  log "rollback target validated: $PREVIOUS_RELEASE_KIND/$PREVIOUS_RELEASE_ID ($target)"
}

# ────────────────────────────────────────────────────────────────────────────
# Migration list capture (schema-change detection on rollback)
# ────────────────────────────────────────────────────────────────────────────
capture_migration_list() {
  MIGRATION_LIST_BEFORE="$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A \
    -c "SELECT version FROM schema_migrations ORDER BY version;" 2>/dev/null || true)"
}

migration_list_changed() {
  local after
  after="$(docker exec gitwire-postgres-1 psql -U gitwire -d gitops_hub -t -A \
    -c "SELECT version FROM schema_migrations ORDER BY version;" 2>/dev/null || true)"
  [[ "$after" != "$MIGRATION_LIST_BEFORE" ]]
}

# ────────────────────────────────────────────────────────────────────────────
# Rollback — coherent restoration of the previously-validated release.
# NON-RECURSIVE: must NOT call fail() or trigger a second rollback. Runs under
# set +e so it always reaches its own conclusion.
# ────────────────────────────────────────────────────────────────────────────
compose_rollback() {
  docker compose \
    --project-directory "$REPO_ROOT" \
    -f "$COMPOSE_FILE" \
    -p gitwire \
    --env-file "$PROD_ENV" \
    --env-file "$PREVIOUS_RELEASE_ENV" \
    "$@"
}

rollback_verify_executor() {
  local body
  body="$(docker exec gitwire-gitwire-executor-service-1 wget -qO- http://localhost:3003/health 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  printf '%s' "$body" >/tmp/rollback-exec-health.json
  EXPECTED_REF="$GITWIRE_VALIDATOR_IMAGE_REF" EXPECTED_DIGEST="$GITWIRE_VALIDATOR_IMAGE_DIGEST" \
  node --input-type=module -e '
    import fs from "node:fs";
    const h = JSON.parse(fs.readFileSync("/tmp/rollback-exec-health.json", "utf8"));
    if (h.status !== "ok") process.exit(1);
    if (h.ready !== true) process.exit(1);
    if (h.container_runtime && h.container_runtime.length === 0) process.exit(1);
    // Validator identity must match stable production config.
    if (process.env.EXPECTED_REF && h.validator_image_ref !== process.env.EXPECTED_REF) process.exit(1);
    if (process.env.EXPECTED_DIGEST && h.validator_image_digest !== process.env.EXPECTED_DIGEST) process.exit(1);
  ' || return 1
  return 0
}

rollback_verify_app() {
  local body
  body="$(docker exec gitwire-gitwire-app-1 wget -qO- http://localhost:3000/health 2>/dev/null || true)"
  [[ -n "$body" ]] || return 1
  printf '%s' "$body" >/tmp/rollback-app-health.json
  node --input-type=module -e '
    import fs from "node:fs";
    const h = JSON.parse(fs.readFileSync("/tmp/rollback-app-health.json", "utf8"));
    if (h.status !== "ok") process.exit(1);
    if (h.db_migration_status !== "current") process.exit(1);
  ' || return 1
  return 0
}

# Restore all three release services to the previous release. Returns 0 on
# success, 1 on any failure. Does NOT call fail() — caller records the result.
rollback_release() {
  local stage="rollback:start"
  ROLLBACK_FAILURE_STAGE=""

  # Restore in the same controlled order: executor → app → dashboard.
  stage="rollback:executor-recreate"
  compose_rollback up -d --no-build --no-deps --force-recreate gitwire-executor-service >/dev/null 2>&1 || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  stage="rollback:executor-verify"
  local i
  for ((i = 1; i <= 30; i++)); do rollback_verify_executor && break; sleep 2; done
  rollback_verify_executor || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  stage="rollback:app-recreate"
  compose_rollback up -d --no-build --no-deps --force-recreate gitwire-app >/dev/null 2>&1 || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  stage="rollback:app-verify"
  for ((i = 1; i <= 45; i++)); do rollback_verify_app && break; sleep 2; done
  rollback_verify_app || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  stage="rollback:dashboard-recreate"
  compose_rollback up -d --no-build --no-deps --force-recreate dashboard >/dev/null 2>&1 || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  stage="rollback:dashboard-verify"
  for ((i = 1; i <= 30; i++)); do
    docker exec gitwire-dashboard-1 wget -qO- "http://0.0.0.0:3001/dashboard" >/dev/null 2>&1 && break
    sleep 2
  done
  docker exec gitwire-dashboard-1 wget -qO- "http://0.0.0.0:3001/dashboard" >/dev/null 2>&1 || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }

  # Verify rollback image identities.
  stage="rollback:image-identity"
  local svc ref exp cid
  for svc in gitwire-app:"$PREVIOUS_APP_IMAGE" gitwire-executor-service:"$PREVIOUS_EXECUTOR_IMAGE" dashboard:"$PREVIOUS_DASHBOARD_IMAGE"; do
    local service="${svc%%:*}"
    ref="${svc#*:}"
    exp="$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    cid="$(docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" -p gitwire ps -q "$service" 2>/dev/null || true)"
    [[ -n "$exp" && -n "$cid" ]] || { ROLLBACK_FAILURE_STAGE="$stage"; return 1; }
    local running
    running="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
    [[ "$running" == "$exp" ]] || { ROLLBACK_FAILURE_STAGE="$stage:$service"; return 1; }
  done

  log "rollback completed: restored $PREVIOUS_RELEASE_KIND/$PREVIOUS_RELEASE_ID"
  return 0
}

# ────────────────────────────────────────────────────────────────────────────
# Summary (portable: stderr if GITHUB_STEP_SUMMARY is unset)
# ────────────────────────────────────────────────────────────────────────────
render_summary() {
  cat <<EOF
## GitWire Immutable Deploy Summary

| Field | Value |
|---|---|
| Status | \`${FINAL_STATUS}\` |
| Release SHA | \`${RELEASE_SHA:0:12}\` |
| Workflow run ID | \`${WORKFLOW_RUN_ID}\` |
| Failure stage | \`${FAILURE_STAGE}\` |
| App image | \`${GITWIRE_APP_IMAGE:-unknown}\` |
| Executor image | \`${GITWIRE_EXECUTOR_IMAGE:-unknown}\` |
| Dashboard image | \`${GITWIRE_DASHBOARD_IMAGE:-unknown}\` |
| Executor gate | \`${EXECUTOR_GATE}\` |
| App gate | \`${APP_GATE}\` |
| Dashboard gate | \`${DASHBOARD_GATE}\` |
| Image identity gate | \`${IMAGE_GATE}\` |
| Non-interference gate | \`${NON_INTERFERENCE_GATE}\` |
| Rollback required | \`${ROLLBACK_REQUIRED}\` |
| Rollback attempted | \`${ROLLBACK_ATTEMPTED}\` |
| Rollback status | \`${ROLLBACK_STATUS}\` |
| Rollback target | \`${PREVIOUS_RELEASE_ID:-none}\` |
| Rollback failure stage | \`${ROLLBACK_FAILURE_STAGE:-none}\` |
| Current symlink | \`$(readlink "$REPO_ROOT/releases/current" 2>/dev/null || echo 'none')\` |

### Non-release services (must be unchanged)
\`\`\`
${NON_RELEASE_BASELINE:-no baseline captured}
\`\`\`
EOF
}

write_summary() {
  local rc="${1:-$?}"
  local destination="${GITHUB_STEP_SUMMARY:-}"
  if [[ -n "$destination" ]]; then
    render_summary >>"$destination"
  else
    render_summary >&2
  fi
}

# ────────────────────────────────────────────────────────────────────────────
# EXIT trap — installed after all globals are initialized. Preserves the
# original exit status. On a post-mutation failure (MUTATION_STARTED && rc!=0),
# attempts coherent rollback using set +e so rollback always reaches its own
# conclusion without recursing.
# ────────────────────────────────────────────────────────────────────────────
on_exit() {
  local rc=$?
  trap - EXIT

  # Attempt rollback only if containers were mutated AND the deploy failed.
  if [[ "$MUTATION_STARTED" == "true" && "$rc" -ne 0 && -n "$PREVIOUS_RELEASE_ENV" ]]; then
    ROLLBACK_REQUIRED=true
    ROLLBACK_ATTEMPTED=true
    log "post-mutation failure (stage: $FAILURE_STAGE) — attempting coherent rollback to $PREVIOUS_RELEASE_ID"
    set +e
    rollback_release
    rollback_rc=$?
    set -e
    if [[ "$rollback_rc" -eq 0 ]]; then
      ROLLBACK_STATUS="succeeded"
      log "rollback succeeded — service restored to $PREVIOUS_RELEASE_ID (deployment still FAILED)"
    else
      ROLLBACK_STATUS="failed"
      log "rollback FAILED (stage: $ROLLBACK_FAILURE_STAGE) — manual intervention required"
    fi
  fi

  # Warn if the migration list changed during the failed deploy (service-image
  # rollback does NOT reverse migrations).
  if [[ "$rc" -ne 0 && -n "$MIGRATION_LIST_BEFORE" ]] && migration_list_changed; then
    log "WARNING: database migrations changed during the failed deployment."
    log "         Automated rollback restored images but did NOT reverse migrations."
    log "         Production migrations must remain backward-compatible with the"
    log "         previous release. Destructive schema recovery requires a separately"
    log "         tested database restore procedure."
  fi

  # Cleanup temp files.
  [[ -n "$STAGED_RELEASE_ENV" ]] && rm -f "$STAGED_RELEASE_ENV" || true
  [[ -n "$PREVIOUS_RELEASE_ENV" ]] && rm -f "$PREVIOUS_RELEASE_ENV" || true
  [[ -n "$CURRENT_TMP_LINK" ]] && rm -f "$CURRENT_TMP_LINK" || true

  write_summary "$rc" || true
  exit "$rc"
}

# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────
main() {
  RELEASE_SHA="${1:-}"
  MANIFEST_PATH="${2:-}"
  PROD_ENV="${3:-}"

  [[ -n "$RELEASE_SHA" ]] || { FAILURE_STAGE="args"; fail "usage: deploy-release.sh <sha> <manifest> <production.env>"; }
  [[ -n "$MANIFEST_PATH" ]] || { FAILURE_STAGE="args"; fail "manifest path required"; }
  [[ -n "$PROD_ENV" ]] || { FAILURE_STAGE="args"; fail "production.env path required"; }

  trap on_exit EXIT

  validate_workflow_context
  validate_manifest
  strict_parse_production_env
  write_staged_release_env
  compose_config_check
  verify_infra_health
  validate_validator_ref_format
  pull_validator_image
  require_secondary_preflight
  # ── Pre-mutation: validate the rollback target BEFORE changing anything ──
  validate_previous_release
  capture_non_release_state
  capture_migration_list
  pull_release_images
  # ── Mutation boundary: everything below this point triggers rollback on failure
  MUTATION_STARTED=true
  deploy_executor
  verify_executor
  deploy_app
  verify_app
  deploy_dashboard
  verify_dashboard
  verify_image_identity
  verify_non_interference
  persist_release_refs

  FINAL_STATUS="success"
  FAILURE_STAGE="complete"
  log "immutable deployment of $RELEASE_SHA succeeded"
}

# Sourceable guard: only run main when executed directly.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
