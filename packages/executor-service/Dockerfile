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

# Install docker-cli so probeRuntime() can shell out to `docker --version`
# and (load-bearing) `docker info` to verify the mounted CT-local socket is
# actually reachable. Without the client binary in the image, the service
# would report ready=false even with the socket mounted.
#
# podman-cli is intentionally NOT installed: the v0.23.0 default is the
# CT-local Docker socket (per docs/architecture/v0.23-executor-service.md).
# Podman stays as a fallback probe target in code for other deployments.
USER root
RUN apk add --no-cache docker-cli wget

# Create workspace-tmp dir owned by uid 1000 so the validator runner can create
# tempdirs there (mounted as a Docker volume in compose for Docker-in-LXC visibility).
RUN mkdir -p /workspace-tmp && chown 1000:1000 /workspace-tmp && chmod 777 /workspace-tmp

# Drop root. node:20-alpine already ships a non-root `node` user at uid 1000
# (gid 1000), which matches the validator container's non-root contract.
# Creating a fresh executor group at gid 1000 collides with the existing node
# group, so we reuse the built-in node user instead.
USER node

# Copy service code. No npm install needed — the package has no dependencies.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Build-info via build args (v0.22.0+ pattern). The service doesn't currently
# report these in /health, but they're here for parity with other packages
# and future use.
ARG GITWIRE_VERSION=0.23.1
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
