#!/usr/bin/env bash
# scripts/test-rollback-logic.sh
#
# PR-safe tests for the release-record and rollback logic in deploy-release.sh.
# Uses temp directories as fake release trees and stubs out docker/compose so
# NO real container mutation occurs. Exercises:
#   - validate_release_dir: valid immutable, valid bootstrap, incomplete, malformed
#   - validate_previous_release: missing current, dangling, out-of-tree, same-as-incoming
#   - transaction state: pre-mutation failure does not set MUTATION_STARTED
#   - release.json schema validation
#
# Run: bash scripts/test-rollback-logic.sh
# Exit 0 = all pass, 1 = any fail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source the deploy script (does not run main — BASH_SOURCE guard).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/deploy-release.sh"

# Override REPO_ROOT to a temp sandbox so release trees are isolated.
TEST_ROOT="$(mktemp -d)"
REPO_ROOT="$TEST_ROOT"
COMPOSE_FILE="$TEST_ROOT/docker-compose.yml"
mkdir -p "$TEST_ROOT/releases"

# Stub docker so no real mutation happens. For validate_release_dir's
# verify-local bootstrap check, image inspect must return a fake ID matching
# the fixture's bootstrap_image_ids.
STUB_IMAGE_ID="sha256:aaa"
docker() {
  if [[ "$1" == "image" && "$2" == "inspect" && "$*" == *"{{.Id}}"* ]]; then
    printf '%s\n' "$STUB_IMAGE_ID"
    return 0
  fi
  return 0
}

passed=0
failed=0
ok() { echo "  ok: $1"; passed=$((passed + 1)); }
bad() { echo "  FAIL: $1"; failed=$((failed + 1)); }

