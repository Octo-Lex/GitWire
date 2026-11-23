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
# times a second from before it is up, and keeps asking for a while after the
# TCP check first answered.
#
# What it asserts: once the TCP check has answered accepting, it answers
# accepting in every later probe. A check that had answered against the
# temporary server would stop answering when that server stops, and that is
# what fails the test.
#
# What it only reports: how many probes had the socket check answering
# accepting and the TCP check, run right after it, not answering. That is the
# race window of the old form. It depends on timing, so its count is
# information and not a verdict. A socket "no" next to a TCP "yes" is not
# counted as anything: the real server can start between the two probes.
#
# Needs docker.
# Exit 0 when the assertion holds, 1 when it does not, 2 when the test could
# not run.
set -u
NAME="pg-readiness-race-$$"
IMAGE="${PG_IMAGE:-postgres:16-alpine}"
WATCH="${WATCH_SECONDS:-15}"   # seconds to keep probing after the first TCP accept
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -e POSTGRES_USER=gitwire -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gitops_hub "$IMAGE" >/dev/null || { echo "FAIL: could not start $IMAGE"; exit 2; }

socket_sees=0
tcp_sees=0
race_moments=0     # socket accepting, TCP right after it not accepting
socket_flickers=0  # the socket check stopped answering after it had answered
tcp_flickers=0     # the TCP check stopped answering after it had answered
probes=0
prev_s=0
prev_t=0
first_tcp_s=""
first_tcp_at=""
start=$(date +%s)
while :; do
  probes=$((probes + 1))
  s=0; docker exec "$NAME" pg_isready -U gitwire -d gitops_hub >/dev/null 2>&1 && s=1
  t=0; docker exec "$NAME" pg_isready -h 127.0.0.1 -U gitwire -d gitops_hub >/dev/null 2>&1 && t=1
  [ "$s" = 1 ] && socket_sees=$((socket_sees + 1))
  [ "$t" = 1 ] && tcp_sees=$((tcp_sees + 1))
  [ "$s" = 1 ] && [ "$t" = 0 ] && race_moments=$((race_moments + 1))
  [ "$prev_s" = 1 ] && [ "$s" = 0 ] && socket_flickers=$((socket_flickers + 1))
  [ "$prev_t" = 1 ] && [ "$t" = 0 ] && tcp_flickers=$((tcp_flickers + 1))
  prev_s=$s
  prev_t=$t
  now=$(date +%s)
  if [ "$t" = 1 ] && [ -z "$first_tcp_at" ]; then first_tcp_at=$now; first_tcp_s=$((now - start)); fi
  if [ -n "$first_tcp_at" ] && [ $((now - first_tcp_at)) -ge "$WATCH" ]; then break; fi
  if [ $((now - start)) -gt 120 ]; then echo "FAIL: $IMAGE did not answer over TCP within 120 s"; exit 2; fi
done

echo "image: $IMAGE"
echo "probes, each one socket check followed by one TCP check: $probes"
echo "socket check answered accepting: $socket_sees | TCP check answered accepting: $tcp_sees"
echo "first TCP accept after about ${first_tcp_s}s; probed for ${WATCH}s after it"
echo "race window of the socket form, socket yes and TCP no in one probe: $race_moments probe(s)"
echo "the socket check stopped answering after it had answered: $socket_flickers time(s)"
echo "the TCP check stopped answering after it had answered: $tcp_flickers time(s)"
if [ "$tcp_flickers" -ne 0 ]; then
  echo "FAIL: the TCP check did not keep answering once it had answered"
  exit 1
fi
if [ "$tcp_sees" -lt 2 ]; then
  echo "FAIL: the TCP check never reached the real server"
  exit 1
fi
echo "PASS: once the TCP check answered accepting, it kept answering"
