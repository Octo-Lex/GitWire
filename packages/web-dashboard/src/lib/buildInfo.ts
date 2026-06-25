// packages/web-dashboard/src/lib/buildInfo.ts
// Committed fallback build-info module for the dashboard.
//
// Uses NEXT_PUBLIC_* env vars (injected by the Dockerfile build args during
// production builds) with committed fallback values so local dev, tests, and
// fresh clones work without running the generator.
//
// The env-aware pattern avoids changing the dashboard Docker build context
// (which is isolated to packages/web-dashboard) — the Dockerfile sets
// NEXT_PUBLIC_GITWIRE_VERSION etc. as build args, and Next.js bundles them.

export const BUILD_INFO = Object.freeze({
  version: process.env.NEXT_PUBLIC_GITWIRE_VERSION || "0.23.1",
  gitSha: process.env.NEXT_PUBLIC_GITWIRE_COMMIT_SHA || null,
  builtAt: process.env.NEXT_PUBLIC_GITWIRE_BUILT_AT || null,
  source: process.env.NEXT_PUBLIC_GITWIRE_VERSION ? "env" : "fallback",
});