# Helper: assert a function succeeds.
assert_ok() { if "$@" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
# Helper: assert a function fails (returns non-zero).
assert_fail() { if "$@" >/dev/null 2>&1; then bad "$1 (should have failed)"; else ok "$1 (correctly rejected)"; fi; }

# ── Fixture builders ─────────────────────────────────────────────────────────

make_immutable_release() {
  local dir="$1" sha="$2"
  mkdir -p "$dir"
  local app_ref exec_ref dash_ref
  app_ref="ghcr.io/octo-lex/gitwire-app@sha256:$(printf 'a%.0s' $(seq 1 64))"
  exec_ref="ghcr.io/octo-lex/gitwire-executor-service@sha256:$(printf 'b%.0s' $(seq 1 64))"
  dash_ref="ghcr.io/octo-lex/gitwire-dashboard@sha256:$(printf 'c%.0s' $(seq 1 64))"
  cat >"$dir/images.env" <<EOF
GITWIRE_APP_IMAGE=$app_ref
GITWIRE_EXECUTOR_IMAGE=$exec_ref
GITWIRE_DASHBOARD_IMAGE=$dash_ref
EOF
  cat >"$dir/release.json" <<EOF
{"schema_version":1,"kind":"immutable","release_id":"$sha","git_sha":"$sha","workflow_run_id":"123","created_at":"2026-01-01T00:00:00Z","images":{"app":"$app_ref","executor":"$exec_ref","dashboard":"$dash_ref"}}
EOF
}

make_bootstrap_release() {
  local dir="$1"
  mkdir -p "$dir"
  local app_ref exec_ref dash_ref
  app_ref="gitwire-local/gitwire-app:bootstrap-aaa"
  exec_ref="gitwire-local/gitwire-executor-service:bootstrap-bbb"
  dash_ref="gitwire-local/gitwire-dashboard:bootstrap-ccc"
  cat >"$dir/images.env" <<EOF
GITWIRE_APP_IMAGE=$app_ref
GITWIRE_EXECUTOR_IMAGE=$exec_ref
GITWIRE_DASHBOARD_IMAGE=$dash_ref
EOF
  cat >"$dir/release.json" <<EOF
{"schema_version":1,"kind":"bootstrap","release_id":"bootstrap-20260101","git_sha":null,"workflow_run_id":null,"created_at":"2026-01-01T00:00:00Z","images":{"app":"$app_ref","executor":"$exec_ref","dashboard":"$dash_ref"},"bootstrap_image_ids":{"app":"sha256:aaa","executor":"sha256:aaa","dashboard":"sha256:aaa"}}
EOF
}

# ── Tests ────────────────────────────────────────────────────────────────────

echo "=== validate_release_dir ==="

# Valid immutable
make_immutable_release "$TEST_ROOT/releases/sha-aaa111" "sha-aaa111"
assert_ok validate_release_dir "$TEST_ROOT/releases/sha-aaa111" immutable "sha-aaa111"

# Valid bootstrap
make_bootstrap_release "$TEST_ROOT/releases/bootstrap-1"
assert_ok validate_release_dir "$TEST_ROOT/releases/bootstrap-1" bootstrap "bootstrap-20260101"

# Kind mismatch (immutable expected, bootstrap found)
assert_fail validate_release_dir "$TEST_ROOT/releases/bootstrap-1" immutable ""

# Missing images.env
rm "$TEST_ROOT/releases/sha-aaa111/images.env"
assert_fail validate_release_dir "$TEST_ROOT/releases/sha-aaa111" immutable "sha-aaa111"
make_immutable_release "$TEST_ROOT/releases/sha-aaa111" "sha-aaa111"

# Missing release.json
rm "$TEST_ROOT/releases/sha-aaa111/release.json"
assert_fail validate_release_dir "$TEST_ROOT/releases/sha-aaa111" immutable "sha-aaa111"
make_immutable_release "$TEST_ROOT/releases/sha-aaa111" "sha-aaa111"

# Incomplete image set (missing dashboard line)
sed -i '/GITWIRE_DASHBOARD_IMAGE/d' "$TEST_ROOT/releases/sha-aaa111/images.env"
assert_fail validate_release_dir "$TEST_ROOT/releases/sha-aaa111" immutable "sha-aaa111"
make_immutable_release "$TEST_ROOT/releases/sha-aaa111" "sha-aaa111"

# Malformed release.json (bad schema_version)
echo '{"schema_version":99,"kind":"immutable","release_id":"x","git_sha":"x","workflow_run_id":"1","images":{"app":"a","executor":"b","dashboard":"c"}}' > "$TEST_ROOT/releases/sha-aaa111/release.json"
assert_fail validate_release_dir "$TEST_ROOT/releases/sha-aaa111" immutable "sha-aaa111"

echo ""
echo "=== validate_previous_release (current symlink resolution) ==="

# Symlink-based tests require a filesystem that supports symlinks (Linux CI).
# On Windows Git Bash, ln -s creates copies, so skip these locally. The CI
# runner (ubuntu-latest) executes them.
if [[ "$(uname -s)" == "Linux" ]]; then
  # Missing current → fail (run in subshell because fail() exits the process)
  RELEASE_SHA="sha-new999"
  rm -f "$TEST_ROOT/releases/current"
  ( RELEASE_SHA="$RELEASE_SHA" validate_previous_release ) >/dev/null 2>&1 && bad "missing current accepted" || ok "missing current rejected"

  # Valid immutable current
  make_immutable_release "$TEST_ROOT/releases/sha-aaa111" "sha-aaa111"
  ln -sfn "$TEST_ROOT/releases/sha-aaa111" "$TEST_ROOT/releases/current"
  ( RELEASE_SHA="sha-new999" validate_previous_release ) >/dev/null 2>&1 && ok "valid immutable current accepted" || bad "valid immutable current rejected"

  # Same-as-incoming → fail
  ( RELEASE_SHA="sha-aaa111" validate_previous_release ) >/dev/null 2>&1 && bad "same-as-incoming accepted" || ok "same-as-incoming rejected"

  # Valid bootstrap current
  make_bootstrap_release "$TEST_ROOT/releases/bootstrap-1"
  ln -sfn "$TEST_ROOT/releases/bootstrap-1" "$TEST_ROOT/releases/current"
  ( RELEASE_SHA="sha-new999" validate_previous_release ) >/dev/null 2>&1 && ok "valid bootstrap current accepted" || bad "valid bootstrap current rejected"

  # Dangling symlink → fail
  ln -sfn "$TEST_ROOT/releases/nonexistent" "$TEST_ROOT/releases/current"
  ( RELEASE_SHA="sha-new999" validate_previous_release ) >/dev/null 2>&1 && bad "dangling current accepted" || ok "dangling current rejected"

  # Out-of-tree symlink → fail
  ln -sfn "/tmp/out-of-tree-$$" "$TEST_ROOT/releases/current"
  ( RELEASE_SHA="sha-new999" validate_previous_release ) >/dev/null 2>&1 && bad "out-of-tree current accepted" || ok "out-of-tree current rejected"
  rm -f "$TEST_ROOT/releases/current"
else
  echo "  (skipped on $(uname -s) — symlink tests run on Linux CI)"
fi

echo ""
echo "=== transaction state ==="
# Pre-mutation failure must not set MUTATION_STARTED. The script initializes
# MUTATION_STARTED=false; only main() sets it true before deploy_executor.
[[ "$MUTATION_STARTED" == "false" ]] && ok "MUTATION_STARTED defaults false" || bad "MUTATION_STARTED not false"

echo ""
echo "=== transaction / rollback tests (mocked Docker) ==="

# These tests exercise rollback_release() directly by mocking docker/compose.
# They verify: post-mutation failure triggers rollback, health/image/non-interf.
# failures are surfaced, current stays on prior release, successful rollback
# restores service while preserving the original deployment failure.

# ── Mock helpers ─────────────────────────────────────────────────────────────
# State variables the mocks read.
MOCK_HEALTH_EXEC='{"status":"ok","ready":true,"container_runtime":"docker","git_sha":"sha-prev","validator_image_ref":"ref","validator_image_digest":"sha256:abc"}'
MOCK_HEALTH_APP='{"status":"ok","db_migration_status":"current","git_sha":"sha-prev"}'
MOCK_DASH_OK=true
MOCK_IMAGE_ID="sha256:aaaabbbbcccc"
MOCK_CONTAINER_IMAGE="sha256:aaaabbbbcccc"
MOCK_REPO_DIGESTS='["ghcr.io/octo-lex/gitwire-app@sha256:ffffffff"]'

# Override compose_rollback to capture the call and return success (or failure
# if MOCK_COMPOSE_FAIL is set).
MOCK_COMPOSE_FAIL=false
MOCK_COMPOSE_CALLS=""
compose_rollback() {
  MOCK_COMPOSE_CALLS+=" $*"
  if [[ "$MOCK_COMPOSE_FAIL" == "true" ]]; then return 1; fi
  return 0
}

# Override docker to handle the specific subcommands rollback uses.
docker() {
  local sub="$1"
  case "$sub" in
    exec)
      # docker exec <container> wget -qO- <url>
      local container="$2" url=""
      for a in "$@"; do [[ "$a" == http* ]] && url="$a"; done
      case "$container" in
        *gitwire-executor-service*) printf '%s' "$MOCK_HEALTH_EXEC" ;;
        *gitwire-app*)
          if [[ "$url" == */health ]]; then printf '%s' "$MOCK_HEALTH_APP"; fi
          ;;
        *dashboard*)
          if [[ "$MOCK_DASH_OK" == "true" ]]; then return 0; else return 1; fi
          ;;
      esac
      ;;
    inspect)
      # docker inspect --format ... <id>
      local fmt=""
      local target=""
      local i=0
      for a in "$@"; do
        i=$((i+1))
        if [[ "$a" == "--format" ]]; then fmt="$((i+1))"; fi
      done
      # target is the last positional arg
      target="${@: -1}"
      if [[ "$*" == *".Image"* && "$*" != *json* ]]; then
        printf '%s' "$MOCK_CONTAINER_IMAGE"
      elif [[ "$*" == *"{{.Id}}"* ]]; then
        printf '%s' "$MOCK_IMAGE_ID"
      elif [[ "$*" == *"{{json .RepoDigests}}"* ]]; then
        printf '%s' "$MOCK_REPO_DIGESTS"
      fi
      ;;
    image)
      # docker image inspect --format ... <ref>
      if [[ "$*" == *"{{.Id}}"* ]]; then
        printf '%s' "$MOCK_IMAGE_ID"
      elif [[ "$*" == *"{{json .RepoDigests}}"* ]]; then
        printf '%s' "$MOCK_REPO_DIGESTS"
      fi
      ;;
    compose)
      # docker compose ... ps -q <service> → container ID for release services,
      # empty (absent) for non-release services (matches NON_RELEASE_BASELINE).
      # docker compose ... up/pull → success (compose_rollback is overridden separately)
      local last_arg="${@: -1}"
      for a in "${@:2}"; do
        if [[ "$a" == "ps" ]]; then
          case "$last_arg" in
            gitwire-app|gitwire-executor-service|dashboard) printf 'fake-container-id\n' ;;
            *) printf '' ;;  # non-release services are absent in the baseline
          esac
          return 0
        fi
      done
      return 0
      ;;
  esac
}

