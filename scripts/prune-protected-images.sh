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
#   KEEP  the N most recent images per CLEANUP-ELIGIBLE repository
#   KEEP  every image under a repository outside the cleanup-eligible set
#   REMOVE the remainder of cleanup-eligible repositories only
#
# v5 safety contract (R3/R4/R5):
#   R3 — Docker inspection FAILS CLOSED: a failed `docker ps`/`docker
#        inspect` aborts before any removal decision. A successful query
#        returning zero containers is valid; a failed query is not
#        indistinguishable from an empty one.
#   R4 — Protected references and cleanup eligibility are SEPARATE sets.
#        Pinned dependencies (validator, plugin-sandbox) are protected
#        where pinned but are NOT cleanup-eligible: the eligible set is
#        exactly the three release repositories named by the current
#        release record (app / executor-service / dashboard). Adding a
#        repository to cleanup eligibility is an explicit ownership
#        decision, not an inference from a pin.
#   R5 — The current release record is MANDATORY: it must exist, parse,
#        and name the three release services, or cleanup stops.
#   Lock directory contract — the prune lock lives in <repo>/releases, the
#        directory the deploy account owns. That directory must be owned by
#        the effective user and not writable by group or others, and the
#        lock must open; otherwise cleanup stops before any inspection.
#
# Sources for protected refs:
#   1. <production.env> — comment-stripped; any registry's @sha256 refs
#   2. $REPO_ROOT/releases/current/images.env — the deployed release
#   3. the N newest other releases/*/images.env — rollback chain
# Usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]
set -euo pipefail

PROD_ENV="${1:?usage: prune-protected-images.sh <production.env> [keep_per_repo] [reserve_gb]}"
KEEP_PER_REPO="${2:-3}"
# A non-positive window silently disables rollback-record protection
# (head -n 0 selects nothing) — validate instead.
case "$KEEP_PER_REPO" in
  ''|*[!0-9]*|0) echo "::error:: keep_per_repo must be a positive integer (got: ${KEEP_PER_REPO})" >&2; exit 1 ;;
esac
RESERVE_GB="${3:-10}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[image-retention] $*"; }
die() { echo "::error:: $*" >&2; exit 1; }

# ── Lock directory contract. ──────────────────────────────────────────────
# One prune at a time — overlapping runs race on rmi and make outcomes
# unexplainable.
#
# The lock lives in <repo>/releases: the directory the deploy account owns
# and writes release records into. It used to sit beside the production
# config, which is root-owned. The deploy account could not open it there,
# so this step failed on every deployment (2026-11-22) and no retention ran.
#
# Both conditions are checked on every run:
#   - the directory is owned by the effective user
#   - it is not writable by group or others
# The open below truncates whatever the path points at. In a directory
# other accounts can write, they could aim the lock at any file this
# account can write, or hold it to stop retention. And a run by another
# account would leave behind a lock file that account owns — one the
# deploy account then cannot open.
LOCK_DIR="$REPO_ROOT/releases"
[ -d "$LOCK_DIR" ] || die "lock directory missing: $LOCK_DIR — refusing to prune"
LOCK_DIR_STAT="$(stat -c '%u %a' "$LOCK_DIR" 2>/dev/null)" || die "lock directory not inspectable: $LOCK_DIR — refusing to prune"
read -r LOCK_DIR_OWNER LOCK_DIR_MODE <<< "$LOCK_DIR_STAT"
case "$LOCK_DIR_MODE" in
  ''|*[!0-7]*) die "lock directory mode unreadable (got: ${LOCK_DIR_MODE:-empty}) — refusing to prune" ;;
