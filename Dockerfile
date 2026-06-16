# GitWire production container
# Build context: monorepo root (C:\Next-Era\GitWire)
FROM node:20-alpine

WORKDIR /app

# Copy package manifests first for better Docker layer caching.
# npm install only re-runs when these files change, not on every source edit.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/rules/package.json ./packages/rules/package.json
COPY packages/web/package.json ./packages/web/package.json
# Install production dependencies only, skip lifecycle scripts (husky etc.)
# Strict npm ci — no fallback to npm install. Lockfile must be correct.
RUN npm ci --omit=dev --ignore-scripts

# Copy source (this layer only rebuilds when source actually changes)
COPY . .

# Expose the Express port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run the web package server
WORKDIR /app/packages/web
CMD ["node", "src/index.js"]