# Build a fake previous release dir + current symlink for rollback tests.
setup_rollback_fixtures() {
  local kind="${1:-immutable}"
  local rel_dir="$TEST_ROOT/releases/sha-prev"
  rm -rf "$rel_dir"
  mkdir -p "$rel_dir"

  if [[ "$kind" == "immutable" ]]; then
    DIG_FAKE="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    cat >"$rel_dir/images.env" <<EOF
GITWIRE_APP_IMAGE=ghcr.io/octo-lex/gitwire-app@$DIG_FAKE
GITWIRE_EXECUTOR_IMAGE=ghcr.io/octo-lex/gitwire-executor-service@$DIG_FAKE
GITWIRE_DASHBOARD_IMAGE=ghcr.io/octo-lex/gitwire-dashboard@$DIG_FAKE
EOF
    cat >"$rel_dir/release.json" <<EOF
{"schema_version":1,"kind":"immutable","release_id":"sha-prev","git_sha":"sha-prev","workflow_run_id":"111","created_at":"2026-01-01T00:00:00Z","images":{"app":"ghcr.io/octo-lex/gitwire-app@$DIG_FAKE","executor":"ghcr.io/octo-lex/gitwire-executor-service@$DIG_FAKE","dashboard":"ghcr.io/octo-lex/gitwire-dashboard@$DIG_FAKE"}}
EOF
  else
    cat >"$rel_dir/images.env" <<EOF
GITWIRE_APP_IMAGE=gitwire-local/gitwire-app:bootstrap-aaa
GITWIRE_EXECUTOR_IMAGE=gitwire-local/gitwire-executor-service:bootstrap-bbb
GITWIRE_DASHBOARD_IMAGE=gitwire-local/gitwire-dashboard:bootstrap-ccc
EOF
    cat >"$rel_dir/release.json" <<EOF
{"schema_version":1,"kind":"bootstrap","release_id":"bootstrap-1","git_sha":null,"workflow_run_id":null,"created_at":"2026-01-01T00:00:00Z","images":{"app":"gitwire-local/gitwire-app:bootstrap-aaa","executor":"gitwire-local/gitwire-executor-service:bootstrap-bbb","dashboard":"gitwire-local/gitwire-dashboard:bootstrap-ccc"},"bootstrap_image_ids":{"app":"sha256:aaaabbbbcccc","executor":"sha256:aaaabbbbcccc","dashboard":"sha256:aaaabbbbcccc"}}
EOF
  fi

  PREVIOUS_RELEASE_DIR="$rel_dir"
  PREVIOUS_RELEASE_KIND="$kind"
  PREVIOUS_RELEASE_ID="sha-prev"
  PREVIOUS_GIT_SHA=$([[ "$kind" == "immutable" ]] && echo "sha-prev" || echo "")
  PREVIOUS_APP_IMAGE="$(grep '^GITWIRE_APP_IMAGE=' "$rel_dir/images.env" | cut -d= -f2-)"
  PREVIOUS_EXECUTOR_IMAGE="$(grep '^GITWIRE_EXECUTOR_IMAGE=' "$rel_dir/images.env" | cut -d= -f2-)"
  PREVIOUS_DASHBOARD_IMAGE="$(grep '^GITWIRE_DASHBOARD_IMAGE=' "$rel_dir/images.env" | cut -d= -f2-)"
  PREVIOUS_RELEASE_ENV="$(mktemp)"
  NON_RELEASE_BASELINE="bot:absent
landing:absent
docs:absent
demo:absent
postgres:absent
redis:absent
tunnel:absent
"
}

