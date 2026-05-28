// src/lib/githubWrapper.js
// Wraps an Octokit instance with caching and rate limit tracking.
//
// Usage:
//   const octokit = await getInstallationClient(installationId);
//   const wrapped = wrapOctokit(octokit);
//   // All .request() calls now go through cache + rate tracking
//   const { data } = await wrapped.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ... });

import { getCached, setCached } from "../services/githubCache.js";
import { recordRateHeaders, classifyError, setCooldown } from "../services/githubRateLimit.js";
import { logger } from "./logger.js";

/**
 * Wrap an Octokit instance with cache and rate limit tracking.
 * Returns a Proxy that intercepts .request() calls.
 * @param {object} octokit - Octokit instance
 * @param {{ skipCache?: boolean }} [opts]
 * @returns {object} Proxied octokit
 */
export function wrapOctokit(octokit, opts) {
  opts = opts || {};
  const skipCache = opts.skipCache || false;

  return new Proxy(octokit, {
    get(target, prop) {
      if (prop === "request") {
        return function wrappedRequest(route, params) {
          return cachedRequest(target, route, params, skipCache);
        };
      }
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

/**
 * Execute a GitHub API request with caching and rate tracking.
 * @param {object} octokit - Raw Octokit instance
 * @param {string} route - e.g. "GET /repos/{owner}/{repo}/pulls/{pull_number}"
 * @param {object} [params] - Route parameters
 * @param {boolean} skipCache
 * @returns {Promise<object>} GitHub API response
 */
async function cachedRequest(octokit, route, params, skipCache) {
  const method = route.split(" ")[0];
  const pathTemplate = route.split(" ").slice(1).join(" ");

  // Only cache GET requests
  if (method === "GET" && !skipCache) {
    const resolvedPath = resolvePath(pathTemplate, params);
    const query = extractQuery(params);

    // Check cache
    const cached = await getCached(method, resolvedPath, query);
    if (cached) {
      return { data: cached, headers: {}, status: 200, cached: true };
    }

    // Cache miss — make the request
    const response = await octokit.request(route, params);

    // Record rate limit headers
    if (response.headers) {
      await recordRateHeaders(response.headers);
    }

    // Cache successful responses
    if (response.status === 200 && response.data !== undefined) {
      await setCached(method, resolvedPath, query, response.data);
    }

    return response;
  }

  // Non-GET or cache-skipped — make the request directly
  try {
    const response = await octokit.request(route, params);

    // Record rate limit headers from mutations too
    if (response.headers) {
      await recordRateHeaders(response.headers);
    }

    return response;
  } catch (err) {
    // Track rate limit errors
    if (err.status && err.headers) {
      await recordRateHeaders(err.headers);
      const classification = classifyError(err.status, err.headers);
      if (classification.ttlMs > 0) {
        await setCooldown(classification.scope, classification.ttlMs, classification.reason);
      }
    }
    throw err;
  }
}

/**
 * Resolve a path template with parameter values.
 * "GET /repos/{owner}/{repo}/pulls/{pull_number}" → "/repos/acme/app/pulls/42"
 */
function resolvePath(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, function (_match, key) {
    return params[key] != null ? String(params[key]) : "{" + key + "}";
  });
}

/**
 * Extract query parameters (those that don't appear in the path template).
 */
function extractQuery(params) {
  if (!params) return undefined;
  const query = {};
  const queryKeys = ["per_page", "page", "sort", "direction", "state", "status",
    "sha", "ref", "path", "since", "until", "filter", "labels",
    "milestone", "assignee", "creator", "mentioned", "base", "head"];

  for (const key of queryKeys) {
    if (params[key] !== undefined) {
      query[key] = params[key];
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}
