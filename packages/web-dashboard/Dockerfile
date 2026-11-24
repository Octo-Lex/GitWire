# GitWire Dashboard — Next.js frontend
#
# Build context: the REPOSITORY ROOT
#   docker build -f packages/web-dashboard/Dockerfile .
# The dashboard is an npm workspace and its dependencies are locked in the root
# package-lock.json, which is outside this directory. The image is installed the
# way the app image is installed: with `npm ci` from that lockfile. An
# `npm install` from this directory alone resolves ranges on build day and
# ignores the lockfile, so the image stops matching what CI audits. CI compares
# the packages inside the built image with the lockfile
# (scripts/compare-image-deps.mjs).
#
# Dockerfile.dockerignore, next to this file, stands in for the root
# .dockerignore. It admits only what the COPY lines name.
FROM node:24-alpine AS builder
WORKDIR /app

# The dependency manifests and the dashboard source. The source is copied
# whole, because the checks below have to see exactly what reached the builder.
COPY package.json package-lock.json ./
COPY packages/web-dashboard ./packages/web-dashboard

# Dockerfile.dockerignore, next to this file, lets only the paths named above
# into the build context. These checks run before anything is installed, so
# they see nothing but what came from that context, and each one fails the
# build on its own when a builder ignores that file. The repository's
# .dockerignore drops the svg public assets this image serves, and it keeps
# neither a local checkout's installed dependencies nor its build output out.
RUN test ! -e packages/web-dashboard/node_modules
RUN test ! -e packages/web-dashboard/.next
RUN ls packages/web-dashboard/public/*.svg >/dev/null

# Strict npm ci, scoped to the dashboard workspace — no fallback to npm install.
# Lifecycle scripts are skipped, as in the app image.
RUN npm ci --workspace=packages/web-dashboard --ignore-scripts

# Build-info via env vars (v0.20.2) — Next.js bundles NEXT_PUBLIC_* at build time
ARG GITWIRE_VERSION=0.23.1
ARG GITWIRE_COMMIT_SHA=unknown
ARG GITWIRE_BUILT_AT=unknown

ENV NEXT_PUBLIC_GITWIRE_VERSION=$GITWIRE_VERSION
ENV NEXT_PUBLIC_GITWIRE_COMMIT_SHA=$GITWIRE_COMMIT_SHA
ENV NEXT_PUBLIC_GITWIRE_BUILT_AT=$GITWIRE_BUILT_AT

LABEL org.opencontainers.image.revision=$GITWIRE_COMMIT_SHA
LABEL org.opencontainers.image.created=$GITWIRE_BUILT_AT
LABEL org.opencontainers.image.version=$GITWIRE_VERSION
LABEL org.opencontainers.image.source="https://github.com/Octo-Lex/GitWire"

RUN npm run build --workspace=packages/web-dashboard

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Re-declare build args so labels in the runner stage carry the metadata.
ARG GITWIRE_COMMIT_SHA=unknown
ARG GITWIRE_BUILT_AT=unknown
ARG GITWIRE_VERSION=unknown

LABEL org.opencontainers.image.revision=$GITWIRE_COMMIT_SHA
LABEL org.opencontainers.image.created=$GITWIRE_BUILT_AT
LABEL org.opencontainers.image.version=$GITWIRE_VERSION
LABEL org.opencontainers.image.source="https://github.com/Octo-Lex/GitWire"

# The standalone output mirrors the repository layout from the tracing root
# set in next.config.ts, so server.js sits under the workspace directory.
COPY --from=builder /app/packages/web-dashboard/.next/standalone ./
COPY --from=builder /app/packages/web-dashboard/.next/static ./packages/web-dashboard/.next/static
COPY --from=builder /app/packages/web-dashboard/public ./packages/web-dashboard/public

EXPOSE 3001
ENV PORT=3001
# Run from the tracing root, which is what the generated server.js expects.
CMD ["node", "packages/web-dashboard/server.js"]