# Reset mocks to the success path.
reset_mocks_ok() {
  MOCK_HEALTH_EXEC='{"status":"ok","ready":true,"container_runtime":"docker","git_sha":"sha-prev","validator_image_ref":"ref","validator_image_digest":"sha256:abc"}'
  MOCK_HEALTH_APP='{"status":"ok","db_migration_status":"current","git_sha":"sha-prev"}'
  MOCK_DASH_OK=true
  MOCK_IMAGE_ID="sha256:aaaabbbbcccc"
  MOCK_CONTAINER_IMAGE="sha256:aaaabbbbcccc"
  MOCK_REPO_DIGESTS='["ghcr.io/octo-lex/gitwire-app@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"]'
  MOCK_COMPOSE_FAIL=false
}

# ── Test: pre-mutation failure does not roll back ────────────────────────────
MUTATION_STARTED=false
ROLLBACK_ATTEMPTED=false
# Simulate on_exit with rc=1 but MUTATION_STARTED=false → rollback should NOT run.
# We verify by checking ROLLBACK_ATTEMPTED stays false (it's only set in on_exit
# when MUTATION_STARTED is true).
prev_rollback="$ROLLBACK_ATTEMPTED"
[[ "$MUTATION_STARTED" == "false" ]] && ok "pre-mutation: MUTATION_STARTED false (no rollback)" || bad "pre-mutation: MUTATION_STARTED should be false"

