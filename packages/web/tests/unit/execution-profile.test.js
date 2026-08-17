// tests/unit/execution-profile.test.js
// RI-9 Phase 10 (slice B): execution profiles — the model-neutral data
// model, receipt persistence, and the prohibited-fields invariant.
//
// An execution profile is descriptive metadata about one LLM invocation.
// It is never an authorization credential: nothing in this slice may
// introduce model-qualification vocabulary or state.

import { jest } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const mockDbQuery = jest.fn();
await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockDbQuery },
}));

const {
  buildExecutionProfile,
  computeConfigurationFingerprint,
  deriveBudgetProfileId,
  resolveIdentitySource,
  providerFromBaseURL,
  normalizeUsage,
  usageFromCategories,
  normalizeCost,
  classifyPrimaryTerminal,
  classifyVerifierTerminal,
  canonicalJson,
  EXECUTION_TERMINAL_STATE,
  IDENTITY_SOURCE,
  EXECUTION_PROFILE_SCHEMA_VERSION,
} = await import("../../src/services/executionProfileService.js");
const { persistIntegrityReceipt } = await import("../../src/services/integrityReceiptService.js");
const {
  TOOL_CONTRACT_NAME,
  TOOL_CONTRACT_VERSION,
} = await import("../../src/lib/repositoryTools/contract.js");

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

// ── Identity semantics ───────────────────────────────────────────────────────

describe("Phase 10: identity source semantics", () => {

  it("requested + provider-observed model → provider_reported", () => {
    expect(resolveIdentitySource({ requestedModel: "m-a", observedModel: "m-b" }))
      .toBe(IDENTITY_SOURCE.PROVIDER_REPORTED);
  });

  it("requested model only → requested_only", () => {
    expect(resolveIdentitySource({ requestedModel: "m-a", observedModel: null }))
      .toBe(IDENTITY_SOURCE.REQUESTED_ONLY);
    expect(resolveIdentitySource({ requestedModel: "m-a" }))
      .toBe(IDENTITY_SOURCE.REQUESTED_ONLY);
  });

  it("completely opaque identity → opaque", () => {
    expect(resolveIdentitySource({})).toBe(IDENTITY_SOURCE.OPAQUE);
    expect(resolveIdentitySource({ requestedModel: null, observedModel: null }))
      .toBe(IDENTITY_SOURCE.OPAQUE);
  });

  it("a provider exposing nothing beyond the requested route yields requested_only with null observedModel", () => {
    const profile = buildExecutionProfile({ requestedModel: "route-model-x" });
    expect(profile.observedModel).toBeNull();
    expect(profile.identitySource).toBe(IDENTITY_SOURCE.REQUESTED_ONLY);
  });

  it("a fully opaque route yields opaque and does not fail anything", () => {
    const profile = buildExecutionProfile({});
    expect(profile.observedModel).toBeNull();
    expect(profile.requestedModel).toBeNull();
    expect(profile.identitySource).toBe(IDENTITY_SOURCE.OPAQUE);
    expect(profile.terminalState).toBeNull();
    expect(profile.usage).toBeNull();
    expect(profile.configurationFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("provider is derived from the API endpoint host only when parseable", () => {
    expect(providerFromBaseURL("https://api.example.org/v1")).toBe("api.example.org");
    expect(providerFromBaseURL("not a url")).toBeNull();
    expect(providerFromBaseURL(null)).toBeNull();
  });
});

// ── Analytics fingerprint ────────────────────────────────────────────────────

describe("Phase 10: analytics fingerprint from GitWire-controlled configuration", () => {

  const baseConfig = () => ({
    adapter: "anthropic-sdk-primary",
    protocol: "anthropic-messages",
    requestedRoute: "https://api.example.org/v1",
    requestedModel: "model-a",
    promptId: "v2-primary-r1",
    promptHash: "abc123",
    repositoryToolContract: TOOL_CONTRACT_NAME,
    repositoryToolContractVersion: TOOL_CONTRACT_VERSION,
    outputSchemaVersion: "2",
    integritySchemaVersion: 1,
    budgetProfileId: "bp-000000000000",
  });

  it("same controlled config → same fingerprint", () => {
    expect(computeConfigurationFingerprint(baseConfig()))
      .toBe(computeConfigurationFingerprint(baseConfig()));
  });

  it("input key order never matters", () => {
    const a = baseConfig();
    const b = {};
    for (const k of Object.keys(a).reverse()) b[k] = a[k];
    expect(computeConfigurationFingerprint(a)).toBe(computeConfigurationFingerprint(b));
  });

  it("requested model change → different fingerprint", () => {
    const cfg = baseConfig();
    const changed = { ...cfg, requestedModel: "model-b" };
    expect(computeConfigurationFingerprint(changed)).not.toBe(computeConfigurationFingerprint(cfg));
  });

  it("prompt change → different fingerprint", () => {
    const cfg = baseConfig();
    expect(computeConfigurationFingerprint({ ...cfg, promptHash: "def456" }))
      .not.toBe(computeConfigurationFingerprint(cfg));
  });

  it("repository-tool contract version change → different fingerprint", () => {
    const cfg = baseConfig();
    expect(computeConfigurationFingerprint({ ...cfg, repositoryToolContractVersion: "3" }))
      .not.toBe(computeConfigurationFingerprint(cfg));
  });

  it("budget profile change → different fingerprint", () => {
    const cfg = baseConfig();
    expect(computeConfigurationFingerprint({ ...cfg, budgetProfileId: "bp-ffffffffffff" }))
      .not.toBe(computeConfigurationFingerprint(cfg));
  });

  it("provider-observed identity is NOT a fingerprint input", () => {
    // The provider-reported actual model must not move the fingerprint:
    // segmentation is by controlled configuration, not claimed identity.
    const cfg = baseConfig();
    const p1 = buildExecutionProfile({ ...cfg, observedModel: "claimed-a" });
    const p2 = buildExecutionProfile({ ...cfg, observedModel: "claimed-b" });
    expect(p1.configurationFingerprint).toBe(p2.configurationFingerprint);
    expect(p1.observedModel).toBe("claimed-a");
    expect(p2.observedModel).toBe("claimed-b");
  });

  it("canonical serialization is deterministic and order-insensitive", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }))
      .toBe(canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  });

  it("budget profile id derives deterministically from limits", () => {
    expect(deriveBudgetProfileId({ maxFileReads: 20, maxSearches: 6 }))
      .toBe(deriveBudgetProfileId({ maxSearches: 6, maxFileReads: 20 }));
    expect(deriveBudgetProfileId({ maxFileReads: 21, maxSearches: 6 }))
      .not.toBe(deriveBudgetProfileId({ maxFileReads: 20, maxSearches: 6 }));
    expect(deriveBudgetProfileId(null)).toBeNull();
  });
});

