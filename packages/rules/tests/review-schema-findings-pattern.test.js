// tests/review-schema-findings-pattern.test.js
// #425 unit (#3) regressions: the bounded findings-pattern scan replaces
// the regex  /\{"findings"\s*:\s*\[[\s\S]*?\]\s*,\s*"overall_correctness"/
// whose per-index prefix retry and per-candidate suffix rescan made it
// quadratic on repeated incomplete prefixes. Two jobs, mirroring the fence
// scanner suite:
//
// 1. EQUIVALENCE — the old regex (reproduced verbatim) driving the old
//    strategy-5 flow (match → slice from match start → brace balance →
//    JSON.parse) and the new scan driving the same flow must agree on
//    whether strategy 5 fires, across a corpus covering whitespace shapes,
//    first-candidate-completes-via-later-text, unparseable tails, and
//    no-match fall-through. Strategy 5 is the LAST resort: corpus members
//    that assert pattern_match are built to fail strategies 1-4 first.
// 2. BOUNDEDNESS — the repeated-incomplete-prefix attack input completes in
//    linear time under a generous wall-clock bound.

import { extractReviewJSON } from "../src/reviewSchema.js";

// The replaced regex, verbatim.
const OLD_PATTERN = /\{"findings"\s*:\s*\[[\s\S]*?\]\s*,\s*"overall_correctness"/;

// findMatchingBrace, replicated from reviewSchema.js (unexported there).
function findMatchingBrace(str) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { if (inString) escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** TRUE old strategy-5 outcome: fires (and parses) or not. */
function oldStrategyFiveFires(text) {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(OLD_PATTERN);
  if (!jsonMatch) return false;
  const startIdx = trimmed.indexOf(jsonMatch[0]);
  const subStr = trimmed.slice(startIdx);
  const endBrace = findMatchingBrace(subStr);
  if (endBrace <= 0) return false;
  try {
    JSON.parse(subStr.slice(0, endBrace + 1));
    return true;
  } catch (_e) {
    return false;
  }
}

// Wall-clock bound generous for CI variance, far below the old regex's
// blowup at these sizes.
const TIME_BUDGET_MS = 500;

function timed(fn) {
  const t0 = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t0 };
}

// Strategy 5 fires only when strategies 1-4 all failed: embed the pattern
// on ONE line with surrounding text (brace_extract spans to the LAST brace
// and fails; the line is not valid JSONL).
const FIRING = 'intro {"findings": [], "overall_correctness": "pass"} x { trailing }'; // trailing broken brace defeats brace_extract/jsonl so strategy 5 decides
const FIRING_WS = 'x { "findings"  :  [ {"id": 1} ] ,  "overall_correctness" : "pass" } y { tail }';

describe("EQUIVALENCE: bounded scan vs replaced regex (full old flow)", () => {
  const corpus = [
    FIRING,
    FIRING_WS,
    'first {"findings": [no completion intro second {"findings": [], "overall_correctness": "pass"} tail', // first candidate completes via later text (lazy body)
    '{"findings" : [ ] , "overall_correctness"}',                       // shape completes, JSON invalid → both must not fire
    '{"findings": not-an-array, "overall_correctness": "x"}',           // ':' then no '[' → no match → neither fires
    'prefix text with no pattern at all',                                // neither fires
    'noise {"findings": [], "overall_correctness": "pass"} trailing {"findings": [] and no tail x }', // later partial candidate; trailing x } defeats brace_extract
  ];

  test.each(corpus.map((c) => [c]))("corpus %j", (input) => {
    const oldFires = oldStrategyFiveFires(input);
    const extracted = extractReviewJSON(input);
    if (oldFires) {
      expect(extracted.strategy).toBe("pattern_match");
    } else {
      expect(extracted.strategy).not.toBe("pattern_match");
    }
  });

  it("fires with strategy identifier preserved: pattern_match", () => {
    expect(extractReviewJSON(FIRING).strategy).toBe("pattern_match");
    expect(extractReviewJSON(FIRING).json).toEqual({ findings: [], overall_correctness: "pass" });
  });

  it("whitespace-shape tolerance matches the regex (tabs/spacing between tokens)", () => {
    // Single line with tab spreads: defeats jsonl (one unparseable line) and
    // brace_extract (trailing broken brace), so strategy 5 decides. A
    // multi-line spread is decided by the untouched jsonl strategy instead.
    const spread = 'a {"findings"\t:\t[\t{"id": 1}\t]\t,\t"overall_correctness"\t:\t"pass"\t} b { tail }';
    expect(extractReviewJSON(spread).strategy).toBe("pattern_match");
    expect(oldStrategyFiveFires(spread)).toBe(true);
  });

  it("first candidate completing wins even when a later candidate exists", () => {
    const input = FIRING + " mid " + FIRING;
    expect(extractReviewJSON(input).strategy).toBe("pattern_match");
    expect(oldStrategyFiveFires(input)).toBe(true);
  });
});

describe("BOUNDEDNESS: repeated incomplete prefixes (the attack shape)", () => {
  it("30,000 repeated {\"findings\":[ prefixes with no completion — linear time, falls through", () => {
    const input = '{"findings":['.repeat(30_000);
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.json).toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("30,000 prefixes WITH a completion: scan matches (old regex matches too) but brace balance cannot close 30k opens — both flows fall through, bounded", () => {
    const input = "lead " + '{"findings":['.repeat(30_000) + "], \"overall_correctness\": \"pass\"}";
    const { out, ms } = timed(() => extractReviewJSON(input));
    // OLD flow on this input: regex matches at candidate 1, the same slice
    // cannot brace-balance (30k opens, 1 close), strategy 5 falls through —
    // identical terminal result here.
    expect(OLD_PATTERN.test(input)).toBe(true);   // the shape DOES complete
    expect(out.json).toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("single candidate completing at scale resolves pattern_match", () => {
    const input = "lead " + '{"findings":[ {"id":1} ], "overall_correctness": "pass"} tail '.repeat(1_000) + "{ broken";
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.strategy).toBe("pattern_match");
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("repeated prefixes with a tail literal but no valid close shape — linear", () => {
    const input = '{"findings":['.repeat(20_000) + '"overall_correctness"'.repeat(500);
    const { out, ms } = timed(() => extractReviewJSON(input));
    expect(out.json).toBeNull();
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });
});
