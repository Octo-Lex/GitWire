// src/services/executionProfileService.js
// Model-neutral execution profiles (RI-9 Phase 10).
//
// An execution profile is DESCRIPTIVE METADATA about one LLM invocation
// (primary reviewer or approval verifier). It records who was asked, who
// answered (when the provider reports it), what GitWire-controlled
// configuration was in force, how the invocation terminated, and what it
// consumed. It is never an authorization credential:
//
//   - computeReviewDecision (RI-6) must not read any of these fields;
//   - model identity MUST NOT grant or remove APPROVE authority;
//   - missing optional telemetry never makes a review incomplete.
//
// Providers differ in what they expose. A provider that reports nothing
// beyond the requested route yields identitySource "requested_only"; a
// fully opaque route yields "opaque". Unknown token categories and unknown
// actual-model identities are NEVER synthesized.

import { createHash } from "node:crypto";
import { TOOL_CONTRACT_NAME, TOOL_CONTRACT_VERSION } from "../lib/repositoryTools/contract.js";

// ── Schema / contract identity (descriptive constants) ───────────────────────

export const EXECUTION_PROFILE_SCHEMA_VERSION = 1;

// Matches the finding schema rendered to the model in the submit_review_result
// tool (the same { name, version } shape the harness ReviewTask carries).
export const OUTPUT_SCHEMA = Object.freeze({ name: "gitwire-findings", version: "2" });

// Matches the ai_reviews.integrity_version default (migration 043).
export const INTEGRITY_SCHEMA_VERSION = 1;

// ── Identity source ──────────────────────────────────────────────────────────

export const IDENTITY_SOURCE = Object.freeze({
  PROVIDER_REPORTED: "provider_reported",
  REQUESTED_ONLY:    "requested_only",
  OPAQUE:            "opaque",
});

// ── Terminal states ──────────────────────────────────────────────────────────

export const EXECUTION_TERMINAL_STATE = Object.freeze({
  COMPLETED:          "completed",
  INCOMPLETE:         "incomplete",
  TIMEOUT:            "timeout",
  BUDGET_EXCEEDED:    "budget_exceeded",
  PROVIDER_ERROR:     "provider_error",
  INVALID_SUBMISSION: "invalid_submission",
});

// ── Identity normalization ───────────────────────────────────────────────────

/**
 * How the model identity on a profile was established.
 * observed → provider_reported; requested only → requested_only; neither → opaque.
 */
export function resolveIdentitySource({ requestedModel = null, observedModel = null } = {}) {
  if (observedModel) return IDENTITY_SOURCE.PROVIDER_REPORTED;
  if (requestedModel) return IDENTITY_SOURCE.REQUESTED_ONLY;
  return IDENTITY_SOURCE.OPAQUE;
}

/**
 * Hostname of an API base URL, or null. Used as descriptive provider
 * metadata only — a null (opaque) provider is valid.
 */
export function providerFromBaseURL(baseURL) {
  if (!baseURL || typeof baseURL !== "string") return null;
  try {
    return new URL(baseURL).hostname || null;
  } catch (_e) {
    return null;
  }
}

// ── Analytics fingerprint ────────────────────────────────────────────────────

/**
 * Deterministic canonical serialization: recursively sorted keys, stable
 * array order, null for undefined. Key order in the input never matters.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Analytics fingerprint over GitWire-CONTROLLED configuration only.
 *
 * Inputs: adapter, protocol, requestedRoute, requestedModel, promptId,
 * promptHash, repository-tool contract name/version, output + integrity
 * schema versions, budgetProfileId. The provider-REPORTED model/deployment
 * is recorded alongside the fingerprint but is deliberately NOT an input —
 * the fingerprint segments by what GitWire configured, not by what the
 * provider claims to be.
 */
export function computeConfigurationFingerprint(config = {}) {
  const controlled = {
    adapter: config.adapter ?? null,
    protocol: config.protocol ?? null,
    requestedRoute: config.requestedRoute ?? null,
    requestedModel: config.requestedModel ?? null,
    promptId: config.promptId ?? null,
    promptHash: config.promptHash ?? null,
    repositoryToolContract: config.repositoryToolContract ?? null,
    repositoryToolContractVersion: config.repositoryToolContractVersion ?? null,
    outputSchemaVersion: config.outputSchemaVersion ?? null,
    integritySchemaVersion: config.integritySchemaVersion ?? null,
    budgetProfileId: config.budgetProfileId ?? null,
  };
  return "sha256:" + sha256Hex(canonicalJson(controlled)).slice(0, 16);
}

/**
 * Deterministic budget-profile id from the invocation's actual budget
 * limits (canonical serialization → short hash). Two invocations with the
 * same limits share a profile id; any limit change creates a new one.
 * Null when no limits are known.
 */
