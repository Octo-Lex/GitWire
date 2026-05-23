// @gitwire/rules — plugins/sandbox.js
// Sandboxed execution context for user plugin files.
//
// Provides a restricted global scope — no require, no fs, no process, no net.
// Only safe, pure JavaScript globals are available.

const SAFE_GLOBALS = {
  // JSON
  JSON,
  // Math
  Math,
  // Primitive constructors
  Array,
  Object,
  String,
  Number,
  Boolean,
  Date,
  RegExp,
  Map,
  Set,
  // Error types (for throwing in plugins)
  Error,
  TypeError,
  RangeError,
  // Utility
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  // Console (log-only, no side effects)
  console: {
    log: (...args) => {}, // Silenced — plugins shouldn't log in production
    warn: (...args) => {},
    error: (...args) => {},
  },
  // Explicitly NOT available:
  // require, process, __dirname, __filename, global, globalThis,
  // fetch, XMLHttpRequest, setTimeout, setInterval, setImmediate,
  // Buffer, URL, URLSearchParams, TextEncoder, TextDecoder
};

/**
 * Create a sandboxed VM context for executing plugin code.
 *
 * @param {object} [extraGlobals] — additional globals to expose (for testing)
 * @returns {object} sandbox context with safe globals
 */
export function createSandbox(extraGlobals = {}) {
  const sandbox = { ...SAFE_GLOBALS, ...extraGlobals };

  // The module/exports pattern for CommonJS-style plugin files
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;

  return sandbox;
}

/**
 * Get the list of blocked globals (for documentation/testing).
 */
export function getBlockedGlobals() {
  return [
    "require", "process", "__dirname", "__filename",
    "global", "globalThis", "fetch", "XMLHttpRequest",
    "setTimeout", "setInterval", "setImmediate",
    "Buffer", "URL", "URLSearchParams",
    "TextEncoder", "TextDecoder",
    "clearTimeout", "clearInterval", "clearImmediate",
    "queueMicrotask", "Proxy", "Reflect",
    "WeakRef", "FinalizationRegistry",
    "SharedArrayBuffer", "Atomics",
  ];
}

export { SAFE_GLOBALS };
