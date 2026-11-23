#!/usr/bin/env bash
# scripts/check-pg-readiness-tcp.sh
#
# Static gate for #501: every PostgreSQL readiness check in the CI workflow
# goes over TCP. The postgres image's temporary setup server listens on the
# Unix socket only, so a socket check can pass against it and then fail in the
# restart window. Three places matter, and all three are checked:
#   1. the service health-cmd of docker-build-app,
#   2. the wait loop and fail-closed check of publish-release-images,
#   3. the wait loop and fail-closed check of release-tooling-validation.
# Exit 0 when no socket-form pg_isready remains, 1 otherwise.
set -u
WF="${1:-.github/workflows/ci.yml}"
LINES=$(grep -n "pg_isready" "$WF" || true)
if [ -z "$LINES" ]; then
  echo "FAIL: no pg_isready found in $WF"
  exit 1
fi
BAD=$(printf '%s\n' "$LINES" | grep -v -- "-h 127.0.0.1" | grep -vE "^[0-9]+:[[:space:]]*#" | grep -vE "^[0-9]+:[[:space:]]*(- )?(name|uses):" || true)
if [ -n "$BAD" ]; then
  echo "FAIL: PostgreSQL readiness checks that do not go over TCP:"
  printf '%s\n' "$BAD" | cut -c1-140
  exit 1
fi
printf '%s\n' "$LINES" | sed 's/^/  /'
echo "PASS: every pg_isready in $WF uses -h 127.0.0.1"
