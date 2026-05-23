// @gitwire/rules — barrel export
export { DEFAULT_CONFIG, validateConfig } from "./schema.js";
export { parseConfig, mergeDeep } from "./parse.js";
export {
  isPillarEnabled,
  isDryRun,
  isFileAllowed,
  isFixPathBlocked,
  isFixLabelAllowed,
  getStaleConfig,
  isStaleExempt,
  matchGlob,
} from "./helpers.js";
