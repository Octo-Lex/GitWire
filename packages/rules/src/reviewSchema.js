// @gitwire/rules — reviewSchema.js
// Strict JSON schema for AI review output, validation, and extraction.
//
// Adapted from prior autoreview work autoreview patterns:
//   - Enforce deterministic finding shape at the AI boundary
//   - Validate before persistence — reject malformed findings
//   - JSON extraction cascade handles all LLM output formats
//
// Finding schema:
//   {
//     title: string (1-140 chars),
//     body: string (1-2000 chars),
//     priority: "P0" | "P1" | "P2" | "P3",
//     confidence: number (0-1),
//     category: "bug" | "security" | "regression" | "test_gap" | "maintainability",
//     code_location: { file_path: string, line: number|null }
//   }
//
// Report schema:
//   {
//     findings: Finding[],
//     overall_correctness: "patch is correct" | "patch is incorrect",
//     overall_explanation: string (1-3000 chars),
//     overall_confidence: number (0-1)
//   }

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

export const VALID_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const VALID_CATEGORIES = ["bug", "security", "regression", "test_gap", "maintainability"];
export const VALID_CORRECTNESS = ["patch is correct", "patch is incorrect"];

/**
 * Map autoreview priority to GitWire severity.
 * P0 → critical, P1 → high, P2 → medium, P3 → low
 */
export function priorityToSeverity(priority) {
  switch (priority) {
    case "P0": return "critical";
    case "P1": return "high";
    case "P2": return "medium";
    case "P3": return "low";
    default:   return "info";
  }
}

/**
 * Map GitWire severity back to autoreview priority.
 */
export function severityToPriority(severity) {
  switch (severity) {
    case "critical": return "P0";
    case "high":     return "P1";
    case "medium":   return "P2";
    case "low":      return "P3";
    default:         return "P3";
  }
}

/**
 * Map autoreview category to GitWire review pass type.
 * security → security, bug → logic, maintainability → architecture,
 * regression/test_gap → logic
 */
