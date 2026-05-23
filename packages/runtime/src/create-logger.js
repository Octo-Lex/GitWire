// @gitwire/runtime/src/create-logger.js
// Factory for creating a pino logger instance.
// Accepts { logLevel, env } — no config import needed.

import pino from "pino";

/**
 * Create a pino logger.
 * @param {{ logLevel?: string, env?: string }} opts
 * @returns {import("pino").Logger}
 */
export function createLogger(opts = {}) {
  const level = opts.logLevel || "info";
  const env = opts.env || "development";

  return pino({
    level,
    transport:
      env !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    base: { service: "gitwire" },
  });
}