// ── Usage / cost normalization ───────────────────────────────────────────────

describe("Phase 10: usage and cost normalization", () => {

  it("absent usage → null (receipt stays valid)", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
    const profile = buildExecutionProfile({});
    expect(profile.usage).toBeNull();
  });

  it("snake_case provider usage normalizes with null cache categories", () => {
    expect(normalizeUsage({ input_tokens: 10, output_tokens: 4 }))
      .toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 14 });
  });

  it("full usage with cache categories normalizes", () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 50 }))
      .toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 50, totalTokens: 164 });
  });

  it("usageFromCategories carries only what the loop actually saw", () => {
    expect(usageFromCategories({ inputTokens: 7, outputTokens: 3 }))
      .toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 10 });
    expect(usageFromCategories({})).toBeNull();
  });

  it("cost only where support exists — never synthesized", () => {
    expect(normalizeCost(null)).toBeNull();
    expect(normalizeCost({ amount: 0.012, currency: "USD", source: "pi-harness" }))
      .toEqual({ amount: 0.012, currency: "USD", source: "pi-harness" });
    expect(normalizeCost({ amount: "cheap" })).toBeNull();
  });
});

// ── Terminal-state classification ────────────────────────────────────────────

describe("Phase 10: terminal-state classification", () => {

  it("primary: clean submission → completed", () => {
    expect(classifyPrimaryTerminal({ error: null, submitted: true }))
      .toBe(EXECUTION_TERMINAL_STATE.COMPLETED);
  });

  it("primary: no submission → incomplete", () => {
    expect(classifyPrimaryTerminal({ error: null, submitted: false }))
      .toBe(EXECUTION_TERMINAL_STATE.INCOMPLETE);
  });

  it("primary: timeout and budget classes are distinct", () => {
    expect(classifyPrimaryTerminal({ error: "Primary review timed out: LLM call (round 0)" }))
      .toBe(EXECUTION_TERMINAL_STATE.TIMEOUT);
    expect(classifyPrimaryTerminal({ error: "LLM invocation failed: Primary review timed out: LLM call (round 2) after 180000ms" }))
      .toBe(EXECUTION_TERMINAL_STATE.TIMEOUT);
    expect(classifyPrimaryTerminal({ error: "Token budget exceeded: 120000 > 100000" }))
      .toBe(EXECUTION_TERMINAL_STATE.BUDGET_EXCEEDED);
  });

  it("primary: provider error and invalid submission classes", () => {
    expect(classifyPrimaryTerminal({ error: "LLM invocation failed: 500 Internal Server Error" }))
      .toBe(EXECUTION_TERMINAL_STATE.PROVIDER_ERROR);
    expect(classifyPrimaryTerminal({ error: "Failed to parse primary review response" }))
      .toBe(EXECUTION_TERMINAL_STATE.INVALID_SUBMISSION);
    expect(classifyPrimaryTerminal({ error: "Schema validation failed: findings must be an array" }))
      .toBe(EXECUTION_TERMINAL_STATE.INVALID_SUBMISSION);
  });

  it("primary: invocation precondition failures are incomplete, not provider errors", () => {
    expect(classifyPrimaryTerminal({ error: "Missing review root with base/head SHAs" }))
      .toBe(EXECUTION_TERMINAL_STATE.INCOMPLETE);
    expect(classifyPrimaryTerminal({ error: "Failed to create context broker: bad budgets" }))
      .toBe(EXECUTION_TERMINAL_STATE.INCOMPLETE);
  });

  it("verifier: verified/material_findings → completed; INCOMPLETE splits by error", () => {
    expect(classifyVerifierTerminal({ status: "verified" })).toBe(EXECUTION_TERMINAL_STATE.COMPLETED);
    expect(classifyVerifierTerminal({ status: "material_findings" })).toBe(EXECUTION_TERMINAL_STATE.COMPLETED);
    expect(classifyVerifierTerminal({ status: "incomplete", error: null }))
      .toBe(EXECUTION_TERMINAL_STATE.INCOMPLETE);
    expect(classifyVerifierTerminal({ status: "error", error: "Verifier timed out: LLM call (round 1)" }))
      .toBe(EXECUTION_TERMINAL_STATE.TIMEOUT);
    expect(classifyVerifierTerminal({ status: "error", error: "HTTP 502" }))
      .toBe(EXECUTION_TERMINAL_STATE.PROVIDER_ERROR);
  });
});