export function categoryToPass(category) {
  switch (category) {
    case "security":       return "security";
    case "maintainability": return "architecture";
    case "bug":
    case "regression":
    case "test_gap":
    default:               return "logic";
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Schema Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate a single finding against the schema.
 * Returns { valid, errors[] }.
 *
 * @param {any} finding
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateFinding(finding) {
  const errors = [];

  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return { valid: false, errors: ["Finding must be an object"] };
  }

  // title: string, 1-140 chars
  if (typeof finding.title !== "string" || finding.title.length === 0) {
    errors.push("title must be a non-empty string");
  } else if (finding.title.length > 140) {
    errors.push("title must be <= 140 chars (got " + finding.title.length + ")");
  }

  // body: string, 1-2000 chars
  if (typeof finding.body !== "string" || finding.body.length === 0) {
    errors.push("body must be a non-empty string");
  } else if (finding.body.length > 2000) {
    errors.push("body must be <= 2000 chars (got " + finding.body.length + ")");
  }

  // priority: enum
  if (!VALID_PRIORITIES.includes(finding.priority)) {
    errors.push("priority must be one of: " + VALID_PRIORITIES.join(", ") + " (got " + JSON.stringify(finding.priority) + ")");
  }

  // confidence: number 0-1
  if (typeof finding.confidence !== "number" || finding.confidence < 0 || finding.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1 (got " + JSON.stringify(finding.confidence) + ")");
  }

  // category: enum
  if (!VALID_CATEGORIES.includes(finding.category)) {
    errors.push("category must be one of: " + VALID_CATEGORIES.join(", ") + " (got " + JSON.stringify(finding.category) + ")");
  }

  // code_location: { file_path: string, line: number|null }
  if (!finding.code_location || typeof finding.code_location !== "object") {
    errors.push("code_location must be an object with file_path and line");
  } else {
    if (typeof finding.code_location.file_path !== "string") {
      errors.push("code_location.file_path must be a string");
    }
    if (finding.code_location.line !== null && typeof finding.code_location.line !== "number") {
      errors.push("code_location.line must be a number or null");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full review report against the schema.
 * Returns { valid, report, errors[] }.
 *
 * @param {any} report
 * @returns {{ valid: boolean, report: object|null, errors: string[] }}
 */
export function validateReviewReport(report) {
  const errors = [];

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { valid: false, report: null, errors: ["Report must be an object"] };
  }

  // findings: array
  if (!Array.isArray(report.findings)) {
    errors.push("findings must be an array");
  } else {
    for (let i = 0; i < report.findings.length; i++) {
      const result = validateFinding(report.findings[i]);
      if (!result.valid) {
        errors.push("findings[" + i + "]: " + result.errors.join("; "));
      }
    }
  }

  // overall_correctness: enum
  if (!VALID_CORRECTNESS.includes(report.overall_correctness)) {
    errors.push("overall_correctness must be one of: " + VALID_CORRECTNESS.join(", ") + " (got " + JSON.stringify(report.overall_correctness) + ")");
  }

  // overall_explanation: string, 1-3000 chars
  if (typeof report.overall_explanation !== "string" || report.overall_explanation.length === 0) {
    errors.push("overall_explanation must be a non-empty string");
  } else if (report.overall_explanation.length > 3000) {
    errors.push("overall_explanation must be <= 3000 chars");
  }

  // overall_confidence: number 0-1
  if (typeof report.overall_confidence !== "number" || report.overall_confidence < 0 || report.overall_confidence > 1) {
    errors.push("overall_confidence must be a number between 0 and 1");
  }

  return { valid: errors.length === 0, report, errors };
}

/**
 * Convert a validated report + findings into the legacy GitWire format
 * that the DB and dashboard expect.
 *
 * Legacy finding shape:
 *   { category, severity, title, description, suggestion, file, line }
 *
 * @param {object} report - Validated review report
 * @returns {{ findings: object[], verdict: string, confidence: string, summary: string }}
 */
export function reportToLegacy(report) {
  const findings = (report.findings || []).map(function (f) {
    return {
      category:     f.category,
      severity:     priorityToSeverity(f.priority),
      title:        f.title,
      description:  f.body,
      suggestion:   "",  // autoreview pattern: body contains the fix suggestion
      file:         f.code_location?.file_path || null,
      line:         f.code_location?.line || null,
      confidence:   f.confidence,
    };
  });

  const isCorrect = report.overall_correctness === "patch is correct";
  const confidence = report.overall_confidence;

  // Map to existing verdicts
  let verdict;
  if (isCorrect) {
    verdict = "approved";
  } else {
    const hasP0 = findings.some(function (f) { return f.severity === "critical"; });
    const hasP1 = findings.some(function (f) { return f.severity === "high"; });
    if (hasP0 || (hasP1 && findings.filter(function (f) { return f.severity === "high"; }).length >= 2)) {
      verdict = "request_changes";
    } else {
      verdict = "needs_discussion";
    }
  }

  const confidenceLabel = confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";

  return {
    findings,
    verdict,
    confidence: confidenceLabel,
    summary: report.overall_explanation,
    overallCorrectness: report.overall_correctness,
    overallConfidence: confidence,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// JSON Extraction Cascade
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract a JSON review report from LLM output text.
 * Tries multiple extraction strategies in order.
 *
 * Strategies:
 *   1. Direct JSON.parse
 *   2. Strip markdown fences (```json ... ```)
 *   3. Extract first {...} block at top level
 *   4. JSONL stream parsing (one JSON object per line)
 *   5. Nested structured_output/result unwrapping
 *
 * @param {string} text - Raw LLM output
 * @returns {{ json: object|null, strategy: string }}
 */
export function extractReviewJSON(text) {
  if (!text || typeof text !== "string") {
    return { json: null, strategy: "empty_input" };
  }

  const trimmed = text.trim();

  // Strategy 1: Direct parse
  try {
    const parsed = JSON.parse(trimmed);
    return { json: unwrapNested(parsed), strategy: "direct" };
  } catch (_e) {
    // continue
  }

  // Strategy 2: Strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      return { json: unwrapNested(parsed), strategy: "fenced" };
    } catch (_e) {
      // continue
    }
  }

  // Strategy 2b: Multiple fences — try last one (often the actual result)
  const allFences = [...trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)];
  if (allFences.length > 1) {
    for (let i = allFences.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(allFences[i][1].trim());
        return { json: unwrapNested(parsed), strategy: "fenced_multi" };
      } catch (_e) {
        // continue
      }
    }
  }

  // Strategy 3: Extract first {...} block at top level
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      const candidate = trimmed.slice(braceStart, braceEnd + 1);
      const parsed = JSON.parse(candidate);
      return { json: unwrapNested(parsed), strategy: "brace_extract" };
    } catch (_e) {
      // continue
    }
  }

  // Strategy 4: JSONL stream — find lines that are valid JSON objects
  const lines = trimmed.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        return { json: unwrapNested(parsed), strategy: "jsonl" };
      }
    } catch (_e) {
      // continue
    }
  }

  // Strategy 5: Try to find JSON embedded in text (common with Claude)
  // Look for patterns like: {"findings": [...], "overall_correctness": ...}
  const jsonPattern = /\{"findings"\s*:\s*\[[\s\S]*?\]\s*,\s*"overall_correctness"/;
  const jsonMatch = trimmed.match(jsonPattern);
  if (jsonMatch) {
    const startIdx = trimmed.indexOf(jsonMatch[0]);
    const subStr = trimmed.slice(startIdx);
    const endBrace = findMatchingBrace(subStr);
    if (endBrace > 0) {
      try {
        const parsed = JSON.parse(subStr.slice(0, endBrace + 1));
        return { json: parsed, strategy: "pattern_match" };
      } catch (_e) {
        // continue
      }
    }
  }

  return { json: null, strategy: "failed" };
}

