// tests/evaluation/review-integrity/expected-defect.js
// Strict expected-defect scoring (RI-9 evaluation-integrity correction).
//
// A broken run counts as DETECTED only when a canonical P0/P1/P2 finding
// actually matches that fixture's expected defect. Unresolved context needs
// satisfy the frozen third-run abstain/incomplete allowance — they never
// count toward the ≥2/3 detection requirement. The old generic keyword
// match (e.g. any "duplicate comment" mention) awarded credit for the
// wrong defect and is replaced by per-fixture semantic signatures.

const MATERIAL_LEGACY = new Set(["critical", "high", "medium"]);
const MATERIAL_V2 = new Set(["P0", "P1", "P2"]);

/** Collect the canonical material finding texts from a completed run. */
export function canonicalMaterialFindings({ result, v2PrimaryFindings, v2VerifierReceipt }) {
  const texts = [];
  for (const f of (result?.findings || [])) {
    if (MATERIAL_LEGACY.has(f.severity)) {
      texts.push(((f.title || "") + " " + (f.description || "")).toLowerCase());
    }
  }
  for (const f of (v2PrimaryFindings || [])) {
    if (MATERIAL_V2.has(f.severity)) texts.push((f.claim || "").toLowerCase());
  }
  for (const f of (v2VerifierReceipt?.findings || [])) {
    if (MATERIAL_V2.has(f.severity)) texts.push((f.claim || "").toLowerCase());
  }
  return texts;
}

function has(text, terms) {
  return terms.some(t => text.includes(t));
}

/**
 * Strict per-fixture expected-defect signatures.
 * Each takes the JOINED material finding text and returns true only when
 * the EXPECTED defect is described — not merely related vocabulary.
 */
const STRICT_SIGNATURES = {
  // Expected: stale Phase 0 status declarations — docs still say a phase is
  // reopened/pending while the PR closes it.
  "RI-01": (t) =>
    has(t, ["synchron", "stale", "contradict", "inconsisten", "outdated", "not updated", "still says", "still declares", "still marks"]) &&
    has(t, ["status", "phase", "declaration", "reopened", "closed", "pending"]) &&
    has(t, ["readme", "constitution", "phase-0-spec", "roadmap", "docs/", "documentation", "spec"]),

  // Expected: gate 0.5 (or a declared gate) lacks the agent-replacement /
  // independent-agent-restart assertion the roadmap makes an exit requirement.
  "RI-02": (t) =>
    has(t, ["gate", "exit"]) &&
    has(t, ["agent"]) &&
    has(t, ["replac", "restart", "swap", "resummon", "kill", "terminate", "preserv"]),

  // Expected: activation URL missing the /dashboard basePath.
  "RI-03": (t) =>
    has(t, ["basepath", "base path", "/dashboard/intelligence", "dashboard basepath"]) ||
    (has(t, ["url", "link"]) && has(t, ["basepath", "base path", "/dashboard"])),

  // Expected: findCommentByMarker fetches only one page of 100 comments, so
  // a marker beyond page 1 is missed and a duplicate comment is created.
  "RI-04": (t) =>
    has(t, ["findcommentbymarker", "marker lookup", "comment marker", "findcomment", "commentmarkers"]) &&
    has(t, ["paginat", "per_page", "first page", "page 1", "single page", "one page", "only one page", "100 comments", "next page"]) &&
    has(t, ["duplicate", "duplicat"]),
};

/**
 * Score a run against its fixture's expected defect.
 *
 * @returns {boolean} true only when a canonical material finding matches
 *   the strict expected-defect signature for this fixture.
 */
export function detectExpectedDefect(fixture, runContext) {
  const signature = STRICT_SIGNATURES[fixture.caseId];
  if (!signature) return false;
  const materialTexts = canonicalMaterialFindings(runContext);
  return materialTexts.some(signature);
}
