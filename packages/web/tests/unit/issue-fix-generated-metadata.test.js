// D0-02 — generated issue-fix metadata is untrusted and must be safe before GitHub writes.

import { describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("@gitwire/rules", () => ({
  isFixPathBlocked: jest.fn(),
  isDryRun: jest.fn(),
  meetsConfidence: jest.fn(),
  getMinFixConfidence: jest.fn(),
  scoreFixRisk: jest.fn(),
}));

jest.unstable_mockModule("../../src/services/actionStateMachine.js", () => ({
  propose: jest.fn(),
  approve: jest.fn(),
  execute: jest.fn(),
  cancel: jest.fn(),
}));

jest.unstable_mockModule("../../src/workers/issueFix/helpers.js", () => ({
  upsertFixAttempt: jest.fn(),
  postIssueComment: jest.fn(),
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { validatePatchCandidates } = await import("../../src/workers/issueFix/validate.js");

const original = {
  path: "src/a.js",
  content: "const a = 1;\n",
  sha: "blob-a",
};

function validate(metadata = {}) {
  return validatePatchCandidates([
    {
      path: "src/a.js",
      fixed_content: "const a = 2;\n",
      ...metadata,
    },
  ], [original]);
}

describe("issue-fix generated metadata validation", () => {
  it("accepts absent metadata and bounded single-line strings", () => {
    expect(validate()).toEqual({ valid: true, reasons: [] });
    expect(validate({
      commit_message: "fix(core): correct value",
      explanation: "Correct the configured value.",
    })).toEqual({ valid: true, reasons: [] });
  });

  it("rejects non-string commit_message and explanation values", () => {
    const result = validate({
      commit_message: { text: "fix(core): value" },
      explanation: 42,
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "src/a.js: commit_message must be a string",
      "src/a.js: explanation must be a string",
    ]));
  });

  it("rejects multiline/control metadata so model text cannot inject commit trailers", () => {
    const result = validate({
      commit_message: "fix(core): value\nSigned-off-by: Someone <someone@example.com>",
      explanation: "Changed value\u2028with a hidden line separator",
    });

    expect(result.valid).toBe(false);
    expect(result.reasons.join(" ")).toContain("commit_message must be a single-line string without control characters");
    expect(result.reasons.join(" ")).toContain("explanation must be a single-line string without control characters");
  });

  it("rejects unbounded metadata before submission", () => {
    const result = validate({
      commit_message: "x".repeat(121),
      explanation: "y".repeat(501),
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "src/a.js: commit_message exceeds 120 characters",
      "src/a.js: explanation exceeds 500 characters",
    ]));
  });

  it("rejects padding and measures the raw payload instead of only trimmed text", () => {
    const result = validate({
      commit_message: " ".repeat(121) + "x",
      explanation: " " + "y".repeat(500),
    });

    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "src/a.js: commit_message exceeds 120 characters",
      "src/a.js: commit_message must not contain leading or trailing whitespace",
      "src/a.js: explanation exceeds 500 characters",
      "src/a.js: explanation must not contain leading or trailing whitespace",
    ]));
  });
});