export function deriveBudgetProfileId(budgetLimits) {
  if (!budgetLimits || typeof budgetLimits !== "object") return null;
  return "bp-" + sha256Hex(canonicalJson(budgetLimits)).slice(0, 12);
}

// ── Usage / cost normalization ───────────────────────────────────────────────

/**
 * Normalize provider usage into profile shape. Accepts either Anthropic
 * snake_case usage ({input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}) or already-normalized camelCase. Returns
 * null when the provider exposed no usage — the profile stays valid.
 * Unknown categories stay null; they are never synthesized.
 */
export function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const pick = (...names) => {
    for (const n of names) {
      if (typeof rawUsage[n] === "number" && Number.isFinite(rawUsage[n])) return rawUsage[n];
    }
    return null;
  };
  const inputTokens = pick("inputTokens", "input_tokens");
  const outputTokens = pick("outputTokens", "output_tokens");
  const cacheReadTokens = pick("cacheReadTokens", "cache_read_input_tokens");
  const cacheWriteTokens = pick("cacheWriteTokens", "cache_creation_input_tokens");
  const known = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].filter(v => v !== null);
  const totalTokens = known.length > 0
    ? known.reduce((s, v) => s + v, 0)
    : (typeof rawUsage.totalTokens === "number" ? rawUsage.totalTokens : null);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

/**
 * Usage from accumulated per-category totals (the production SDK loop
 * accumulates input/output separately; cache categories are not exposed
 * there and stay null).
 */