// ── Receipt persistence (RI-8 extension) ─────────────────────────────────────

describe("Phase 10: persistIntegrityReceipt embeds execution profiles", () => {

  const evidence = {
    version: 1,
    review: { repoId: 1, prNumber: 7, baseSha: "b", headSha: "h", invocationId: "rinv:x" },
    changedFiles: [],
    contextItems: [],
    retrievalTrace: [],
    coverage: { totalChangedFiles: 0, fullyCoveredFiles: 0, approvalEvidenceComplete: true },
  };
  const decision = { event: "COMMENT", checkState: "review_incomplete", approvalEligible: false, decisionReason: "test" };

  it("persists primary and verifier profiles additively in the manifest", async () => {
    const primaryExecutionProfile = buildExecutionProfile({
      requestedModel: "model-a", observedModel: "model-a-real",
      adapter: "anthropic-sdk-primary", promptId: "v2-primary-r1",
      terminalState: "completed",
    });
    const verifierExecutionProfile = buildExecutionProfile({
      requestedModel: "model-a", adapter: "anthropic-sdk-verifier",
      promptId: "v2-verifier-r1", terminalState: "completed",
    });

    await persistIntegrityReceipt({
      reviewRowId: 1, evidence, verifierReceipt: null, decision,
      primaryFindings: [], budgetState: null, invocationId: "rinv:x",
      primaryExecutionProfile, verifierExecutionProfile,
    });

    const manifest = JSON.parse(mockDbQuery.mock.calls[0][1][0]);
    expect(manifest.executionProfiles.primary.configurationFingerprint)
      .toBe(primaryExecutionProfile.configurationFingerprint);
    expect(manifest.executionProfiles.primary.identitySource).toBe(IDENTITY_SOURCE.PROVIDER_REPORTED);
    expect(manifest.executionProfiles.verifier.promptId).toBe("v2-verifier-r1");
    expect(manifest.executionProfiles.primary.schemaVersion).toBe(EXECUTION_PROFILE_SCHEMA_VERSION);
  });

  it("null profiles keep the receipt valid (optional telemetry)", async () => {
    await persistIntegrityReceipt({
      reviewRowId: 1, evidence, verifierReceipt: null, decision,
      primaryFindings: [], budgetState: null, invocationId: "rinv:x",
    });
    const manifest = JSON.parse(mockDbQuery.mock.calls[0][1][0]);
    expect(manifest.executionProfiles).toEqual({ primary: null, verifier: null, adversarial: null, defense: null });
  });

  it("sanitizes unknown fields out of persisted profiles", async () => {
    const noisy = buildExecutionProfile({ requestedModel: "m" });
    noisy.sneakyExtraField = "should-not-persist";

    await persistIntegrityReceipt({
      reviewRowId: 1, evidence, verifierReceipt: null, decision,
      primaryFindings: [], budgetState: null, invocationId: "rinv:x",
      primaryExecutionProfile: noisy,
    });

    const manifest = JSON.parse(mockDbQuery.mock.calls[0][1][0]);
    expect(manifest.executionProfiles.primary.sneakyExtraField).toBeUndefined();
    expect(manifest.executionProfiles.primary.requestedModel).toBe("m");
  });

  it("persists adversarial and defense profiles alongside primary and verifier", async () => {
    const adversarialExecutionProfile = buildExecutionProfile({
      requestedModel: "claude-haiku-4-20250414", observedModel: "glm-served",
      adapter: "anthropic-sdk-adversarial", promptId: null,
      budgetLimits: { maxTokens: 2048 }, terminalState: "completed",
    });
    const defenseExecutionProfile = buildExecutionProfile({
      requestedModel: "claude-haiku-4-20250414", observedModel: "glm-served",
      adapter: "anthropic-sdk-defense", promptId: null,
      budgetLimits: { maxTokens: 2048 }, terminalState: "completed",
    });

    await persistIntegrityReceipt({
      reviewRowId: 1, evidence, verifierReceipt: null, decision,
      primaryFindings: [], budgetState: null, invocationId: "rinv:x",
      adversarialExecutionProfile, defenseExecutionProfile,
    });

    const manifest = JSON.parse(mockDbQuery.mock.calls[0][1][0]);
    expect(manifest.executionProfiles.primary).toBeNull();
    expect(manifest.executionProfiles.verifier).toBeNull();
    expect(manifest.executionProfiles.adversarial.requestedModel).toBe("claude-haiku-4-20250414");
    expect(manifest.executionProfiles.adversarial.observedModel).toBe("glm-served");
    expect(manifest.executionProfiles.adversarial.adapter).toBe("anthropic-sdk-adversarial");
    expect(manifest.executionProfiles.defense.adapter).toBe("anthropic-sdk-defense");
    expect(manifest.executionProfiles.adversarial.schemaVersion).toBe(EXECUTION_PROFILE_SCHEMA_VERSION);
  });
});

// ── Prohibited-fields invariant (frozen in the Phase 10 plan) ────────────────

describe("Phase 10: no model-qualification vocabulary enters the codebase", () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const PROHIBITED = [
    "qualified_model",
    "approved_model",
    "approval_capable",
    "allowed_model",
    "can_approve",
    "model_authorized",
  ];

  function listJsFiles(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git" || entry === "coverage") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) listJsFiles(full, acc);
      else if (entry.endsWith(".js") || entry.endsWith(".mjs")) acc.push(full);
    }
    return acc;
  }

  it("src/ contains none of the prohibited identifiers", () => {
    const files = listJsFiles(join(webRoot, "src"));
    expect(files.length).toBeGreaterThan(50);
    const offenders = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const token of PROHIBITED) {
        if (content.includes(token)) offenders.push(file + " contains " + token);
      }
    }
    expect(offenders).toEqual([]);
  });
});
