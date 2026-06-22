# GitWire Executor Service — container-runtime execution boundary
#
# v0.23.0 Task 2 skeleton. This service exposes GET /health only (POST
# /v1/validate is Task 5). Zero npm dependencies — uses only Node built-ins.
#
# The CT-local Docker socket is NOT mounted here — that's a compose-level
# concern (docker-compose.yml mounts /var/run/docker.sock into this service
# at runtime). The image itself is just Node + the service code.
#
# Security boundary: this container is privileged RELATIVE TO gitwire-app
# (it will be able to run validator containers via the mounted socket), but
# the service itself drops root and runs as uid 1000.

FROM node:20-alpine AS runtime
WORKDIR /app

# Drop root. Matches the validator container's non-root contract (uid 1000)
# and the broader "services shouldn't run as root" hygiene.
RUN addgroup -g 1000 -S executor && \
    adduser -u 1000 -S -G executor executor
USER 1000:1000

# Copy service code. No npm install needed — the package has no dependencies.
COPY --chown=executor:executor package.json ./
COPY --chown=executor:executor src ./src

# Build-info via build args (v0.22.0+ pattern). The service doesn't currently
# report these in /health, but they're here for parity with other packages
# and future use.
ARG GITWIRE_VERSION=0.22.0
ARG GITWIRE_COMMIT_SHA=unknown
ARG GITWIRE_BUILT_AT=unknown
ENV GITWIRE_VERSION=$GITWIRE_VERSION \
    GITWIRE_COMMIT_SHA=$GITWIRE_COMMIT_SHA \
    GITWIRE_BUILT_AT=$GITWIRE_BUILT_AT

EXPOSE 3003
ENV PORT=3003 \
    NODE_ENV=production

# Healthcheck: poll /health. The service is "healthy" if it answers at all
# (status: ok); the `ready` field in the body reflects deeper readiness
# (runtime reachable + validator identity complete). Docker's healthcheck
# gate is the liveness signal; operators watch `ready`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "src/index.js"]
