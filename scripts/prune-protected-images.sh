#!/usr/bin/env bash
# scripts/prune-protected-images.sh
# Protected image-retention prune (#425 incident follow-up). Runs on the
# production host. NEVER an unrestricted "docker image prune -a": Docker's
# unused-image notion deleted the locally pinned validator dependency on
# 2026-11-21 and blocked a release deployment. The removal set is computed
# by packages/web/src/lib/imageRetentionPolicy.js:
#   KEEP  digest-pinned deploy dependencies (production config + the
#         authoritative current and rollback release records)
#   KEEP  images referenced by running containers (exact refs)
#   KEEP  the N most recent images per MANAGED repository
#   KEEP  every image under a repository GitWire does not manage
#   REMOVE the remainder of GitWire-managed repositories only
# Sources for protected refs and the managed-repository allowlist:
#   1. <production.env> — comment-stripped; any registry's @sha256 refs
#   2. $REPO_ROOT/releases/current/images.env — the deployed release
#   3. the N newest other releases/*/images.env — rollback chain
# Usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]
set -euo pipefail

PROD_ENV="${1:?usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]}"
KEEP_PER_REPO="${2:-3}"
RESERVE_GB="${3:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[image-retention] $*"; }

# One prune at a time — overlapping runs race on rmi and make outcomes
# unexplainable. Lock lives beside the production config (root-owned), not
# in world-writable /tmp.
LOCK_PATH="$(dirname "$PROD_ENV")/.gitwire-image-prune.lock"
exec 9>"$LOCK_PATH"
flock -n 9 || { echo "::error::another prune is already running" >&2; exit 1; }

# Any registry's digest-qualified reference (comment-stripped so a
# commented-out config line can never contribute a pin).
REF_RE='[a-zA-Z0-9._-]+(\.[a-zA-Z0-9._-]+)+/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}'

ENV_REFS="$(sed 's/#.*$//' "$PROD_ENV" | grep -oE "$REF_RE" | sort -u || true)"

# Release records: current + the N newest other records (rollback chain).
RELEASE_REFS=""
if compgen -G "$REPO_ROOT/releases/*/images.env" >/dev/null; then
  ROLLBACK_RECORDS="$(ls -1dt "$REPO_ROOT"/releases/*/ 2>/dev/null | grep -v '/current' | head -n "$((KEEP_PER_REPO > 3 ? KEEP_PER_REPO : 3))" || true)"
  CURRENT_RECORD="$REPO_ROOT/releases/current/images.env"
  for rec in "$CURRENT_RECORD" $ROLLBACK_RECORDS; do
    [ -f "$rec" ] || continue
    # images.env: KEY=ref lines; strip comments, extract refs.
    RELEASE_REFS="$(printf '%s\n%s\n' "$RELEASE_REFS" "$(sed 's/#.*$//' "$rec" | grep -oE "$REF_RE" || true)")"
  done
fi
RELEASE_REFS="$(printf '%s' "$RELEASE_REFS" | sort -u | grep . || true)"

# Mandatory set: production pins + the CURRENT release record (both must
# resolve locally; drift here means the deployment contract is broken).
CURRENT_REFS=""
[ -f "$REPO_ROOT/releases/current/images.env" ] && \
  CURRENT_REFS="$(sed 's/#.*$//' "$REPO_ROOT/releases/current/images.env" | grep -oE "$REF_RE" | sort -u || true)"
MANDATORY_REFS="$(printf '%s\n%s\n' "$ENV_REFS" "$CURRENT_REFS" | sort -u | grep . || true)"

PROTECTED_REFS="$(printf '%s\n%s\n' "$ENV_REFS" "$RELEASE_REFS" | sort -u | grep . || true)"
MANDATORY_COUNT="$(printf '%s' "$MANDATORY_REFS" | grep -c . || true)"
PROTECTED_COUNT="$(printf '%s' "$PROTECTED_REFS" | grep -c . || true)"

# Fail-visible guard: no mandatory pins = refuse to prune at all.
if [ "$MANDATORY_COUNT" -lt 1 ]; then
  echo "::error::no digest-qualified protected refs parsed from $PROD_ENV or the current release record — refusing to prune (an empty pin list must never degrade into an unrestricted prune)" >&2
  exit 1
fi
log "protected refs: $PROTECTED_COUNT (mandatory: $MANDATORY_COUNT)"

# Managed-repository allowlist: repositories appearing in the protected
# records. Images under any other repository are NEVER eligible.
MANAGED_REPOS="$(printf '%s\n' "$PROTECTED_REFS" | sed 's/@sha256:.*//' | sort -u)"
log "managed repositories: $(printf '%s' "$MANAGED_REPOS" | wc -l)"

# ── Inventory: docker images with repo digests. ──────────────────────────
INVENTORY_JSON="$(docker images --digests --format '{{json .}}')"

