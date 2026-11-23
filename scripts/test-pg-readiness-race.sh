#!/usr/bin/env bash
# scripts/test-pg-readiness-race.sh
#
# Regression test for #501. The postgres image starts a temporary server during
# its own setup, on the Unix socket only, and replaces it with the real one.
# A readiness check over the Unix socket can pass against that temporary
# server and fail a moment later, in the restart window. A check over TCP
# cannot: the temporary server does not listen on TCP.
#
# This starts one postgres container and asks it both ways, back to back, many
# times a second from before it is up until the real server answers. It fails
# when the socket check answers "accepting" while the TCP check, run
# immediately after, does not. It also fails when the TCP check ever answers
# before the socket check.
#
# Needs docker. Exit 0 when no such moment is seen, 1 when one is.
set -u
NAME="pg-readiness-race-$$"
IMAGE="${PG_IMAGE:-postgres:16-alpine}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_USER=gitwire -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gitops_hub "$IMAGE" >/dev/null || { echo "FAIL: could not start $IMAGE"; exit 2; }

socket_sees=0
tcp_sees=0
race_moments=0
tcp_first=0
probes=0
first_tcp_s=""
start=$(date +%s)
while :; do
  probes=$((probes + 1))
  s=0; docker exec "$NAME" pg_isready -U gitwire -d gitops_hub >/dev/null 2>&1 && s=1
  t=0; docker exec "$NAME" pg_isready -h 127.0.0.1 -U gitwire -d gitops_hub >/dev/null 2>&1 && t=1
  [ "$s" = 1 ] && socket_sees=$((socket_sees + 1))
  [ "$t" = 1 ] && tcp_sees=$((tcp_sees + 1))
  if [ "$s" = 1 ] && [ "$t" = 0 ]; then race_moments=$((race_moments + 1)); fi
  if [ "$t" = 1 ] && [ "$s" = 0 ]; then tcp_first=$((tcp_first + 1)); fi
  if [ "$t" = 1 ] && [ -z "$first_tcp_s" ]; then first_tcp_s=$(( $(date +%s) - start )); fi
  # Stop once the real server has answered over TCP twenty times in a row.
  if [ "$t" = 1 ]; then
    n=$(( ${n:-0} + 1 )); [ "$n" -ge 20 ] && break
  else
    n=0
  fi
  [ $(( $(date +%s) - start )) -gt 120 ] && { echo "FAIL: $IMAGE did not answer over TCP within 120 s"; exit 2; }
done

echo "image: $IMAGE"
echo "probes (each is one socket check followed by one TCP check): $probes"
echo "socket check answered accepting: $socket_sees | TCP check answered accepting: $tcp_sees"
echo "first TCP accept after about ${first_tcp_s}s"
echo "moments with socket=yes and TCP=no (the race window): $race_moments"
echo "moments with TCP=yes and socket=no: $tcp_first"
if [ "$tcp_first" -ne 0 ]; then echo "FAIL: the TCP check passed where the socket check did not"; exit 1; fi
if [ "$tcp_sees" -lt 20 ]; then echo "FAIL: the TCP check never reached the real server"; exit 1; fi
echo "PASS: the TCP check never answered before the real server was up"
