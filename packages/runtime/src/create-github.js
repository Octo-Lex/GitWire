// @gitwire/runtime/src/create-github.js
// Factory for creating a GitHub App client.
// Accepts GitHub credentials — no config import needed.

import { App } from "@octokit/app";

/**
 * Create a GitHub App wrapper with lazy initialization.
 * @param {{ appId: string, privateKey: string, clientId?: string, clientSecret?: string, webhookSecret?: string, logger?: object }} opts
 * @returns {{ getWebhookApp, getInstallationClient, forEachInstallation, forEachRepo, getApp }}
 */
export function createGitHubApp(opts) {
  const logger = opts.logger || console;
  let _app = null;

  function getApp() {
    if (!_app) {
      if (!opts.appId || !opts.privateKey) {
        throw new Error(
          "GitHub App not configured. Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY in .env"
        );
      }
      _app = new App({
        appId:         opts.appId,
        privateKey:    opts.privateKey,
        clientId:      opts.clientId,
        clientSecret:  opts.clientSecret,
        webhooks: {
          secret: opts.webhookSecret,
        },
      });
    }
    return _app;
  }

  /**
   * Expose for webhook verification (returns null if not configured).
   */
  function getWebhookApp() {
    try { return getApp(); } catch (_e) { return null; }
  }

  /**
   * Returns an Octokit instance authenticated for the given installation.
   * @param {number} installationId
   */
  async function getInstallationClient(installationId) {
    return getApp().getInstallationOctokit(installationId);
  }

  /**
   * Calls fn for every installation of the GitHub App.
   * @param {(octokit, installation) => Promise<void>} fn
   */
  async function forEachInstallation(fn) {
    for await (const { octokit, installation } of getApp().eachInstallation.iterator()) {
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

  /**
   * Calls fn for every repository the installation can access.
   * @param {import("@octokit/rest").Octokit} octokit
   * @param {(repo) => Promise<void>} fn
   */
  async function forEachRepo(octokit, fn) {
    try {
      const { data } = await octokit.request("GET /installation/repositories", {
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

  return { getWebhookApp, getInstallationClient, forEachInstallation, forEachRepo, getApp };
}