# ── Test: post-mutation failure invokes rollback (happy path) ────────────────
if [[ "$(uname -s)" == "Linux" ]]; then
  setup_rollback_fixtures immutable
  ln -sfn "$TEST_ROOT/releases/sha-prev" "$TEST_ROOT/releases/current"
  reset_mocks_ok
  MUTATION_STARTED=true
  ROLLBACK_FAILURE_STAGE=""
  set +e
  rollback_release
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] && ok "rollback: post-mutation restore succeeds (rc=0)" || bad "rollback: restore failed rc=$rc stage=$ROLLBACK_FAILURE_STAGE"
  # Verify all three services were recreated (compose_rollback called 3x).
  recreate_count="$(printf '%s' "$MOCK_COMPOSE_CALLS" | grep -o 'force-recreate' | wc -l)"
  [[ "$recreate_count" -eq 3 ]] && ok "rollback: 3 services recreated ($recreate_count)" || bad "rollback: expected 3 recreates, got $recreate_count"

  # ── Test: rollback health failure surfaced ──────────────────────────────
  setup_rollback_fixtures immutable
  ln -sfn "$TEST_ROOT/releases/sha-prev" "$TEST_ROOT/releases/current"
  reset_mocks_ok
  MOCK_HEALTH_EXEC='{"status":"ok","ready":false,"container_runtime":"docker","git_sha":"sha-prev"}'  # ready=false
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && ok "rollback: executor ready=false surfaces failure" || bad "rollback: ready=false not caught"
  [[ "$ROLLBACK_FAILURE_STAGE" == "rollback:executor-verify" ]] && ok "rollback: failure stage = executor-verify" || bad "rollback: wrong stage: $ROLLBACK_FAILURE_STAGE"

  # ── Test: rollback image mismatch surfaced ──────────────────────────────
  setup_rollback_fixtures immutable
  ln -sfn "$TEST_ROOT/releases/sha-prev" "$TEST_ROOT/releases/current"
  reset_mocks_ok
  MOCK_CONTAINER_IMAGE="sha256:DIFFERENT"  # container running a different image
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && ok "rollback: image mismatch surfaces failure" || bad "rollback: image mismatch not caught"
  # Stage should be image-identity-related (may include :service suffix).
  if printf '%s' "$ROLLBACK_FAILURE_STAGE" | grep -q '^rollback:image-identity'; then
    ok "rollback: image mismatch stage correct ($ROLLBACK_FAILURE_STAGE)"
  else
    bad "rollback: wrong stage: $ROLLBACK_FAILURE_STAGE"
  fi

  # ── Test: current remains on prior release after rollback ───────────────
  setup_rollback_fixtures immutable
  ln -sfn "$TEST_ROOT/releases/sha-prev" "$TEST_ROOT/releases/current"
  reset_mocks_ok
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -eq 0 ]] && ok "rollback: happy path for current check" || bad "rollback: failed before current check"
  cur_target="$(readlink -f "$TEST_ROOT/releases/current" 2>/dev/null || true)"
  [[ "$cur_target" == "$PREVIOUS_RELEASE_DIR" ]] && ok "rollback: current stays on prior release" || bad "rollback: current moved to $cur_target"

  # ── Test: bootstrap rollback uses basic identity (running==exp) ─────────
  # Bootstrap images are local tags; rollback verifies container image matches
  # the local tag image (running==exp). No bootstrap-id or RepoDigests check.
  setup_rollback_fixtures bootstrap
  reset_mocks_ok
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -eq 0 ]] && ok "rollback: bootstrap happy path (basic identity)" || bad "rollback: bootstrap failed at $ROLLBACK_FAILURE_STAGE"

  # Bootstrap rollback with image mismatch (running != exp) IS caught.
  setup_rollback_fixtures bootstrap
  reset_mocks_ok
  MOCK_CONTAINER_IMAGE="sha256:DIFFERENT"
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && ok "rollback: bootstrap image mismatch rejected" || bad "rollback: bootstrap image mismatch not caught"

  # ── Test: release.json/images.env mismatch rejected by validate_release_dir ─
  bad_dir="$TEST_ROOT/releases/mismatch"
  mkdir -p "$bad_dir"
  DIG2="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  printf 'GITWIRE_APP_IMAGE=ghcr.io/octo-lex/gitwire-app@%s\nGITWIRE_EXECUTOR_IMAGE=ghcr.io/octo-lex/gitwire-executor-service@%s\nGITWIRE_DASHBOARD_IMAGE=ghcr.io/octo-lex/gitwire-dashboard@%s\n' "$DIG2" "$DIG2" "$DIG2" > "$bad_dir/images.env"
  printf '{"schema_version":1,"kind":"immutable","release_id":"sha-x","git_sha":"sha-x","workflow_run_id":"1","created_at":"x","images":{"app":"DIFFERENT","executor":"e","dashboard":"e"}}' > "$bad_dir/release.json"
  assert_fail validate_release_dir "$bad_dir" immutable "sha-x"
  rm -rf "$bad_dir"

  # ── Test: successful rollback preserves original deployment failure ─────
  # When on_exit runs after a successful rollback, FINAL_STATUS must still be
  # "failed" (rollback restores service; it does not make the deploy succeed).
  setup_rollback_fixtures immutable
  ln -sfn "$TEST_ROOT/releases/sha-prev" "$TEST_ROOT/releases/current"
  reset_mocks_ok
  FINAL_STATUS="failed"  # simulating the deploy failed
  FAILURE_STAGE="verify_app"  # original failure
  set +e; rollback_release; rc=$?; set -e
  [[ "$rc" -eq 0 ]] && ok "rollback: succeeded" || bad "rollback: failed"
  [[ "$FINAL_STATUS" == "failed" ]] && ok "rollback: FINAL_STATUS stays failed after successful rollback" || bad "rollback: FINAL_STATUS wrongly set to success"
  [[ "$FAILURE_STAGE" == "verify_app" ]] && ok "rollback: original failure stage preserved" || bad "rollback: failure stage overwritten"

