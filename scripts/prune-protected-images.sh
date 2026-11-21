#!/usr/bin/env bash
# scripts/prune-protected-images.sh
# Protected image-retention prune (#425 incident follow-up). Runs on the
# production host. NEVER an unrestricted "docker image prune -a": Docker's
# unused-image notion deleted the locally pinned validator dependency on
# 2026-11-21 and blocked a release deployment. The removal set is computed
# by packages/web/src/lib/imageRetentionPolicy.js:
#   KEEP  digest-pinned deploy dependencies (from the production env)
#   KEEP  images referenced by running containers
#   KEEP  the N most recent images per repository (rollback candidates)
#   REMOVE everything else
# Usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]
set -euo pipefail

PROD_ENV="${1:?usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]}"
KEEP_PER_REPO="${2:-3}"
RESERVE_GB="${3:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[image-retention] $*"; }

# ── Protected refs: every digest-qualified image reference in the env. ──
PROTECTED_REFS="$(grep -oE 'ghcr\.io/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}' "$PROD_ENV" | sort -u || true)"
PROTECTED_COUNT="$(printf '%s' "$PROTECTED_REFS" | grep -c . || true)"

# Fail-visible guard: no protected pins parsed = refuse to prune at all.
if [ "$PROTECTED_COUNT" -lt 1 ]; then
  echo "::error::no digest-qualified protected refs parsed from $PROD_ENV — refusing to prune (an empty pin list must never degrade into an unrestricted prune)" >&2
  exit 1
fi
log "protected refs: $PROTECTED_COUNT"

# ── Inventory: docker images with repo digests. ──────────────────────────
INVENTORY_JSON="$(docker images --digests --format '{{json .}}')"

# ── Running references: full image ids (12-char form) + repo names. ─────
RUNNING_IDS="$(docker ps -q | xargs -r docker inspect --format '{{.Image}}' | sed 's/^sha256://' | cut -c1-12 || true)"
RUNNING_NAMES="$(docker ps --format '{{.Image}}' | sed 's/:.*$//' | sort -u || true)"
RUNNING_JSON="$(printf '%s\n%s\n' "$RUNNING_IDS" "$RUNNING_NAMES" | grep -v '^$' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(d.split("\n").filter(Boolean))))')"

# ── Policy selection (pure module, unit-tested). ─────────────────────────
PROTECT_FILE="$(mktemp)"; RUNNING_FILE="$(mktemp)"; trap 'rm -f "$PROTECT_FILE" "$RUNNING_FILE"' EXIT
printf '%s\n' "$PROTECTED_REFS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(d.split("\n").map(x=>x.trim()).filter(Boolean))))' > "$PROTECT_FILE"
printf '%s' "$RUNNING_JSON" > "$RUNNING_FILE"

DECISION="$(node --input-type=module -e '
const { selectImagesToRemove } = await import((await import("node:url")).pathToFileURL(process.argv[1]).href);
let raw = ""; process.stdin.on("data", (c) => raw += c);
await new Promise((r) => process.stdin.on("end", r));
const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
const images = lines.map((l) => JSON.parse(l)).map((x) => ({
  repository: x.Repository,
  digest: x.Digest && x.Digest !== "<none>" ? x.Digest : null,
  id: x.ID,
  created: x.CreatedAt,
}));
const protectedRefs = JSON.parse((await import("node:fs")).readFileSync(process.argv[2], "utf8"));
const runningImages = JSON.parse((await import("node:fs")).readFileSync(process.argv[3], "utf8"));
const d = selectImagesToRemove({ images, protectedRefs, runningImages, keepPerRepo: Number(process.argv[4]) });
console.log(JSON.stringify(d));
' "$REPO_ROOT/packages/web/src/lib/imageRetentionPolicy.js"    "$PROTECT_FILE" "$RUNNING_FILE" "$KEEP_PER_REPO" <<< "$INVENTORY_JSON")"

REMOVE_IDS="$(printf '%s' "$DECISION" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.remove.map(i=>i.id).join("\n"))})')"
KEEP_PROTECTED="$(printf '%s' "$DECISION" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log("kept="+j.keep.length+" protected="+j.keptProtected.length+" rollback="+j.keptRollback+" remove="+j.remove.length)})')"
log "decision: $KEEP_PROTECTED"

# Every protected ref that failed to resolve must abort: pin drift means
# the deployment contract is already broken — pruning now is unsafe.
UNRESOLVED="$(printf '%s\n' "$PROTECTED_REFS" | while read -r ref; do
  printf '%s' "$DECISION" | grep -q "\"$ref\"" || echo "$ref"
done)"
if [ -n "$UNRESOLVED" ]; then
  echo "::error::protected refs not present locally (pin drift?): $UNRESOLVED" >&2
  exit 1
fi

# ── Execute removal. ─────────────────────────────────────────────────────
if [ "${DRY_RUN:-0}" = "1" ]; then
  log "DRY RUN — would remove:"
  printf '%s
' "$REMOVE_IDS" | sed 's/^/  /'
  exit 0
fi
if [ -n "$REMOVE_IDS" ]; then
  printf '%s\n' "$REMOVE_IDS" | xargs -r docker rmi --force 2>/dev/null | wc -l | xargs -I{} log "removed {} images"
else
  log "nothing to remove"
fi

# ── Disk reserve check (warn, do not fail the deploy). ──────────────────
FREE_GB="$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')"
if [ "$FREE_GB" -lt "$RESERVE_GB" ]; then
  echo "::warning::free space ${FREE_GB}G is below the ${RESERVE_GB}G reserve" >&2
fi
log "done; free space: ${FREE_GB}G"
