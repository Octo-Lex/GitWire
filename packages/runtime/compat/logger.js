// @gitwire/runtime/compat/logger.js
// Lazy singleton — delegates to the runtime-initialized logger.
// This allows existing code to keep using:
//   import { logger } from "../lib/logger.js";

import { getRuntime } from "../src/index.js";

export const logger = new Proxy(
  {},
  {
    get(_target, prop) {
      const rt = getRuntime();
      const val = rt.logger[prop];
      return typeof val === "function" ? val.bind(rt.logger) : val;
    },
  }
);
