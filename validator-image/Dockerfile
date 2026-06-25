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

# Create non-root user matching the executor's --user=1000:1000 contract.
RUN groupadd -g 1000 validator && \
    useradd -u 1000 -g 1000 -m -s /bin/sh validator

# Redirect npm/HOME writes to /workspace (the writable bind mount).
# Without this, npm tries to write to ~ or / which are read-only at runtime.
ENV HOME=/workspace \
    NPM_CONFIG_CACHE=/workspace/.npm-cache \
    npm_config_cache=/workspace/.npm-cache \
    NODE_ENV=production

# Bake the baseline GitWire repo into /opt/gitwire-base.
WORKDIR /opt/gitwire-base

# Copy dependency manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY scripts ./scripts

# Install all dependencies (including devDeps for lint/test/build).
RUN npm ci --ignore-scripts

# Copy the remaining repo files needed for validation.
COPY eslint.config.* ./
COPY validator-image/docker-entrypoint.sh /usr/local/bin/gitwire-validator-entrypoint
RUN chmod +x /usr/local/bin/gitwire-validator-entrypoint

# Ensure the validator user owns the baseline.
RUN chown -R 1000:1000 /opt/gitwire-base

USER 1000:1000

ENTRYPOINT ["gitwire-validator-entrypoint"]
