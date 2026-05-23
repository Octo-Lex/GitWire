// @gitwire/runtime/compat/_init.js
// Auto-initialization bridge.
// When the first compat module is imported, this ensures config is loaded
// and runtime is initialized. This handles the case where module-level
// code (like `export const phase4Queue = createQueue(...)`) runs before
// main() calls initRuntime().

import { initRuntime, isRuntimeInitialized } from "../src/index.js";

let _config = null;

/**
 * Set the config for auto-initialization.
 * Called by the config module when it loads, BEFORE any compat module.
 */
export function setConfig(config) {
  _config = config;
}

/**
 * Ensure runtime is initialized. Called by each compat module on first access.
 * If initRuntime was already called (e.g. from index.js), this is a no-op.
 * If not, it uses the config set via setConfig().
 */
export function ensureRuntime() {
  if (!isRuntimeInitialized()) {
    if (!_config) {
      throw new Error(
        "@gitwire/runtime: auto-init failed. " +
        "Either call initRuntime(config) at startup, " +
        "or import config and call setConfig() first."
      );
    }
    initRuntime(_config);
  }
  return initRuntime; // returns bound initRuntime for chaining
}

export { _config };