# ── Running references: full image ids + exact repo:tag refs. ────────────
RUNNING_IDS="$(docker ps -q | xargs -r docker inspect --format '{{.Image}}' | sed 's/^sha256://' | cut -c1-12 || true)"
RUNNING_NAMES="$(docker ps --format '{{.Image}}' | sort -u || true)"
RUNNING_JSON="$(printf '%s\n%s\n' "$RUNNING_IDS" "$RUNNING_NAMES" | grep -v '^$' || true; true)"
RUNNING_JSON="$(printf '%s\n%s\n' "$RUNNING_IDS" "$RUNNING_NAMES" | grep -v '^$' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(d.split("\n").filter(Boolean))))' || echo '[]')"

# ── Policy selection (pure module, unit-tested). ─────────────────────────
WORK_DIR="$(mktemp -d)"; trap 'rm -rf "$WORK_DIR"' EXIT
printf '%s\n' "$PROTECTED_REFS" > "$WORK_DIR/protected.txt"
printf '%s\n' "$MANDATORY_REFS" > "$WORK_DIR/mandatory.txt"
printf '%s\n' "$MANAGED_REPOS" > "$WORK_DIR/managed.txt"
printf '%s' "$RUNNING_JSON" > "$WORK_DIR/running.json"

DECISION="$(node --input-type=module -e '
const { selectImagesToRemove } = await import((await import("node:url")).pathToFileURL(process.argv[1]).href);
const fs = await import("node:fs");
let raw = ""; process.stdin.on("data", (c) => raw += c);
await new Promise((r) => process.stdin.on("end", r));
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
const images = lines.map((l) => JSON.parse(l)).map((x) => ({
  repository: x.Repository,
  tag: x.Tag && x.Tag !== "<none>" ? x.Tag : null,
  digest: x.Digest && x.Digest !== "<none>" ? x.Digest : null,
  id: x.ID,
  created: x.CreatedAt,
}));
const read = (f) => fs.readFileSync(f, "utf8").split("\n").map(x => x.trim()).filter(Boolean);
const protectedRefs = read(process.argv[2]);
const mandatoryRefs = read(process.argv[3]);
const managedRepositories = read(process.argv[4]);
const runningImages = JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
const d = selectImagesToRemove({ images, protectedRefs, mandatoryRefs, managedRepositories, runningImages, keepPerRepo: Number(process.argv[6]) });
console.log(JSON.stringify(d));
' "$REPO_ROOT/packages/web/src/lib/imageRetentionPolicy.js" \
   "$WORK_DIR/protected.txt" "$WORK_DIR/mandatory.txt" "$WORK_DIR/managed.txt" \
   "$WORK_DIR/running.json" "$KEEP_PER_REPO" <<< "$INVENTORY_JSON")"

REMOVE_IDS="$(printf '%s' "$DECISION" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.remove.map(i=>i.id).join("\n"))})')"
KEEP_INFO="$(printf '%s' "$DECISION" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("kept="+j.keep.length+" protected="+j.keptProtected.length+" mandatory_ok="+j.mandatoryResolved+" rollback="+j.keptRollback+" unmanaged_kept="+j.keptUnmanaged+" remove="+j.remove.length)})')"
log "decision: $KEEP_INFO"

# Every MANDATORY ref that failed to resolve aborts: pin drift means the
# deployment contract is already broken — pruning now is unsafe.
if printf '%s' "$DECISION" | grep -q '"mandatoryResolved":false'; then
  MISSING="$(printf '%s' "$DECISION" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.unresolvedMandatory.join(" "))})')"
  echo "::error::mandatory protected refs not present locally (pin drift?): $MISSING" >&2
  exit 1
fi

# ── Execute removal (dry-run prints the list instead). ──────────────────
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN — would remove:"
  printf '%s\n' "$REMOVE_IDS" | grep -v '^$' | sed 's/^/  /' || true
  exit 0
fi
if [ -n "$(printf '%s\n' "$REMOVE_IDS" | grep -v '^$' || true)" ]; then
  REMOVED_OK=0; REMOVED_FAIL=0
  while read -r id; do
    [ -n "$id" ] || continue
    if docker rmi --force "$id" >/dev/null 2>&1; then REMOVED_OK=$((REMOVED_OK+1)); else REMOVED_FAIL=$((REMOVED_FAIL+1)); fi
  done <<< "$REMOVE_IDS"
  log "removal: ${REMOVED_OK} succeeded, ${REMOVED_FAIL} failed (failures visible — investigate if nonzero)"
else
  log "nothing to remove"
fi

# ── Disk reserve check (warn, do not fail the deploy). ──────────────────
FREE_GB="$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')"
if [ "$FREE_GB" -lt "$RESERVE_GB" ]; then
  echo "::warning::free space ${FREE_GB}G is below the ${RESERVE_GB}G reserve" >&2
fi
log "done; free space: ${FREE_GB}G"
