// tests/unit/service-adversarial-review.test.js
// Tests for the Devil's Advocate adversarial review phase.
//
// Tests: refineFindings() logic, runAdversarialChallenge() prompt structure,
//        parseChallengeResponse(), edge cases.

import { jest } from "@jest/globals";

// Mock config before importing anything that uses it
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    anthropic: { apiKey: "test-key", baseURL: "https://test.api" },
  },
}));

// Mock logger
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Anthropic SDK
const mockCreate = jest.fn();
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: mockCreate };
    }
  },
}));

// Mock extractReviewJSON from rules
await jest.unstable_mockModule("@gitwire/rules", () => ({
  extractReviewJSON: jest.fn((text) => {
    try {
      return { json: JSON.parse(text) };
    } catch (_e) {
      return { json: null };
    }
  }),
}));

const { runAdversarialChallenge, refineFindings } = await import(
  "../../src/services/adversarialReview.js"
);

// ────────────────────────────────────────────────────────────────────────────────
// refineFindings() — pure logic tests
// ────────────────────────────────────────────────────────────────────────────────

describe("refineFindings", () => {
  const baseFindings = [
    { title: "SQL injection", severity: "critical", description: "User input in query", confidence: 0.9, file: "db.js", line: 42 },
    { title: "Missing test", severity: "medium", description: "No test for edge case", confidence: 0.7 },
    { title: "Typo in comment", severity: "low", description: "Misspelled word", confidence: 0.6 },
  ];

  test("keeps all findings when challenges say keep", () => {
    const challenges = [
      { finding_index: 0, disproven: false, reason: "Real vulnerability", suggested_action: "keep", new_severity: null },
      { finding_index: 1, disproven: false, reason: "Genuine gap", suggested_action: "keep", new_severity: null },
      { finding_index: 2, disproven: false, reason: "Minor but valid", suggested_action: "keep", new_severity: null },
    ];

    const result = refineFindings(baseFindings, challenges, []);

    expect(result.refined).toHaveLength(3);
    expect(result.dropped).toHaveLength(0);
    expect(result.upheld).toHaveLength(3);
    // Confidence boosted by 0.1
    expect(result.upheld[0].confidence).toBeCloseTo(1.0); // was 0.9, capped at 1.0
    expect(result.upheld[1].confidence).toBeCloseTo(0.8); // was 0.7
  });

  test("drops findings when disproven", () => {
    const challenges = [
      { finding_index: 0, disproven: true, reason: "False positive: input is sanitized upstream", suggested_action: "drop", new_severity: null },
      { finding_index: 1, disproven: false, reason: "Valid", suggested_action: "keep", new_severity: null },
      { finding_index: 2, disproven: true, reason: "Not in scope", suggested_action: "drop", new_severity: null },
    ];

    const result = refineFindings(baseFindings, challenges, []);

    expect(result.refined).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0].adversarial_status).toBe("dropped");
    expect(result.dropped[0].title).toBe("SQL injection");
  });

  test("downgrades severity", () => {
    const challenges = [
      { finding_index: 0, disproven: false, reason: "Overstated: uses parameterized query", suggested_action: "downgrade", new_severity: "medium" },
      { finding_index: 1, disproven: false, reason: "Valid", suggested_action: "keep", new_severity: null },
      { finding_index: 2, disproven: false, reason: "Valid", suggested_action: "keep", new_severity: null },
    ];

    const result = refineFindings(baseFindings, challenges, []);

    expect(result.refined).toHaveLength(3);
    // First finding should be downgraded from critical to medium
    const downgraded = result.refined.find((f) => f.adversarial_status === "downgraded");
    expect(downgraded).toBeDefined();
    expect(downgraded.severity).toBe("medium");
    expect(downgraded.confidence).toBeCloseTo(0.7); // 0.9 - 0.2
  });

  test("never upgrades severity on downgrade", () => {
    const findings = [
      { title: "Low issue", severity: "low", description: "test", confidence: 0.5 },
    ];
    // Challenge tries to upgrade from low to critical — should be ignored
    const challenges = [
      { finding_index: 0, disproven: false, reason: "Worse than thought", suggested_action: "downgrade", new_severity: "critical" },
    ];

    const result = refineFindings(findings, challenges, []);

    // Severity should stay at low (downgrade can't go up)
    expect(result.refined[0].severity).toBe("low");
  });

  test("adds missed risks as new findings", () => {
    const missedRisks = [
      { title: "Race condition", severity: "high", category: "bug", reason: "Concurrent access without lock" },
      { title: "Missing auth check", severity: "critical", category: "security", reason: "Endpoint has no auth middleware" },
    ];

    const result = refineFindings(baseFindings, [], missedRisks);

    expect(result.refined).toHaveLength(5); // 3 original + 2 missed
    expect(result.missed).toHaveLength(2);
    expect(result.missed[0].adversarial_status).toBe("missed_risk");
    expect(result.missed[0].title).toBe("Race condition");
    expect(result.missed[1].severity).toBe("critical");
  });

  test("handles empty findings", () => {
    const result = refineFindings([], [], []);
    expect(result.refined).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
    expect(result.upheld).toHaveLength(0);
  });

  test("handles missing challenge for a finding", () => {
    const findings = [
      { title: "Issue A", severity: "high", description: "test", confidence: 0.8 },
    ];
    // No challenge for index 0
    const result = refineFindings(findings, [], []);

    expect(result.refined).toHaveLength(1);
    expect(result.refined[0].adversarial_status).toBe("upheld");
  });

  test("drops + downgrades + keeps + missed in one pass", () => {
    const challenges = [
      { finding_index: 0, disproven: true, reason: "False positive", suggested_action: "drop", new_severity: null },
      { finding_index: 1, disproven: false, reason: "Overstated", suggested_action: "downgrade", new_severity: "low" },
      { finding_index: 2, disproven: false, reason: "Valid", suggested_action: "keep", new_severity: null },
    ];
    const missedRisks = [
      { title: "Hidden bug", severity: "high", category: "bug", reason: "Off-by-one" },
    ];

    const result = refineFindings(baseFindings, challenges, missedRisks);

    expect(result.dropped).toHaveLength(1);
    expect(result.refined).toHaveLength(3); // 1 downgraded + 1 kept + 1 missed
    expect(result.missed).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// runAdversarialChallenge() — API call tests
// ────────────────────────────────────────────────────────────────────────────────

describe("runAdversarialChallenge", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  test("returns challenges from API response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        challenges: [
          { finding_index: 0, disproven: false, reason: "Looks legit", suggested_action: "keep", new_severity: null },
          { finding_index: 1, disproven: true, reason: "False positive", suggested_action: "drop", new_severity: null },
        ],
        missed_risks: [],
      })}],
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    const result = await runAdversarialChallenge(
      [{ title: "Bug", severity: "high", description: "desc" }],
      { prTitle: "Fix auth", repoName: "org/repo" }
    );

    expect(result.challenges).toHaveLength(2);
    expect(result.challenges[1].suggested_action).toBe("drop");
    expect(result.tokensUsed).toBe(700);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test("returns keep-all on empty findings", async () => {
    const result = await runAdversarialChallenge([], { prTitle: "Empty" });
    expect(result.challenges).toHaveLength(0);
    expect(result.tokensUsed).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("gracefully handles API error", async () => {
    mockCreate.mockRejectedValue(new Error("API rate limit"));

    const result = await runAdversarialChallenge(
      [{ title: "Bug", severity: "high", description: "desc" }],
      { prTitle: "Fix" }
    );

    // Should return keep-all fallback
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].suggested_action).toBe("keep");
    expect(result.tokensUsed).toBe(0);
  });

  test("handles malformed JSON response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "I cannot provide JSON because this is a test" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = await runAdversarialChallenge(
      [{ title: "Bug", severity: "high", description: "desc" }],
      { prTitle: "Fix" }
    );

    // Fallback: keep all findings
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0].suggested_action).toBe("keep");
  });

  test("uses custom model when provided", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        challenges: [],
        missed_risks: [],
      })}],
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    await runAdversarialChallenge(
      [{ title: "Bug", severity: "high", description: "desc" }],
      { prTitle: "Fix", model: "claude-sonnet-4-20250514" }
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-20250514" })
    );
  });

  test("finds missed risks in response", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({
        challenges: [
          { finding_index: 0, disproven: false, reason: "Valid", suggested_action: "keep", new_severity: null },
        ],
        missed_risks: [
          { title: "Memory leak", severity: "high", category: "bug", reason: "Connection never closed" },
        ],
      })}],
      usage: { input_tokens: 500, output_tokens: 200 },
    });

    const result = await runAdversarialChallenge(
      [{ title: "Bug", severity: "high", description: "desc" }],
      { prTitle: "Fix" }
    );

    expect(result.missedRisks).toHaveLength(1);
    expect(result.missedRisks[0].title).toBe("Memory leak");
  });
});