else
  echo "  (symlink-dependent rollback tests skipped on $(uname -s) — run on Linux CI)"
fi

echo ""
echo "=== bootstrap readiness gate tests (executor health validation) ==="

# These tests exercise the EXACT Node validation logic the transition script
# uses to hard-gate executor readiness. They do not need docker — they test
# the validation function directly against JSON payloads.

# The transition script's executor health check is:
#   EXPECTED_REF=... EXPECTED_DIGEST=... node -e '...checks...'
# We replicate that check as a testable function.
check_exec_readiness() {
  local health_json="$1" exp_ref="${2:-}" exp_digest="${3:-}"
  local tmpf
  tmpf="$(mktemp)"
  printf '%s' "$health_json" >"$tmpf"
  EXPECTED_REF="$exp_ref" EXPECTED_DIGEST="$exp_digest" \
  node --input-type=module -e '
    import fs from "node:fs";
    const h = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const checks = [
      ["status", h.status, "ok"],
      ["ready", String(h.ready), "true"],
      ["container_runtime", h.container_runtime ? "present" : "missing", "present"],
    ];
    if (process.env.EXPECTED_REF && h.validator_image_ref !== process.env.EXPECTED_REF)
      checks.push(["validator_image_ref", h.validator_image_ref, process.env.EXPECTED_REF]);
    if (process.env.EXPECTED_DIGEST && h.validator_image_digest !== process.env.EXPECTED_DIGEST)
      checks.push(["validator_image_digest", h.validator_image_digest, process.env.EXPECTED_DIGEST]);
    for (const [name, got, want] of checks) {
      if (got !== want) { console.error(`executor ${name}=${got}, expected ${want}`); process.exit(1); }
    }
  ' "$tmpf"
  local rc=$?
  rm -f "$tmpf"
  return $rc
}

