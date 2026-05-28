// src/lib/githubSanitize.js
// Sanitize GitHub webhook payloads before persisting to PostgreSQL.
//
// Strips token-scoped fields that should not be stored:
//   - permissions     (token-scoped access level)
//   - role_name       (admin/maintainer/write — token-scoped)
//   - temp_clone_token (actual authentication token)
//   - token           (any token field)
//
// Uses an allowlist for repo_view responses and recursive stripping
// for nested objects. Safe to call on any webhook payload structure.

import { logger } from "./logger.js";

// Fields that are always stripped from GitHub repo objects
const TOKEN_SCOPED_FIELDS = new Set([
  "temp_clone_token",
  "token",
]);

// Fields stripped only from GitHub repo objects (identified by having
// full_name + html_url + private)
const REPO_RESTRICTED_FIELDS = new Set([
  "permissions",
  "role_name",
]);

// Fields allowed in sanitized repo_view responses (top-level only)
const REPO_VIEW_ALLOWLIST = new Set([
  "id", "node_id", "name", "full_name", "owner", "private",
  "html_url", "description", "fork", "url", "homepage", "language",
  "forks_count", "stargazers_count", "watchers_count", "size",
  "default_branch", "open_issues_count", "is_template", "topics",
  "visibility", "archived", "disabled", "license", "pushed_at",
  "created_at", "updated_at", "clone_url", "ssh_url", "git_url",
  "svn_url", "mirror_url", "has_issues", "has_projects",
  "has_downloads", "has_wiki", "has_pages", "has_discussions",
  "network_count", "subscribers_count", "organization",
]);

/**
 * Sanitize a GitHub webhook payload for safe storage.
 * Recursively walks the object and strips token-scoped fields.
 * @param {object} payload - GitHub webhook payload
 * @returns {object} Sanitized payload (new object, original not mutated)
 */
export function sanitizeWebhookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  try {
    return deepSanitize(payload, false);
  } catch (err) {
    logger.warn({ err: err.message }, "Payload sanitization failed — storing original");
    return payload;
  }
}

/**
 * Deep-sanitize an object, stripping token-scoped fields.
 * @param {any} value
 * @param {boolean} inRepo - Whether we're inside a repo object
 * @returns {any}
 */
function deepSanitize(value, inRepo) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(function (item) { return deepSanitize(item, false); });
  }

  const isRepo = isGitHubRepoObject(value);
  const out = {};

  for (const [key, val] of Object.entries(value)) {
    // Always strip token-scoped fields
    if (TOKEN_SCOPED_FIELDS.has(key)) {
      continue;
    }

    // Strip repo-restricted fields from repo objects
    if (isRepo && REPO_RESTRICTED_FIELDS.has(key)) {
      continue;
    }

    // Recurse into nested objects
    out[key] = deepSanitize(val, isRepo);
  }

  return out;
}

/**
 * Check if an object looks like a GitHub repository object.
 * Repo objects have full_name, html_url, and private fields.
 * @param {object} obj
 * @returns {boolean}
 */
export function isGitHubRepoObject(obj) {
  return (
    obj !== null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    typeof obj.full_name === "string" &&
    typeof obj.html_url === "string" &&
    typeof obj.private === "boolean"
  );
}

/**
 * Sanitize a repo_view response using a strict allowlist.
 * Only keeps known-safe fields.
 * @param {object} repoObj - GitHub repo object
 * @returns {object}
 */
export function sanitizeRepoView(repoObj) {
  if (!isGitHubRepoObject(repoObj)) return repoObj;

  const out = {};
  for (const [key, value] of Object.entries(repoObj)) {
    if (REPO_VIEW_ALLOWLIST.has(key)) {
      out[key] = deepSanitize(value, true);
    }
  }
  return out;
}
