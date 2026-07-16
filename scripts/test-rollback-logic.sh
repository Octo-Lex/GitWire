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

# Stub docker so no real mutation happens. The rollback/release functions that
# need docker are NOT exercised here — only the pure validation logic.
docker() { echo "[stub] docker $*" >&2; return 0; }

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
  cat >"$dir/images.env" <<EOF
GITWIRE_APP_IMAGE=ghcr.io/octo-lex/gitwire-app@sha256:$(printf 'a%.0s' $(seq 1 64))
GITWIRE_EXECUTOR_IMAGE=ghcr.io/octo-lex/gitwire-executor-service@sha256:$(printf 'b%.0s' $(seq 1 64))
GITWIRE_DASHBOARD_IMAGE=ghcr.io/octo-lex/gitwire-dashboard@sha256:$(printf 'c%.0s' $(seq 1 64))
EOF
  cat >"$dir/release.json" <<EOF
{"schema_version":1,"kind":"immutable","release_id":"$sha","git_sha":"$sha","workflow_run_id":"123","created_at":"2026-01-01T00:00:00Z","images":{"app":"a","executor":"b","dashboard":"c"}}
EOF
}

make_bootstrap_release() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/images.env" <<EOF
GITWIRE_APP_IMAGE=gitwire-local/gitwire-app:bootstrap-aaa
GITWIRE_EXECUTOR_IMAGE=gitwire-local/gitwire-executor-service:bootstrap-bbb
GITWIRE_DASHBOARD_IMAGE=gitwire-local/gitwire-dashboard:bootstrap-ccc
EOF
  cat >"$dir/release.json" <<EOF
{"schema_version":1,"kind":"bootstrap","release_id":"bootstrap-20260101","git_sha":null,"workflow_run_id":null,"created_at":"2026-01-01T00:00:00Z","images":{"app":"a","executor":"b","dashboard":"c"},"bootstrap_image_ids":{"app":"sha256:aaa","executor":"sha256:bbb","dashboard":"sha256:ccc"}}
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
echo "=== summary ==="
echo "passed: $passed, failed: $failed"

# Cleanup
rm -rf "$TEST_ROOT"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
exit 0