export function usageFromCategories({ inputTokens = null, outputTokens = null } = {}) {
  if (inputTokens === null && outputTokens === null) return null;
  return {
    inputTokens: typeof inputTokens === "number" ? inputTokens : null,
    outputTokens: typeof outputTokens === "number" ? outputTokens : null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

/**
 * Normalize cost. Only recorded where support already exists (e.g. a
 * harness-computed cost); never synthesized from token guesses.
 */
export function normalizeCost(rawCost) {
  if (!rawCost || typeof rawCost !== "object") return null;
  const amount = typeof rawCost.amount === "number" ? rawCost.amount : null;
  if (amount === null) return null;
  return {
    amount,
    currency: typeof rawCost.currency === "string" ? rawCost.currency : null,
    source: typeof rawCost.source === "string" ? rawCost.source : null,
  };
}

// ── Terminal-state classification ────────────────────────────────────────────

// Error prefixes this package's own services construct. Classification is
// deterministic over strings produced by the same frozen code paths.
const TIMEOUT_PREFIXES = ["Primary review timed out", "Verifier timed out"];
const BUDGET_PREFIXES = ["Token budget exceeded"];
const INVALID_SUBMISSION_PREFIXES = [
  "Failed to parse primary review response",
  "Failed to parse verifier response",
  "Schema validation failed",
  "Verifier schema validation failed",
];
const PRECONDITION_PREFIXES = ["Missing review root", "Failed to create context broker"];

function classifyError(error) {
  const msg = String(error);
  if (TIMEOUT_PREFIXES.some(p => msg.startsWith(p)) || /timed? ?out/i.test(msg)) {
    return EXECUTION_TERMINAL_STATE.TIMEOUT;
  }
  if (BUDGET_PREFIXES.some(p => msg.startsWith(p))) return EXECUTION_TERMINAL_STATE.BUDGET_EXCEEDED;
  if (INVALID_SUBMISSION_PREFIXES.some(p => msg.startsWith(p))) return EXECUTION_TERMINAL_STATE.INVALID_SUBMISSION;
  if (PRECONDITION_PREFIXES.some(p => msg.startsWith(p))) return EXECUTION_TERMINAL_STATE.INCOMPLETE;
  return EXECUTION_TERMINAL_STATE.PROVIDER_ERROR;
}

/**
 * Terminal state for a PRIMARY invocation from its receipt facts.
 * Deterministic; reads only receipt-shaped inputs.
 */
export function classifyPrimaryTerminal({ error = null, submitted = false, schemaValid = true } = {}) {
  if (error) return classifyError(error);
  if (submitted && !schemaValid) return EXECUTION_TERMINAL_STATE.INVALID_SUBMISSION;
  if (!submitted) return EXECUTION_TERMINAL_STATE.INCOMPLETE;
  return EXECUTION_TERMINAL_STATE.COMPLETED;
}

/**
 * Terminal state for a VERIFIER invocation from its receipt status.
 * VERIFIED / MATERIAL_FINDINGS are successful completions; INCOMPLETE and
 * ERROR map through (ERROR splits into timeout/provider error by message).
 */
export function classifyVerifierTerminal({ status = null, error = null } = {}) {
  if (status === "verified" || status === "material_findings") return EXECUTION_TERMINAL_STATE.COMPLETED;
  if (error) return classifyError(error);
  return EXECUTION_TERMINAL_STATE.INCOMPLETE;
}

// ── Profile builder ──────────────────────────────────────────────────────────

/**
 * Build one normalized execution profile. All provider-dependent fields
 * are nullable; identitySource and configurationFingerprint are derived.
 *
 * @param {object} params
 * @param {string|null} params.provider - API endpoint host (descriptive, nullable)
 * @param {string|null} params.adapter - GitWire-side invocation adapter
 * @param {string|null} params.protocol - wire protocol
 * @param {string|null} params.requestedRoute - requested endpoint/route
 * @param {string|null} params.requestedModel - model GitWire asked for
 * @param {string|null} params.observedModel - model the provider reported
 * @param {string|null} params.observedDeployment - deployment the provider reported
 * @param {string|null} params.promptId - prompt identity
 * @param {string|null} params.promptHash - prompt content hash
 * @param {string|null} params.budgetLimits - invocation budget limits object
 * @param {string|null} params.budgetProfileId - derived id (or derive from limits)
 * @param {string|null} params.repositoryToolContract - override (default v2 contract)
 * @param {string|null} params.repositoryToolContractVersion - override
 * @param {number|null} params.integritySchemaVersion - override
 * @param {object|null} params.outputSchema - {name, version} override
 * @param {Date|number|string|null} params.startedAt
 * @param {Date|number|string|null} params.completedAt
 * @param {number|null} params.durationMs
 * @param {string|null} params.configurationFingerprint - precomputed override (default: derive)
 * @param {string|null} params.terminalState - from classify*Terminal
 * @param {string|null} params.terminalReason
 * @param {object|null} params.usage - raw usage (normalized here)
 * @param {object|null} params.cost - raw cost (normalized here)
 */
export function buildExecutionProfile({
  provider = null,
  adapter = null,
  protocol = null,
  requestedRoute = null,
  requestedModel = null,
  observedModel = null,
  observedDeployment = null,
  promptId = null,
  promptHash = null,
  budgetLimits = null,
  budgetProfileId = null,
  repositoryToolContract = null,
  repositoryToolContractVersion = null,
  integritySchemaVersion = null,
  outputSchema = null,
  configurationFingerprint = null,
  startedAt = null,
  completedAt = null,
  durationMs = null,
  terminalState = null,
  terminalReason = null,
  usage = null,
  cost = null,
} = {}) {
  const resolvedBudgetProfileId = budgetProfileId || deriveBudgetProfileId(budgetLimits);
  const resolvedOutputSchema = outputSchema || OUTPUT_SCHEMA;
  const normalizedOutputVersion = resolvedOutputSchema && typeof resolvedOutputSchema === "object"
    ? String(resolvedOutputSchema.version ?? null)
    : null;

  const derivedFingerprint = typeof configurationFingerprint === "string" && configurationFingerprint
    ? configurationFingerprint
    : computeConfigurationFingerprint({
        adapter, protocol, requestedRoute, requestedModel,
        promptId, promptHash,
        repositoryToolContract: repositoryToolContract || TOOL_CONTRACT_NAME,
        repositoryToolContractVersion: repositoryToolContractVersion || TOOL_CONTRACT_VERSION,
        outputSchemaVersion: normalizedOutputVersion,
        integritySchemaVersion: integritySchemaVersion ?? INTEGRITY_SCHEMA_VERSION,
        budgetProfileId: resolvedBudgetProfileId,
      });

  const profile = {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,

    provider: provider || null,
    adapter: adapter || null,
    protocol: protocol || null,

    requestedRoute: requestedRoute || null,
    requestedModel: requestedModel || null,

    observedModel: observedModel || null,
    observedDeployment: observedDeployment || null,

    identitySource: resolveIdentitySource({ requestedModel, observedModel }),

    configurationFingerprint: derivedFingerprint,

    promptId: promptId || null,
    promptHash: promptHash || null,

    repositoryToolContract: repositoryToolContract || TOOL_CONTRACT_NAME,
    repositoryToolContractVersion: repositoryToolContractVersion || TOOL_CONTRACT_VERSION,

    integritySchemaVersion: integritySchemaVersion ?? INTEGRITY_SCHEMA_VERSION,
    outputSchemaVersion: normalizedOutputVersion,
    budgetProfileId: resolvedBudgetProfileId,

    startedAt: toIsoOrNull(startedAt),
    completedAt: toIsoOrNull(completedAt),
    durationMs: typeof durationMs === "number" ? durationMs : null,

    terminalState: terminalState || null,
    terminalReason: terminalReason || null,

    usage: normalizeUsage(usage),
    cost: normalizeCost(cost),
  };

  return profile;
}

/**
 * Trim a profile to the persisted receipt shape (drops nothing today, but
 * centralizes the persistence boundary so receipts stay additive-safe).
 */
export function executionProfileForReceipt(profile) {
  if (!profile || typeof profile !== "object") return null;
  return buildExecutionProfile(profile);
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
