// @gitwire/rules — helpers.js
// Query helpers for resolved config objects.

import { DEFAULT_CONFIG } from "./schema.js";

/**
 * Check if a pillar is enabled in the given config.
 * Returns true by default (missing enabled = true) unless explicitly false.
 */
export function isPillarEnabled(pillar, config) {
  return config?.pillars?.[pillar]?.enabled !== false;
}

/**
 * Check if dry-run mode is enabled.
 * When true, workers log what they would do but skip all mutations.
 */
export function isDryRun(config) {
  return config?.settings?.dry_run === true;
}

/**
 * Check if a file path is allowed for CI healing patching.
 * Blocked patterns take precedence over allowed patterns.
 */
export function isFileAllowed(filePath, config) {
  const ci = config?.pillars?.ci_healing || {};
  const blocked = ci.blocked_file_patterns || [];
  const allowed = ci.allowed_file_patterns || ["**"];

  // Blocked (denylist) wins
  for (const pattern of blocked) {
    if (matchGlob(filePath, pattern)) return false;
  }

  // Then check allowed
  for (const pattern of allowed) {
    if (matchGlob(filePath, pattern)) return true;
  }

  return false;
}

/**
 * Check if a file path is in the blocked-paths list for issue_fix.
 */
export function isFixPathBlocked(filePath, config) {
  const blocked = config?.pillars?.issue_fix?.blocked_paths || [];
  return blocked.some((p) => matchGlob(filePath, p));
}

/**
 * Check if an issue label qualifies for autonomous fixing.
 */
export function isFixLabelAllowed(label, config) {
  const allowed = config?.pillars?.issue_fix?.allowed_labels || [];
  return allowed
    .map((l) => l.toLowerCase())
    .includes(label.toLowerCase());
}

/**
 * Get stale config for a given item type (issues or prs).
 */
export function getStaleConfig(type, config) {
  const stale = config?.pillars?.maintainer?.stale || {};
  return stale[type] || {};
}

/**
 * Check if an item is exempt from stale management by label.
 */
export function isStaleExempt(labels, type, config) {
  const staleConfig = getStaleConfig(type, config);
  const exempt = staleConfig.exempt_labels || [];
  return labels.some((l) => exempt.includes(l));
}

// ── Glob matching ────────────────────────────────────────────────────────────
// Supports *, **, and simple literal matching.
// NOT a full glob implementation — good enough for file path patterns.

export function matchGlob(str, pattern) {
  // Convert glob pattern to regex
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // ** matches any path including /
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (pattern[i] === "*") {
      // * matches anything except /
      regex += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      regex += "[^/]";
      i++;
    } else {
      regex += escapeRegex(pattern[i]);
      i++;
    }
  }

  return new RegExp("^" + regex + "$").test(str);
}

function escapeRegex(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
