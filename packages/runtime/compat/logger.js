// @gitwire/runtime/compat/logger.js
// Lazy singleton — delegates to the runtime-initialized logger.
// Auto-initializes from config if needed.

import { getRuntime } from "../src/index.js";
import { ensureRuntime } from "./_init.js";

let _logger = null;

function getLogger() {
  if (!_logger) {
    ensureRuntime();
    _logger = getRuntime().logger;
  }
  return _logger;
}

export const logger = new Proxy(
  {},
  {
    get(_target, prop) {
      const log = getLogger();
      const val = log[prop];
      return typeof val === "function" ? val.bind(log) : val;
    },
  }
);
