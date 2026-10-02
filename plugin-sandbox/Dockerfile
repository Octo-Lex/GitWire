# GitWire Plugin Sandbox Image — #425 isolation boundary
#
# Runs repository/playground plugin code inside a disposable OS sandbox. The
# executor-service launches this image with (never caller-controlled):
#   --network=none --read-only --user=1000:1000 --cap-drop=ALL
#   --security-opt=no-new-privileges --memory --cpus --pids-limit
#   --tmpfs=/tmp (bounded) --volume=<workspace>:/sandbox:ro
#
# Input arrives read-only at /sandbox/input.json; the result is one JSON
# object on stdout. No credentials, no network, no docker socket, no writable
# path outside the bounded tmpfs.
#
# Like the validator image: DO NOT use a local-only docker build for
# production. The image MUST be pushed to a registry so docker inspect shows
# RepoDigests containing the configured digest — the executor-service
# verifies this and rejects non-digest-pinned images.

FROM node:20-bookworm-slim

# node:20-bookworm-slim ships a non-root `node` user at uid/gid 1000, matching
# the executor's --user=1000:1000 contract.

WORKDIR /opt/gitwire-plugin-sandbox

# Install @gitwire/rules from the copied workspace source (file: dependency;
# js-yaml is its only runtime dependency). Nothing else is installed — the
# sandbox gets no dev tooling, no package manager access at runtime, no shell
# entrypoint.
COPY plugin-sandbox/package.json ./package.json
COPY packages/rules ./packages/rules
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY plugin-sandbox/runner.mjs ./runner.mjs

USER 1000:1000

# Fixed entrypoint — the executor appends no caller argv beyond the constant
# input path contract baked into the runner itself.
ENTRYPOINT ["node", "/opt/gitwire-plugin-sandbox/runner.mjs"]