/**
 * Unwrap nested structures from streaming/SDK wrappers.
 * Handles: { structured_output: {...} }, { result: {...} }, { content: [{text: "..."}] }
 */
function unwrapNested(obj) {
  if (!obj || typeof obj !== "object") return obj;

  // Claude streaming format: { type: "text", text: "..." }
  if (obj.type === "text" && typeof obj.text === "string") {
    try {
      return JSON.parse(obj.text);
    } catch (_e) {
      return obj;
    }
  }

  // SDK wrapper: { structured_output: {...} }
  if (obj.structured_output && typeof obj.structured_output === "object") {
    return obj.structured_output;
  }

  // SDK wrapper: { result: {...} }
  if (obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)) {
    return obj.result;
  }

  // Anthropic SDK: { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(obj.content) && obj.content.length > 0) {
    const textBlock = obj.content.find(function (b) { return b.type === "text"; });
    if (textBlock && typeof textBlock.text === "string") {
      try {
        return JSON.parse(textBlock.text);
      } catch (_e) {
        return obj;
      }
    }
  }

  return obj;
}

/**
 * Find the matching closing brace for a string starting with '{'.
 */
function findMatchingBrace(str) {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Build the system prompt that enforces the review schema.
 * This is the "contract" shown to the LLM.
 *
 * @param {object} opts
 * @param {string[]} opts.changedFiles - List of files in scope
 * @param {boolean} opts.includeSecurity - Include security review focus
 * @param {boolean} opts.includeArchitecture - Include architecture review focus
 * @returns {string} system prompt
 */
export function buildReviewSystemPrompt(opts) {
  var categoryList = VALID_CATEGORIES.join(", ");
  var priorityList = VALID_PRIORITIES.join(", ");

  var fileScopeNote = "";
  if (opts.changedFiles && opts.changedFiles.length > 0) {
    fileScopeNote = "\n\nIMPORTANT: Only report findings for these changed files:\n" +
      opts.changedFiles.map(function (f) { return "  - " + f; }).join("\n") +
      "\nFindings about files NOT in this list will be REJECTED.";
  }

  return "You are a senior code reviewer. You MUST return a single JSON object matching this exact schema:\n" +
    "\n" +
    "{\n" +
    '  "findings": [\n' +
    "    {\n" +
    '      "title": "<concise title, 1-140 chars>",\n' +
    '      "body": "<detailed explanation with fix suggestion, 1-2000 chars>",\n' +
    '      "priority": "<' + priorityList + '>",\n' +
    '      "confidence": <0.0-1.0>,\n' +
    '      "category": "<' + categoryList + '>",\n' +
    '      "code_location": {\n' +
    '        "file_path": "<filename from the diff, or null>",\n' +
    '        "line": <line number or null>\n' +
    "      }\n" +
    "    }\n" +
    "  ],\n" +
    '  "overall_correctness": "<patch is correct | patch is incorrect>",\n' +
    '  "overall_explanation": "<1-3000 char summary of your assessment>",\n' +
    '  "overall_confidence": <0.0-1.0>\n' +
    "}\n" +
    "\n" +
    "Rules:\n" +
    "- Return ONLY valid JSON. No markdown fences, no commentary, no explanation outside the JSON.\n" +
    "- Maximum 10 findings. Prioritise highest priority issues.\n" +
    "- P0: security vulnerabilities, data loss risks, crashes, RCE\n" +
    "- P1: significant bugs, major performance issues\n" +
    "- P2: correctness issues unlikely to cause immediate breakage\n" +
    "- P3: style, naming, minor improvements\n" +
    "- Do NOT invent or speculate about issues. Only report concrete problems visible in the diff.\n" +
    "- If the patch looks clean, return empty findings array with overall_correctness = \"patch is correct\".\n" +
    "- confidence reflects how certain you are about EACH finding (0.9 = very sure, 0.3 = low certainty).\n" +
    "- overall_confidence reflects how certain you are about the overall verdict.\n" +
    "- Do NOT suggest broad rewrites or architectural changes unless they fix a concrete bug.\n" +
    "- Treat low-confidence speculative risks as P3 at most, or omit them entirely." +
    fileScopeNote;
}
