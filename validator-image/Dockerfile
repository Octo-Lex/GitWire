# GitWire Validator Image — v0.23.0
#
# Proof-bearing validation runtime compatible with the executor-service isolation
# contract. Runs lint/test/build against a merged workspace (baseline repo +
# executor-provided patched files) under strict isolation:
#   --network=none --read-only --user=1000:1000
#
# The baseline GitWire repo is baked into /opt/gitwire-base at image build time.
# At runtime, the entrypoint merges the executor's patched files onto the baseline
# in /workspace (the writable bind mount), then execs the requested command.
#
# DO NOT use a local-only docker build for production. The image MUST be pushed
# to a registry so docker inspect shows RepoDigests containing the configured
# digest — the executor-service verifies this and rejects non-digest-pinned images.

FROM node:20-bookworm-slim

# node:20-bookworm-slim already ships a non-root `node` user at uid/gid 1000,
# which matches the executor's --user=1000:1000 contract. Reuse it rather than
# creating a new user (groupadd -g 1000 would collide with the existing node group).

# Redirect npm/HOME writes to /workspace (the writable bind mount).
# Without this, npm tries to write to ~ or / which are read-only at runtime.
#
# P1 fix: NODE_ENV is NOT set to production here. When NODE_ENV=production,
# npm ci omits devDependencies — but lint/test require dev tooling (eslint,
# jest). Set NODE_ENV at runtime if needed; the image build must install all
# dependencies including devDeps.
ENV HOME=/workspace \
    NPM_CONFIG_CACHE=/workspace/.npm-cache \
    npm_config_cache=/workspace/.npm-cache

# Bake the baseline GitWire repo into /opt/gitwire-base.
WORKDIR /opt/gitwire-base

# Copy dependency manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts

# Install ALL dependencies including devDeps (lint/test need eslint, jest, etc).
# Explicit --include=dev overrides any inherited NODE_ENV=production that would
# omit devDependencies. P1 fix from review.
RUN npm ci --include=dev --ignore-scripts

# Copy the entrypoint into the image.
COPY validator-image/docker-entrypoint.sh /usr/local/bin/gitwire-validator-entrypoint
RUN chmod +x /usr/local/bin/gitwire-validator-entrypoint

# Ensure the validator user owns the baseline.
RUN chown -R 1000:1000 /opt/gitwire-base

USER 1000:1000

ENTRYPOINT ["gitwire-validator-entrypoint"]
