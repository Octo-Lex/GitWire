// @gitwire/rules — barrel export
export { DEFAULT_CONFIG, CONFIG_SCHEMA_VERSION, validateConfig, isDangerousConfigKey } from "./schema.js";
export { parseConfig, mergeDeep } from "./parse.js";
export {
  parseConfigLayer,
  resolveConfigLayers,
  stableStringify,
  hashCanonical,
  LAYER_ORDER,
} from "./resolve.js";
export {
  isPillarEnabled,
  isDryRun,
  isFileAllowed,
  isFixPathBlocked,
  isFixLabelAllowed,
  getStaleConfig,
  isStaleExempt,
  matchGlob,
  meetsConfidence,
  getMinPatchConfidence,
  getMinFixConfidence,
  scoreCIRisk,
  scoreFixRisk,
  shouldTrigger,
  evaluateRules,
} from "./helpers.js";
export {
  evaluateCondition,
  evaluateGate,
  evaluateAllGates,
  getRequiredMetrics,
  formatGateSummary,
} from "./gates.js";
export {
  VALID_PRIORITIES,
  VALID_CATEGORIES,
  VALID_CORRECTNESS,
  priorityToSeverity,
  severityToPriority,
  categoryToPass,
  validateFinding,
  validateReviewReport,
  reportToLegacy,
  extractReviewJSON,
  buildReviewSystemPrompt,
} from "./reviewSchema.js";
