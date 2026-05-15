// src/lib/github.js
// Wraps @octokit/app to provide:
//   - App-level JWT auth (for GitHub API calls as the App itself)
//   - Installation-level token auth (for calls on behalf of an org/user)
//   - A pre-configured Webhooks instance for signature verification
//
// The GitHub App is created lazily so the server can boot without
// credentials (useful for local dev / API-only mode).

import { App } from "@octokit/app";
import { config } from "../../config/index.js";
import { logger } from "./logger.js";

// ── Lazy GitHub App singleton ──────────────────────────────────────────────
let _githubApp = null;

function getGithubApp() {
  if (!_githubApp) {
    if (!config.github.appId || !config.github.privateKey) {
      throw new Error(
        "GitHub App not configured. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY in .env"
      );
    }
    _githubApp = new App({
      appId:         config.github.appId,
      privateKey:    config.github.privateKey,
      clientId:      config.github.clientId,
      clientSecret:  config.github.clientSecret,
      webhooks: {
        secret: config.github.webhookSecret,
      },
    });
  }
  return _githubApp;
}

// Expose for webhook verification (returns null if not configured)
export function getWebhookApp() {
  try { return getGithubApp(); } catch { return null; }
}

// ── Convenience: get an Octokit client for a specific installation ───────────
/**
 * Returns an Octokit instance authenticated for the given installation.
 * Tokens are short-lived (1 hour) and cached by @octokit/app automatically.
 *
 * @param {number} installationId
 * @returns {Promise<import("@octokit/rest").Octokit>}
 */
export async function getInstallationClient(installationId) {
  return getGithubApp().getInstallationOctokit(installationId);
}

// ── Convenience: iterate all installations for the App ──────────────────────
/**
 * Calls `fn` for every installation of the GitHub App.
 * Useful for the sync worker to fan out across all orgs.
 *
 * @param {(octokit, installation) => Promise<void>} fn
 */
export async function forEachInstallation(fn) {
  for await (const { octokit, installation } of getGithubApp().eachInstallation.iterator()) {
    try {
      await fn(octokit, installation);
    } catch (err) {
      logger.error(
        { installationId: installation.id, err },
        "Error processing installation"
      );
    }
  }
}

// ── Convenience: iterate all repos for an installation ──────────────────────
/**
 * Calls `fn` for every repository the installation can access.
 *
 * @param {import("@octokit/rest").Octokit} octokit
 * @param {(repo) => Promise<void>} fn
 */
export async function forEachRepo(octokit, fn) {
  try {
    const { data } = await octokit.request('GET /installation/repositories', {
      per_page: 100,
    });
    for (const repository of data.repositories) {
      try {
        await fn(repository);
      } catch (err) {
        logger.error({ repoId: repository.id, err }, "Error processing repo");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to list repos for installation");
  }
}