esac
[ "$LOCK_DIR_OWNER" = "$(id -u)" ] || die "lock directory $LOCK_DIR is owned by uid ${LOCK_DIR_OWNER:-?}, not by the account running this script (uid $(id -u)) — refusing to prune"
if (( (8#$LOCK_DIR_MODE & 8#022) != 0 )); then
  die "lock directory $LOCK_DIR is writable by group or others (mode $LOCK_DIR_MODE) — refusing to prune"
fi
LOCK_PATH="$LOCK_DIR/.gitwire-image-prune.lock"
# A failed open refuses through die() on purpose: a bare failed redirection
# exits on set -e with the shell's own message only, which nothing surfaces.
if ! exec 9>"$LOCK_PATH"; then
  die "cannot open image-prune lock $LOCK_PATH — refusing to prune"
fi
flock -n 9 || die "another prune is already running"

# Any registry's digest-qualified reference (comment-stripped so a
# commented-out config line can never contribute a pin).
REF_RE='[a-zA-Z0-9._-]+(\.[a-zA-Z0-9._-]+)+/[a-zA-Z0-9._/-]+@sha256:[0-9a-f]{64}'

# ── R5: the authoritative current release record is mandatory. ──────────
CURRENT_RECORD="$REPO_ROOT/releases/current/images.env"
[ -f "$CURRENT_RECORD" ] || die "current release record missing: $CURRENT_RECORD — refusing to prune (incomplete filesystem state after an incident is realistic; the authoritative record must be present)"
for key in GITWIRE_APP_IMAGE GITWIRE_EXECUTOR_IMAGE GITWIRE_DASHBOARD_IMAGE; do
  grep -Eq "^${key}=" "$CURRENT_RECORD" || die "current release record incomplete: missing ${key} — refusing to prune"
done

ENV_REFS="$(sed 's/#.*$//' "$PROD_ENV" | grep -oE "$REF_RE" | sort -u || true)"
CURRENT_REFS="$(sed 's/#.*$//' "$CURRENT_RECORD" | grep -oE "$REF_RE" | sort -u || true)"
[ -n "$CURRENT_REFS" ] || die "current release record parsed but yielded no digest-qualified refs — refusing to prune"

# ── R4: cleanup-eligible repositories = EXACTLY the three release repos. ─
# Derived from the three authoritative keys — pins (validator, sandbox)
# never make their repositories cleanup-eligible.
CLEANUP_ELIGIBLE_REPOS="$(
  grep -E '^(GITWIRE_APP_IMAGE|GITWIRE_EXECUTOR_IMAGE|GITWIRE_DASHBOARD_IMAGE)=' "$CURRENT_RECORD" \
    | sed 's/#.*$//' | grep -oE "$REF_RE" | sed 's/@sha256:.*//' | sort -u
)"
ELIGIBLE_COUNT="$(printf '%s' "$CLEANUP_ELIGIBLE_REPOS" | grep -c . || true)"
[ "$ELIGIBLE_COUNT" -eq 3 ] || die "expected exactly 3 cleanup-eligible release repositories, found ${ELIGIBLE_COUNT} — refusing to prune"

# Release records: current + the N newest other records (rollback chain).
RELEASE_REFS="$CURRENT_REFS"
if compgen -G "$REPO_ROOT/releases/*/images.env" >/dev/null; then
  # Exclude BOTH the current symlink entry AND its resolved target
  # directory: in production releases/current is a symlink to
  # releases/<sha>, and that target appears as its own listing entry with
  # the same records — without this it consumed a rollback slot.
  # Exclude by BASENAME as well as full path: if REPO_ROOT itself contains
  # symlinks, ls paths and the readlink -f output are spelled differently
  # and a full-path -vF match would silently miss the target.
  CURRENT_TARGET_BASE="$(basename "$(readlink -f "$REPO_ROOT/releases/current" 2>/dev/null || true)" 2>/dev/null || true)"
  ROLLBACK_RECORDS="$(ls -1dt "$REPO_ROOT"/releases/*/ 2>/dev/null | grep -vE '/current/?$' | grep -vE "/${CURRENT_TARGET_BASE:-__none__}/?$" | head -n "${KEEP_PER_REPO}" || true)"
  while IFS= read -r rec; do
    [ -f "${rec}images.env" ] || continue
    RELEASE_REFS="$(printf '%s\n%s\n' "$RELEASE_REFS" "$(sed 's/#.*$//' "${rec}images.env" | grep -oE "$REF_RE" || true)")"
  done < <(printf '%s\n' "$ROLLBACK_RECORDS")
fi
RELEASE_REFS="$(printf '%s' "$RELEASE_REFS" | sort -u | grep . || true)"

# Mandatory set: production pins + the current release record.
MANDATORY_REFS="$(printf '%s\n%s\n' "$ENV_REFS" "$CURRENT_REFS" | sort -u | grep . || true)"
# Combined protection set. printf with an empty optional input never
# fails, and the || true guard keeps an all-empty result from aborting
# under set -e (a record-only configuration has no ENV_REFS).
PROTECTED_REFS="$(printf '%s
%s
' "$RELEASE_REFS" "$ENV_REFS" | sort -u | grep . || true)"

MANDATORY_COUNT="$(printf '%s' "$MANDATORY_REFS" | grep -c . || true)"
[ "$MANDATORY_COUNT" -ge 1 ] || die "no digest-qualified mandatory refs parsed — refusing to prune (an empty pin list must never degrade into an unrestricted prune)"
log "protected refs: $(printf '%s' "$PROTECTED_REFS" | grep -c . || true) (mandatory: $MANDATORY_COUNT); cleanup-eligible repos: $ELIGIBLE_COUNT"

# ── R3: running-container inspection FAILS CLOSED. ───────────────────────
# A failed query is NOT an empty query: without the running set, a managed
# image in active use could be selected for forced removal.
if ! PS_IDS="$(docker ps -q 2>/dev/null)"; then
  die "docker ps failed — running containers cannot be verified; refusing to prune"
fi
RUNNING_IDS=""
if [ -n "$PS_IDS" ]; then
  if ! INSPECT_OUT="$(printf '%s\n' "$PS_IDS" | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null)"; then
    die "docker inspect failed — running container images cannot be resolved; refusing to prune"
  fi
  RUNNING_IDS="$(printf '%s' "$INSPECT_OUT" | sed 's/^sha256://' | cut -c1-12)"
fi
if ! PS_NAMES="$(docker ps --format '{{.Image}}' 2>/dev/null)"; then
  die "docker ps --format failed — running container references cannot be read; refusing to prune"
fi
RUNNING_NAMES="$(printf '%s' "$PS_NAMES" | sort -u)"
RUNNING_JSON="$(printf '%s\n%s\n' "$RUNNING_IDS" "$RUNNING_NAMES" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(d.split("\n").map(x=>x.trim()).filter(Boolean))))')"

# ── Inventory: docker images with repo digests. ──────────────────────────
INVENTORY_JSON="$(docker images --digests --format '{{json .}}')"

# ── Policy selection (pure module, unit-tested). ─────────────────────────
WORK_DIR="$(mktemp -d)"; trap 'rm -rf "$WORK_DIR"' EXIT
printf '%s\n' "$PROTECTED_REFS" > "$WORK_DIR/protected.txt"
printf '%s\n' "$MANDATORY_REFS" > "$WORK_DIR/mandatory.txt"
printf '%s\n' "$CLEANUP_ELIGIBLE_REPOS" > "$WORK_DIR/managed.txt"
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
  die "mandatory protected refs not present locally (pin drift?): $MISSING"
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
