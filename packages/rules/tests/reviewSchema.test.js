// tests/reviewSchema.test.js
// Tests for review schema validation, JSON extraction cascade, and legacy conversion.

import {
  validateFinding,
  validateReviewReport,
  reportToLegacy,
  extractReviewJSON,
  buildReviewSystemPrompt,
  priorityToSeverity,
  severityToPriority,
  categoryToPass,
  VALID_PRIORITIES,
  VALID_CATEGORIES,
  VALID_CORRECTNESS,
} from "../src/reviewSchema.js";

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function validFinding(overrides = {}) {
  return {
    title: "SQL injection in user query",
    body: "The user input is concatenated directly into the SQL query without parameterization. An attacker could inject arbitrary SQL. Use parameterized queries instead.",
    priority: "P0",
    confidence: 0.95,
    category: "security",
    code_location: { file_path: "src/db.js", line: 42 },
    ...overrides,
  };
}

function validReport(overrides = {}) {
  return {
    findings: [validFinding()],
    overall_correctness: "patch is incorrect",
    overall_explanation: "The patch contains a SQL injection vulnerability that must be fixed before merging.",
    overall_confidence: 0.9,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

describe("reviewSchema constants", () => {
  test("VALID_PRIORITIES has 4 levels", () => {
    expect(VALID_PRIORITIES).toEqual(["P0", "P1", "P2", "P3"]);
  });

  test("VALID_CATEGORIES has 5 categories", () => {
    expect(VALID_CATEGORIES).toEqual(["bug", "security", "regression", "test_gap", "maintainability"]);
  });

  test("VALID_CORRECTNESS has 2 values", () => {
    expect(VALID_CORRECTNESS).toEqual(["patch is correct", "patch is incorrect"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Priority ↔ Severity mapping
// ════════════════════════════════════════════════════════════════════════════

describe("priorityToSeverity", () => {
  test("maps P0 to critical", () => expect(priorityToSeverity("P0")).toBe("critical"));
  test("maps P1 to high", () => expect(priorityToSeverity("P1")).toBe("high"));
  test("maps P2 to medium", () => expect(priorityToSeverity("P2")).toBe("medium"));
  test("maps P3 to low", () => expect(priorityToSeverity("P3")).toBe("low"));
  test("maps unknown to info", () => expect(priorityToSeverity("unknown")).toBe("info"));
});

describe("severityToPriority", () => {
  test("maps critical to P0", () => expect(severityToPriority("critical")).toBe("P0"));
  test("maps high to P1", () => expect(severityToPriority("high")).toBe("P1"));
  test("maps medium to P2", () => expect(severityToPriority("medium")).toBe("P2"));
  test("maps low to P3", () => expect(severityToPriority("low")).toBe("P3"));
});

describe("categoryToPass", () => {
  test("maps security to security", () => expect(categoryToPass("security")).toBe("security"));
  test("maps maintainability to architecture", () => expect(categoryToPass("maintainability")).toBe("architecture"));
  test("maps bug to logic", () => expect(categoryToPass("bug")).toBe("logic"));
  test("maps regression to logic", () => expect(categoryToPass("regression")).toBe("logic"));
  test("maps test_gap to logic", () => expect(categoryToPass("test_gap")).toBe("logic"));
});

// ════════════════════════════════════════════════════════════════════════════
// validateFinding
// ════════════════════════════════════════════════════════════════════════════

describe("validateFinding", () => {
  test("accepts a valid finding", () => {
    const result = validateFinding(validFinding());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects non-object", () => {
    expect(validateFinding(null).valid).toBe(false);
    expect(validateFinding("string").valid).toBe(false);
    expect(validateFinding([]).valid).toBe(false);
  });

  test("rejects missing title", () => {
    const result = validateFinding(validFinding({ title: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("title");
  });

  test("rejects empty title", () => {
    expect(validateFinding(validFinding({ title: "" })).valid).toBe(false);
  });

  test("rejects title over 140 chars", () => {
    expect(validateFinding(validFinding({ title: "x".repeat(141) })).valid).toBe(false);
  });

  test("rejects invalid priority", () => {
    expect(validateFinding(validFinding({ priority: "P5" })).valid).toBe(false);
  });

  test("rejects confidence out of range", () => {
    expect(validateFinding(validFinding({ confidence: 1.5 })).valid).toBe(false);
    expect(validateFinding(validFinding({ confidence: -0.1 })).valid).toBe(false);
    expect(validateFinding(validFinding({ confidence: "high" })).valid).toBe(false);
  });

  test("rejects invalid category", () => {
    expect(validateFinding(validFinding({ category: "typo" })).valid).toBe(false);
  });

  test("rejects missing code_location", () => {
    expect(validateFinding(validFinding({ code_location: undefined })).valid).toBe(false);
  });

  test("accepts null line in code_location", () => {
    expect(validateFinding(validFinding({ code_location: { file_path: "a.js", line: null } })).valid).toBe(true);
  });

  test("rejects string line in code_location", () => {
    expect(validateFinding(validFinding({ code_location: { file_path: "a.js", line: "42" } })).valid).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateReviewReport
// ════════════════════════════════════════════════════════════════════════════

describe("validateReviewReport", () => {
  test("accepts a valid report", () => {
    const result = validateReviewReport(validReport());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("accepts clean report with no findings", () => {
    const result = validateReviewReport(validReport({
      findings: [],
      overall_correctness: "patch is correct",
      overall_confidence: 0.95,
    }));
    expect(result.valid).toBe(true);
  });

  test("rejects non-object", () => {
    expect(validateReviewReport(null).valid).toBe(false);
    expect(validateReviewReport("text").valid).toBe(false);
  });

  test("rejects missing findings array", () => {
    const result = validateReviewReport(validReport({ findings: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(function (e) { return e.includes("findings"); })).toBe(true);
  });

  test("rejects invalid overall_correctness", () => {
    const result = validateReviewReport(validReport({ overall_correctness: "looks good" }));
    expect(result.valid).toBe(false);
  });

  test("rejects invalid overall_confidence", () => {
    expect(validateReviewReport(validReport({ overall_confidence: "high" })).valid).toBe(false);
    expect(validateReviewReport(validReport({ overall_confidence: 2.0 })).valid).toBe(false);
  });

  test("reports errors for invalid findings within the array", () => {
    const result = validateReviewReport(validReport({
      findings: [{ bad: "finding" }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(function (e) { return e.includes("findings[0]"); })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// reportToLegacy
// ════════════════════════════════════════════════════════════════════════════

describe("reportToLegacy", () => {
  test("converts a correct report to approved verdict", () => {
    const legacy = reportToLegacy(validReport({
      overall_correctness: "patch is correct",
      findings: [],
    }));
    expect(legacy.verdict).toBe("approved");
    expect(legacy.confidence).toBe("high");
    expect(legacy.findings).toEqual([]);
  });

  test("converts P0 findings to request_changes", () => {
    const legacy = reportToLegacy(validReport({
      findings: [validFinding({ priority: "P0" })],
      overall_correctness: "patch is incorrect",
    }));
    expect(legacy.verdict).toBe("request_changes");
    expect(legacy.findings[0].severity).toBe("critical");
  });

  test("converts single P1 finding to needs_discussion", () => {
    const legacy = reportToLegacy(validReport({
      findings: [validFinding({ priority: "P1" })],
      overall_correctness: "patch is incorrect",
    }));
    expect(legacy.verdict).toBe("needs_discussion");
    expect(legacy.findings[0].severity).toBe("high");
  });

  test("converts multiple P1 findings to request_changes", () => {
    const legacy = reportToLegacy(validReport({
      findings: [
        validFinding({ title: "Bug A", priority: "P1" }),
        validFinding({ title: "Bug B", priority: "P1" }),
      ],
      overall_correctness: "patch is incorrect",
    }));
    expect(legacy.verdict).toBe("request_changes");
  });

  test("maps code_location to file and line", () => {
    const legacy = reportToLegacy(validReport());
    expect(legacy.findings[0].file).toBe("src/db.js");
    expect(legacy.findings[0].line).toBe(42);
  });

  test("maps overall_confidence 0.3 to 'low'", () => {
    const legacy = reportToLegacy(validReport({ overall_confidence: 0.3 }));
    expect(legacy.confidence).toBe("low");
  });

  test("maps overall_confidence 0.6 to 'medium'", () => {
    const legacy = reportToLegacy(validReport({ overall_confidence: 0.6 }));
    expect(legacy.confidence).toBe("medium");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// extractReviewJSON
// ════════════════════════════════════════════════════════════════════════════

describe("extractReviewJSON", () => {
  const sampleReport = validReport();

  test("extracts direct JSON", () => {
    const input = JSON.stringify(sampleReport);
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.json.overall_correctness).toBe("patch is incorrect");
    expect(result.strategy).toBe("direct");
  });

  test("extracts from markdown fence", () => {
    const input = "```json\n" + JSON.stringify(sampleReport, null, 2) + "\n```";
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.strategy).toBe("fenced");
  });

  test("extracts from markdown fence without json label", () => {
    const input = "```\n" + JSON.stringify(sampleReport) + "\n```";
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.strategy).toBe("fenced");
  });

  test("extracts from text with surrounding commentary", () => {
    const input = "Here is my review:\n\n" + JSON.stringify(sampleReport) + "\n\nLet me know if you need anything else.";
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    // Trailing text after JSON causes direct parse to fail, falls back to brace extraction
    expect(["direct", "brace_extract"]).toContain(result.strategy);
  });

  test("extracts from brace-extracted text", () => {
    const input = "The review result is: " + JSON.stringify(sampleReport) + " and that is all.";
    // If direct parse fails (due to trailing text), brace extraction kicks in
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
  });

  test("extracts from JSONL stream", () => {
    const line1 = JSON.stringify({ type: "thinking", content: "analyzing..." });
    const line2 = JSON.stringify(sampleReport);
    const input = line1 + "\n" + line2;
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.strategy).toBe("jsonl");
  });

  test("extracts from multiple fences", () => {
    // First fence is valid JSON — will match on first fence (strategy: fenced)
    const input =
      "First thought:\n```json\n{\"thinking\": true}\n```\n\nFinal result:\n```json\n" +
      JSON.stringify(sampleReport) + "\n```";
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.strategy).toBe("fenced");
  });

  test("extracts from multiple fences when first is invalid", () => {
    // First fence has invalid JSON — falls through to multi-fence path
    const input =
      "Analysis:\n```\nnot json at all\n```\n\nResult:\n```json\n" +
      JSON.stringify(sampleReport) + "\n```";
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.json.overall_correctness).toBeTruthy();
    expect(result.strategy).toBe("fenced_multi");
  });

  test("extracts from nested structured_output", () => {
    const nested = { structured_output: sampleReport };
    const input = JSON.stringify(nested);
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.json.overall_correctness).toBe("patch is incorrect");
  });

  test("extracts from Anthropic SDK content array", () => {
    const sdkOutput = {
      content: [
        { type: "text", text: JSON.stringify(sampleReport) },
      ],
    };
    const input = JSON.stringify(sdkOutput);
    const result = extractReviewJSON(input);
    expect(result.json).toBeTruthy();
    expect(result.json.overall_correctness).toBe("patch is incorrect");
  });

  test("returns null for empty input", () => {
    expect(extractReviewJSON("").json).toBeNull();
    expect(extractReviewJSON(null).json).toBeNull();
    expect(extractReviewJSON(undefined).json).toBeNull();
  });

  test("returns null for non-JSON text", () => {
    const result = extractReviewJSON("This is just plain text with no JSON at all.");
    expect(result.json).toBeNull();
    expect(result.strategy).toBe("failed");
  });

  test("returns null for malformed JSON", () => {
    const result = extractReviewJSON("{ findings: [broken }");
    expect(result.json).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildReviewSystemPrompt
// ════════════════════════════════════════════════════════════════════════════

describe("buildReviewSystemPrompt", () => {
  test("includes the JSON schema", () => {
    const prompt = buildReviewSystemPrompt({ changedFiles: ["src/app.js"] });
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"overall_correctness"');
    expect(prompt).toContain('"overall_confidence"');
  });

  test("includes changed files list", () => {
    const prompt = buildReviewSystemPrompt({ changedFiles: ["src/app.js", "lib/db.js"] });
    expect(prompt).toContain("src/app.js");
    expect(prompt).toContain("lib/db.js");
    expect(prompt).toContain("REJECTED");
  });

  test("omits file scope when no files provided", () => {
    const prompt = buildReviewSystemPrompt({ changedFiles: [] });
    expect(prompt).not.toContain("REJECTED");
  });

  test("includes all priority levels", () => {
    const prompt = buildReviewSystemPrompt({ changedFiles: [] });
    expect(prompt).toContain("P0");
    expect(prompt).toContain("P3");
  });

  test("includes all categories", () => {
    const prompt = buildReviewSystemPrompt({ changedFiles: [] });
    expect(prompt).toContain("bug");
    expect(prompt).toContain("security");
    expect(prompt).toContain("test_gap");
  });
});
