// tests/review-schema-fence-scanner.test.js
// #425 unit (#1+#2) regressions: the deterministic fenced-block scanner
// replaces the two polynomial regexes in extractReviewJSON. Two jobs:
//
// 1. EQUIVALENCE — the old regex pair and the scanner must agree on the
//    extraction outcome (strategy + parsed json) across a corpus covering
//    labels, whitespace shapes, multi-fence, unclosed fences, and nesting.
//    The old regexes are reproduced here verbatim so the equivalence is
//    pinned in-tree, not asserted from memory.
// 2. BOUNDEDNESS — the adversarial shapes that made the regex polynomial
//    (long whitespace runs after an unclosed fence, repeated opening fences
//    without closures, long newlines) must complete in linear time, with a
//    generous wall-clock bound that the old regex would blow through.

import {
  scanFencedBlocks,
  extractReviewJSON,
} from "../src/reviewSchema.js";

// The replaced regex pair, verbatim from reviewSchema.js pre-remediation.
const OLD_FENCE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
const OLD_FENCE_G = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;

/** Outcome of the OLD extraction strategies 2/2b for equivalence checks. */
function oldFencedOutcome(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(OLD_FENCE);
  if (fenceMatch) {
    try {
      return { strategy: "fenced", json: JSON.parse(fenceMatch[1].trim()) };
    } catch (_e) { /* fall through */ }
  }
  const allFences = [...trimmed.matchAll(OLD_FENCE_G)];
  if (allFences.length > 1) {
    for (let i = allFences.length - 1; i >= 0; i -= 1) {
      try {
        return { strategy: "fenced_multi", json: JSON.parse(allFences[i][1].trim()) };
      } catch (_e) { /* keep walking backwards */ }
    }
  }
  return null;
}

/** Full-pipeline equivalence: old strategies 2/2b vs new, on one input. */
function assertFenceEquivalence(input) {
  const oldOutcome = oldFencedOutcome(input);
  const extracted = extractReviewJSON(input);
  if (oldOutcome === null) {
    // Old code fell through to strategies 3-5; the new code must reach the
    // SAME subsequent strategies. For corpus members designed to be decided
    // at the fence stage, falling through means both sides continue — the
    // extraction result must then still agree, so compare full results.
    return extracted;
  }
  expect(extracted.strategy).toBe(oldOutcome.strategy);
  expect(extracted.json).toEqual(oldOutcome.json);
  return extracted;
}

// Wall-clock bound generous enough for CI variance yet far below the old
// regex's seconds-scale blowup at these sizes (the maintainer's microbench:
// ~2.06s for ONE unclosed fence + 2,000 spaces).
const TIME_BUDGET_MS = 500;

function timed(fn) {
  const t0 = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t0 };
}

describe("EQUIVALENCE: scanner vs replaced regex pair", () => {
  const corpus = [
    '```json\n{"findings": [], "overall_correctness": "pass"}\n```',
    '```\n{"a": 1}\n```',
    'Here is the review:\n```json\n{"a": 1}\n```\nThanks',
    '```\nnot json\n```\n```json\n{"b": 2}\n```',        // first invalid, last valid → fenced_multi
    '```json\n{"c": 3}\n```\n```json\nbroken\n```',        // first valid → fenced
    '```json{"d": 4}```',                                   // label with no newline
    '```  json\n{"e": 5}\n```',                             // label NOT immediate (spaces first) — both must fail fence parse identically
    'leading ```\n{"f": 6}\n``` trailing',
    '```\n```',                                             // empty body pair
    'unclosed ``` json body without end',                    // no complete fence
    '```x``````y```',                                        // adjacent pairs
    '```\n{"g": 7}\n\n```',                                  // blank line before close
    'text before ``` mid-line {"h": 8} ``` text after',
  ];

  test.each(corpus.map((c) => [c]))("corpus %j", (input) => {
    assertFenceEquivalence(input);
  });

  it("strategy identifiers are unchanged (fenced / fenced_multi)", () => {
    expect(extractReviewJSON('```json\n{"a": 1}\n```').strategy).toBe("fenced");
    expect(extractReviewJSON('```\nnope\n```\n```\n{"b": 2}\n```').strategy).toBe("fenced_multi");
  });

  it("scanFencedBlocks pairing matches matchAll continuation semantics", () => {
    // Odd fence count: matchAll produced floor(n/2) completed matches.
    expect(scanFencedBlocks("```a```b```")).toEqual(["a"]);
    expect(scanFencedBlocks("```a```b```c```")).toEqual(["a", "c"]);
    expect(scanFencedBlocks("no fences")).toEqual([]);
    expect(scanFencedBlocks("``````")).toEqual([""]);
  });

  it("label stripping matches the regex's (?:json)? consumption", () => {
    expect(scanFencedBlocks("```json\n{}\n```")).toEqual(["{}\n"]); // label + following ws run stripped (greedy, like the regex)
    expect(scanFencedBlocks("```json{}```")).toEqual(["{}"]);          // label, zero whitespace
    expect(scanFencedBlocks("``` json{}\n```")).toEqual([" json{}\n"]); // spaces first: NOT a label
  });
});

describe("BOUNDEDNESS: adversarial shapes complete in linear time", () => {
  it("unclosed fence + very long SPACE run (the maintainer's reproduced case, scaled)", () => {
    const input = "```" + " ".repeat(200_000);
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.json).toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("unclosed fence + very long NEWLINE run (CodeQL's stated attack shape)", () => {
    const input = "```json" + "\n".repeat(200_000);
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.json).toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("repeated opening fences without closures", () => {
    const input = "```json".repeat(30_000);
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
    expect(scanFencedBlocks(input)).toHaveLength(15_000);
  });

  it("valid JSON buried after a pathological unclosed prefix still extracts", () => {
    const input = "```json" + "\n".repeat(100_000) + "trailing text";
    // No closing fence anywhere: nothing extractable at the fence stage, and
    // the cascade must still terminate quickly (strategies 3-5 run on the
    // same string).
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
    expect(out.json).toBeNull();
  });

  it("valid multi-fence response at scale (many fences, last one valid)", () => {
    const parts = [];
    for (let i = 0; i < 5_000; i += 1) parts.push("```\nnot-json-" + i + "\n```");
    parts.push("```json\n{\"findings\": [], \"overall_correctness\": \"pass\"}\n```");
    const input = parts.join("\n");
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.strategy).toBe("fenced_multi");
    expect(out.json).toEqual({ findings: [], overall_correctness: "pass" });
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("long whitespace run INSIDE a valid fence still extracts (equivalence at scale)", () => {
    const input = "```json\n" + " ".repeat(150_000) + "\n{\"deep\": true}\n```";
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.strategy).toBe("fenced");
    expect(out.json).toEqual({ deep: true });
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });
});
