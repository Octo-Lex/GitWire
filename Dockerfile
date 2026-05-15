# GitWire production container
# Build context: monorepo root (C:\Next-Era\GitWire)
FROM node:20-alpine

WORKDIR /app

# Copy entire monorepo
COPY . .

# Install all dependencies
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Expose the Express port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run the web package server
WORKDIR /app/packages/web
CMD ["node", "src/index.js"]
