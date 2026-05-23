// src/lib/github.js
// Re-exported from @gitwire/runtime for backward compatibility.
// All existing imports continue to work:
//   import { getWebhookApp, getInstallationClient, forEachInstallation, forEachRepo } from "../lib/github.js";

export {
  getWebhookApp,
  getInstallationClient,
  forEachInstallation,
  forEachRepo,
} from "@gitwire/runtime/compat/github.js";
