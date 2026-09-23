// D0-02 — AI issue analysis is untrusted structured input.

import { describe, expect, it, jest } from "@jest/globals";

const mockCreate = jest.fn();

jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    constructor() {
      this.messages = { create: mockCreate };
    }
  },
}));
jest.unstable_mockModule("../../config/index.js", () => ({
  config: { anthropic: { apiKey: "test-key", baseURL: "" } },
}));
jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: jest.fn(),
  postIssueComment: jest.fn(),
  stripCodeFences: (value) => value,
  extractJSON: (value) => JSON.parse(value),
}));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { normalizeIssueFixAnalysis } = await import("../../src/workers/issueFix/analyze.js");

const valid = {
  complexity: "simple",
  relevant_files: ["src/a.js", "src/b.js"],
  explanation: " clear bounded fix ",
  fix_strategy: " change the guard ",
};

describe("normalizeIssueFixAnalysis", () => {
  it("accepts and normalizes the bounded analysis contract", () => {
    expect(normalizeIssueFixAnalysis(valid)).toEqual({
      complexity: "simple",
      relevant_files: ["src/a.js", "src/b.js"],
      explanation: "clear bounded fix",
      fix_strategy: "change the guard",
    });
  });

  it.each([
    [null, "null"],
    [{ ...valid, complexity: "unknown" }, "unknown complexity"],
    [{ ...valid, relevant_files: "src/a.js" }, "non-array files"],
    [{ ...valid, relevant_files: [] }, "empty files"],
    [{ ...valid, relevant_files: Array.from({ length: 11 }, (_, i) => `src/${i}.js`) }, "too many files"],
    [{ ...valid, relevant_files: ["../secret"] }, "traversal path"],
    [{ ...valid, relevant_files: ["/etc/passwd"] }, "absolute path"],
    [{ ...valid, explanation: "" }, "empty explanation"],
    [{ ...valid, fix_strategy: 7 }, "non-string strategy"],
  ])("rejects invalid analysis input", (value) => {
    expect(normalizeIssueFixAnalysis(value)).toBeNull();
  });

  it("deduplicates relevant files without changing their order", () => {
    expect(normalizeIssueFixAnalysis({
      ...valid,
      relevant_files: ["src/a.js", "src/a.js", "src/b.js"],
    }).relevant_files).toEqual(["src/a.js", "src/b.js"]);
  });
});
