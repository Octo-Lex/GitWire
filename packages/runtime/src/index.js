// @gitwire/runtime — Infrastructure layer
//
// Target home for: db, queue, logger, GitHub client.
//
// BLOCKED: These modules currently import config from @gitwire/web/config.
// Extraction requires decoupling config resolution so runtime modules
// accept a config object instead of importing it directly.
//
// Plan:
//   1. v0.7.x: Refactor config into a shared module or init-pattern
//   2. v0.8.0: Move db.js, queue.js, logger.js, github.js here
//   3. @gitwire/web re-exports from @gitwire/runtime for backward compat
//
// Dependencies declared in package.json: pg, bullmq, ioredis, pino,
// @octokit/app, @octokit/rest, dotenv

console.warn(
  "@gitwire/runtime: not yet populated. " +
  "Import from @gitwire/web/src/lib/ for now."
);
