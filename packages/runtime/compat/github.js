// @gitwire/runtime/compat/github.js
// Lazy singleton — delegates to the runtime-initialized GitHub App.
// This allows existing code to keep using:
//   import { getWebhookApp, getInstallationClient, forEachInstallation, forEachRepo } from "../lib/github.js";

import { getRuntime } from "../src/index.js";

export function getWebhookApp() {
  return getRuntime().github.getWebhookApp();
}

export async function getInstallationClient(installationId) {
  return getRuntime().github.getInstallationClient(installationId);
}

export async function forEachInstallation(fn) {
  return getRuntime().github.forEachInstallation(fn);
}

export async function forEachRepo(octokit, fn) {
  return getRuntime().github.forEachRepo(octokit, fn);
}
