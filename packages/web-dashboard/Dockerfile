# GitWire Dashboard — Next.js frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .

# Build-info via env vars (v0.20.2) — Next.js bundles NEXT_PUBLIC_* at build time
ARG GITWIRE_VERSION=0.20.1
ARG GITWIRE_COMMIT_SHA=unknown
ARG GITWIRE_BUILT_AT=unknown

ENV NEXT_PUBLIC_GITWIRE_VERSION=$GITWIRE_VERSION
ENV NEXT_PUBLIC_GITWIRE_COMMIT_SHA=$GITWIRE_COMMIT_SHA
ENV NEXT_PUBLIC_GITWIRE_BUILT_AT=$GITWIRE_BUILT_AT

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3001
ENV PORT=3001
CMD ["node", "server.js"]
