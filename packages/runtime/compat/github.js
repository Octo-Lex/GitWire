// @gitwire/runtime/compat/github.js
// Lazy singleton — delegates to the runtime-initialized GitHub App.
// Auto-initializes from config if needed.

import { getRuntime } from "../src/index.js";
import { ensureRuntime } from "./_init.js";

export function getWebhookApp() {
  ensureRuntime();
  return getRuntime().github.getWebhookApp();
}

export async function getInstallationClient(installationId) {
  ensureRuntime();
  return getRuntime().github.getInstallationClient(installationId);
}

export async function forEachInstallation(fn) {
  ensureRuntime();
  return getRuntime().github.forEachInstallation(fn);
}

export async function forEachRepo(octokit, fn) {
  ensureRuntime();
  return getRuntime().github.forEachRepo(octokit, fn);
}
