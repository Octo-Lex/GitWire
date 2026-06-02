// tests/unit/service-adversarial-defense-trigger.test.js
// Tests for shouldRunDefense() — dynamic Turn 3 trigger logic.
//
// shouldRunDefense is a pure function exported from aiReviewService.js.
// It evaluates Turn 2 (adversarial challenge) results and decides whether
// Turn 3 (defense pass) should fire based on config mode and trigger conditions.

import { jest } from "@jest/globals";

// Mock config before importing anything that uses it
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test-key", baseURL: "https://test.api" },
  },
}));

// Mock all heavy dependencies — we only need shouldRunDefense()
await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: jest.fn() },
}));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: jest.fn(),
}));
await jest.unstable_mockModule("minimatch", () => ({
  minimatch: jest.fn(),
}));
await jest.unstable_mockModule("@gitwire/rules", () => ({
  extractReviewJSON: jest.fn(),
  buildReviewSystemPrompt: jest.fn(),
  reportToLegacy: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/reviewBundleService.js", () => ({
  buildReviewBundle: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/reviewValidator.js", () => ({
  validateReview: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/reviewHeartbeat.js", () => ({
  withHeartbeat: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/auditTrailService.js", () => ({
  Trail: { aiDecision: jest.fn(), reviewGateBlock: jest.fn() },
}));
await jest.unstable_mockModule("../../src/services/pipelineEvents.js", () => ({
  Events: { ciRunCompleted: jest.fn() },
}));
await jest.unstable_mockModule("../../src/services/adversarialReview.js", () => ({
  runAdversarialChallenge: jest.fn(),
  refineFindings: jest.fn(),
}));
await jest.unstable_mockModule("../../src/services/adversarialDefense.js", () => ({
  runDefensePass: jest.fn(),
  refineWithDefense: jest.fn(),
}));

const { shouldRunDefense } = await import("../../src/services/aiReviewService.js");

describe("shouldRunDefense", () => {
  // ── Mode: always ─────────────────────────────────────────────────────────
  describe("mode=always", () => {
    it("always returns run=true", () => {
      const result = shouldRunDefense("always", [], [], [], []);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("mode=always");
    });

    it("runs even with no findings or challenges", () => {
      const result = shouldRunDefense("always", [], [], [], []);
      expect(result.run).toBe(true);
    });
  });

  // ── Mode: never ──────────────────────────────────────────────────────────
  describe("mode=never", () => {
    it("always returns run=false", () => {
      const result = shouldRunDefense("never", [], [], [], []);
      expect(result.run).toBe(false);
      expect(result.reason).toBe("mode=never");
    });

    it("skips even when triggers would match", () => {
      const challenges = [{ finding_index: 0, suggested_action: "drop" }];
      const result = shouldRunDefense("never", ["dropped_findings"], [], challenges, []);
      expect(result.run).toBe(false);
    });
  });

  // ── Mode: auto (default) ─────────────────────────────────────────────────
  describe("mode=auto", () => {
    it("skips when no triggers match (all kept)", () => {
      const findings = [{ severity: "medium" }];
      const challenges = [{ finding_index: 0, suggested_action: "keep" }];
      const result = shouldRunDefense(
        "auto",
        ["dropped_findings", "critical_downgraded", "new_criticals"],
        findings, challenges, []
      );
      expect(result.run).toBe(false);
      expect(result.reason).toBe("no_triggers_matched");
    });

    // ── Trigger: dropped_findings ────────────────────────────────────────
    it("triggers on dropped findings", () => {
      const findings = [{ severity: "high" }];
      const challenges = [{ finding_index: 0, suggested_action: "drop" }];
      const result = shouldRunDefense("auto", ["dropped_findings"], findings, challenges, []);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("dropped_findings");
    });

    it("does NOT trigger on dropped findings when trigger disabled", () => {
      const findings = [{ severity: "high" }];
      const challenges = [{ finding_index: 0, suggested_action: "drop" }];
      const result = shouldRunDefense("auto", ["critical_downgraded"], findings, challenges, []);
      expect(result.run).toBe(false);
    });

    // ── Trigger: critical_downgraded ─────────────────────────────────────
    it("triggers when critical finding is downgraded", () => {
      const findings = [{ severity: "critical" }];
      const challenges = [{ finding_index: 0, suggested_action: "downgrade" }];
      const result = shouldRunDefense("auto", ["critical_downgraded"], findings, challenges, []);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("critical_downgraded");
    });

    it("triggers when high finding is downgraded", () => {
      const findings = [{ severity: "high" }];
      const challenges = [{ finding_index: 0, suggested_action: "downgrade" }];
      const result = shouldRunDefense("auto", ["critical_downgraded"], findings, challenges, []);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("critical_downgraded");
    });

    it("does NOT trigger when medium finding is downgraded (only critical/high)", () => {
      const findings = [{ severity: "medium" }];
      const challenges = [{ finding_index: 0, suggested_action: "downgrade" }];
      const result = shouldRunDefense("auto", ["critical_downgraded"], findings, challenges, []);
      expect(result.run).toBe(false);
    });

    // ── Trigger: new_criticals ───────────────────────────────────────────
    it("triggers when advocate finds new critical risk", () => {
      const missedRisks = [{ severity: "critical", title: "path traversal" }];
      const result = shouldRunDefense("auto", ["new_criticals"], [], [], missedRisks);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("new_criticals");
    });

    it("triggers when advocate finds new high risk", () => {
      const missedRisks = [{ severity: "high", title: "auth bypass" }];
      const result = shouldRunDefense("auto", ["new_criticals"], [], [], missedRisks);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("new_criticals");
    });

    it("does NOT trigger when advocate only finds medium risks", () => {
      const missedRisks = [{ severity: "medium", title: "style issue" }];
      const result = shouldRunDefense("auto", ["new_criticals"], [], [], missedRisks);
      expect(result.run).toBe(false);
    });

    // ── Default triggers (no explicit config) ────────────────────────────
    it("uses all 3 default triggers when empty array passed", () => {
      const findings = [{ severity: "critical" }];
      const challenges = [{ finding_index: 0, suggested_action: "drop" }];
      // Empty triggers array → falls back to defaults
      const result = shouldRunDefense("auto", [], findings, challenges, []);
      expect(result.run).toBe(true);
      expect(result.reason).toBe("dropped_findings");
    });

    // ── First match wins ─────────────────────────────────────────────────
    it("returns first matching trigger (dropped_findings checked first)", () => {
      const findings = [{ severity: "critical" }];
      const challenges = [{ finding_index: 0, suggested_action: "drop" }];
      const missedRisks = [{ severity: "critical" }];
      const result = shouldRunDefense(
        "auto",
        ["dropped_findings", "critical_downgraded", "new_criticals"],
        findings, challenges, missedRisks
      );
      expect(result.run).toBe(true);
      expect(result.reason).toBe("dropped_findings"); // checked first
    });

    // ── Edge cases ───────────────────────────────────────────────────────
    it("handles null/undefined inputs gracefully", () => {
      const result = shouldRunDefense("auto", ["dropped_findings"], null, null, null);
      expect(result.run).toBe(false);
      expect(result.reason).toBe("no_triggers_matched");
    });

    it("handles empty findings and challenges", () => {
      const result = shouldRunDefense("auto", ["dropped_findings", "critical_downgraded", "new_criticals"], [], [], []);
      expect(result.run).toBe(false);
      expect(result.reason).toBe("no_triggers_matched");
    });
  });
});
