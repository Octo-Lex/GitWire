// @gitwire/runtime/src/index.js
// Infrastructure layer for GitWire.
//
// Usage:
//   import { initRuntime } from "@gitwire/runtime";
//   const runtime = initRuntime(config);  // call once at startup
//
// Then import from compat/ for lazy singletons that downstream code uses:
//   import { db } from "@gitwire/runtime/compat/db.js";

import { createLogger }   from "./create-logger.js";
import { createDatabase } from "./create-db.js";
import { createRedisConnection, createQueue, createWorker } from "./create-queue.js";
import { createGitHubApp } from "./create-github.js";
import { QUEUES } from "@gitwire/core";

// ── Runtime state ────────────────────────────────────────────────────────────

let _runtime = null;

/**
 * Initialize the runtime with a config object. Call once at app startup.
 * @param {{
 *   server: { logLevel?: string, env?: string },
 *   db: { url: string },
 *   redis: { url: string },
 *   github: { appId?: string, privateKey?: string, clientId?: string, clientSecret?: string, webhookSecret?: string }
 * }} config
 * @returns {{ logger, db, redis, github, QUEUES, createQueue, createWorker }}
 */
export function initRuntime(config) {
  if (_runtime) {
    console.warn("@gitwire/runtime: initRuntime() called more than once — returning existing runtime");
    return _runtime;
  }

  const logger = createLogger({
    logLevel: config.server?.logLevel,
    env: config.server?.env,
  });

  const db = createDatabase({
    url: config.db?.url,
    logger,
  });

  const redis = createRedisConnection(config.redis?.url, { logger });

  const github = createGitHubApp({
    appId:         config.github?.appId,
    privateKey:    config.github?.privateKey,
    clientId:      config.github?.clientId,
    clientSecret:  config.github?.clientSecret,
    webhookSecret: config.github?.webhookSecret,
    logger,
  });

  _runtime = { logger, db, redis, github, QUEUES };

  return _runtime;
}

/**
 * Get the initialized runtime. Throws if initRuntime() hasn't been called.
 * @returns {{ logger, db, redis, github, QUEUES }}
 */
export function getRuntime() {
  if (!_runtime) {
    throw new Error(
      "@gitwire/runtime not initialized. Call initRuntime(config) at app startup first."
    );
  }
  return _runtime;
}

/** Check if runtime has been initialized. */
export function isRuntimeInitialized() {
  return _runtime !== null;
}

/** Reset runtime state (for tests only). */
export function resetRuntime() {
  _runtime = null;
}

// ── Re-export factories for direct use ───────────────────────────────────────

export { createLogger } from "./create-logger.js";
export { createDatabase } from "./create-db.js";
export { createRedisConnection, createQueue, createWorker } from "./create-queue.js";
export { createGitHubApp } from "./create-github.js";
