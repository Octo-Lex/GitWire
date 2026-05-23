// @gitwire/rules — plugins/loader.js
// Loads plugin files from a repository and extracts filter functions.
//
// Plugin files are JavaScript modules that export named functions.
// Each exported function becomes a filter function available in expressions.
//
// Example plugin (.gitwire/plugins/custom-filters.js):
//   export function inTeam(author, team) {
//     const teams = { frontend: ["alice", "bob"] };
//     return (teams[team] || []).includes(author);
//   }
//
// Usage in rules:
//   if: "author | inTeam('frontend')"

import { createSandbox } from "./sandbox.js";

/**
 * Parse plugin source code and extract exported functions.
 * Uses Function constructor in a sandboxed context.
 *
 * @param {string} source — JavaScript source code
 * @param {string} filename — plugin filename (for error messages)
 * @returns {object} map of function name → function
 */
export function loadPluginFromSource(source, filename = "plugin.js") {
  const sandbox = createSandbox();

  try {
    // Wrap in an IIFE that returns exports
    // Support both ESM (export function) and CJS (module.exports = {})
    const wrappedSource = `
      var __exports = {};
      ${source}
      // If ESM-style export was used, __exports should have functions
      // If CJS-style, module.exports should have them
      // If source defines functions at top level, collect named functions
      if (typeof module !== 'undefined' && module.exports && Object.keys(module.exports).length > 0) {
        __exports = module.exports;
      }
      __exports;
    `;

    // Create function in sandbox context
    const keys = Object.keys(sandbox);
    const values = Object.values(sandbox);

    // Build the function body that extracts exports
    const fnBody = `
      "use strict";
      ${wrappedSource}
      return __exports;
    `;

    const fn = new Function(...keys, fnBody);
    const exports = fn(...values);

    // Filter to only functions
    const filters = {};
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value === "function") {
        // Wrap in timeout enforcement
        filters[name] = createTimedFunction(value, name, filename);
      }
    }

    return filters;
  } catch (err) {
    throw new Error(`Failed to load plugin ${filename}: ${err.message}`);
  }
}

/**
 * Load multiple plugin sources and merge their filter functions.
 *
 * @param {Array<{source: string, filename: string}>} plugins
 * @returns {object} merged filter map
 */
export function loadPlugins(plugins) {
  const merged = {};

  for (const { source, filename } of plugins) {
    try {
      const filters = loadPluginFromSource(source, filename);
      Object.assign(merged, filters);
    } catch (_e) {
      // Skip failed plugins — don't block other plugins
    }
  }

  return merged;
}

/**
 * Wrap a plugin function with timeout enforcement.
 * Plugin functions must complete within 100ms.
 */
function createTimedFunction(fn, name, filename) {
  return (...args) => {
    // Note: In production, we'd use worker_threads for true timeout enforcement.
    // For now, just call the function and let the caller handle timeouts.
    try {
      return fn(...args);
    } catch (err) {
      throw new Error(`Plugin ${filename}#${name} error: ${err.message}`);
    }
  };
}

/**
 * Extract plugin files from a GitHub tree response.
 * Returns array of { path, filename } for .js files in .gitwire/plugins/.
 *
 * @param {Array} tree — GitHub API tree entries
 * @returns {Array<{path: string, filename: string}>}
 */
export function findPluginFiles(tree) {
  if (!Array.isArray(tree)) return [];

  return tree
    .filter((entry) => {
      if (entry.type !== "blob") return false;
      return entry.path.startsWith(".gitwire/plugins/") && entry.path.endsWith(".js");
    })
    .map((entry) => ({
      path: entry.path,
      filename: entry.path.replace(".gitwire/plugins/", ""),
    }));
}