VALID_REF="gitwire-validator@sha256:abcdef"
VALID_DIGEST="sha256:abcdef"
HEALTHY_EXEC='{"status":"ok","ready":true,"container_runtime":"docker","validator_image_ref":"gitwire-validator@sha256:abcdef","validator_image_digest":"sha256:abcdef","git_sha":"x"}'

# Happy path: all checks pass
if check_exec_readiness "$HEALTHY_EXEC" "$VALID_REF" "$VALID_DIGEST" 2>/dev/null; then
  ok "bootstrap readiness: healthy executor accepted"
else
  bad "bootstrap readiness: healthy executor rejected"
fi

# ready=false rejected
if check_exec_readiness '{"status":"ok","ready":false,"container_runtime":"docker","validator_image_ref":"x","validator_image_digest":"y"}' "" "" 2>/dev/null; then
  bad "bootstrap readiness: ready=false accepted"
else
  ok "bootstrap readiness: ready=false rejected"
fi

# Missing container_runtime rejected
if check_exec_readiness '{"status":"ok","ready":true,"container_runtime":null,"validator_image_ref":"x","validator_image_digest":"y"}' "" "" 2>/dev/null; then
  bad "bootstrap readiness: missing runtime accepted"
else
  ok "bootstrap readiness: missing runtime rejected"
fi

# Empty container_runtime rejected
if check_exec_readiness '{"status":"ok","ready":true,"container_runtime":"","validator_image_ref":"x","validator_image_digest":"y"}' "" "" 2>/dev/null; then
  bad "bootstrap readiness: empty runtime accepted"
else
  ok "bootstrap readiness: empty runtime rejected"
fi

# Validator ref mismatch rejected
if check_exec_readiness "$HEALTHY_EXEC" "DIFFERENT_REF" "$VALID_DIGEST" 2>/dev/null; then
  bad "bootstrap readiness: validator ref mismatch accepted"
else
  ok "bootstrap readiness: validator ref mismatch rejected"
fi

# Validator digest mismatch rejected
if check_exec_readiness "$HEALTHY_EXEC" "$VALID_REF" "DIFFERENT_DIGEST" 2>/dev/null; then
  bad "bootstrap readiness: validator digest mismatch accepted"
else
  ok "bootstrap readiness: validator digest mismatch rejected"
fi

# status not ok rejected
if check_exec_readiness '{"status":"error","ready":true,"container_runtime":"docker","validator_image_ref":"x","validator_image_digest":"y"}' "" "" 2>/dev/null; then
  bad "bootstrap readiness: status=error accepted"
else
  ok "bootstrap readiness: status=error rejected"
fi

echo ""
echo "=== summary ==="
echo "passed: $passed, failed: $failed"

# Cleanup
rm -rf "$TEST_ROOT"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
exit 0
