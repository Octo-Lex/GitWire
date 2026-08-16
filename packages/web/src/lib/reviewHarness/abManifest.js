// Frozen A/B manifest (RI-9 Phase 9). Built ONCE; every paid record
// references the manifest hash rather than reconstructing configuration.
// Nothing in this manifest may change after the first paid invocation.

import { createHash } from "node:crypto";

export const AB_OBJECTIVE_PREAMBLE = [
  "You are reviewing one pull request against its repository at the immutable HEAD.",
  "Determine whether the change introduces correctness defects. Correct means:",
  "the repository's own documented contracts hold; cross-file consistency holds",
  "(including status and behavioral documentation); API usage matches the called",
  "code's actual contract; and invariants the surrounding code relies on are",
  "preserved. Documentation contradictions about system state are correctness",
  "material. Cite exact file/line evidence for every material finding.",
].join(" ");

export const AB_FIXTURES = Object.freeze([
  { caseId: "RI-04", variant: "broken", fixtureHead: "624732c" },
  { caseId: "RI-04", variant: "fixed", fixtureHead: "a32a07e" },
]);

export const AB_BUDGETS = Object.freeze({
  deadlineMs: 480000,
  maxToolCalls: 60,
  maxCostUsd: 0.5,
  // Runaway guard only: at frozen pricing the cheapest category is
  // cache-read at $0.08/M, so $0.50 corresponds to 6.25M such tokens;
  // 7M sits beyond the nominal dollar threshold and should not normally
  // bind. maxCostUsd is a POST-TURN fail-closed crossing threshold, not a
  // guaranteed no-overshoot spend ceiling.
  maxTotalTokens: 7000000,
});

export const AB_ORDER = Object.freeze([
  { variant: "broken", arm: "current-gitwire" }, { variant: "broken", arm: "pi" },
  { variant: "broken", arm: "pi" }, { variant: "broken", arm: "current-gitwire" },
  { variant: "broken", arm: "current-gitwire" }, { variant: "broken", arm: "pi" },
  { variant: "fixed", arm: "pi" }, { variant: "fixed", arm: "current-gitwire" },
  { variant: "fixed", arm: "current-gitwire" }, { variant: "fixed", arm: "pi" },
  { variant: "fixed", arm: "pi" }, { variant: "fixed", arm: "current-gitwire" },
]);

/** Expected RI-04 defect signature: the STRICT semantic oracle (marker
 *  lookup + pagination + duplicate comments), exactly equivalent to the
 *  qualified evaluation oracle. Path/keyword citation alone scores nothing. */
export const RI04_EXPECTED = Object.freeze({
  broken: { caseId: "RI-04", severityClass: "material" },
  fixed: { caseId: "RI-04", severityClass: "none" },
});

/**
 * Build the frozen manifest. `gitHead` is stamped by the runner at the
 * exact execution head; the hash covers everything else.
 */
export function buildAbManifest({ gitHead, provider, model, piPromptVersion, currentPromptVersion, piPackageVersion }) {
  const manifest = {
    kind: "phase9-ab-manifest",
    version: 1,
    gitHead,
    arms: {
      "current-gitwire": { promptVersion: currentPromptVersion, orchestration: "seeded-context + 8-round loop + forced submit_review_result + narration retry" },
      pi: { promptVersion: piPromptVersion, piPackageVersion, orchestration: "pi agent loop + terminal submit_review" },
    },
    provider,
    model,
    fixtures: AB_FIXTURES,
    budgets: AB_BUDGETS,
    order: AB_ORDER,
    repetitions: 3,
    maxInvocations: 12,
    objectivePreamble: AB_OBJECTIVE_PREAMBLE,
    scoring: {
      convergence: "status=completed AND terminationReason=submitted AND submission payload structurally valid",
      brokenEffectiveness: ">=1 material finding matching the STRICT per-fixture semantic oracle AND surviving RI-4 validation AND passing non-circular evidence verification — path/keyword citation alone scores nothing",
      fixedPrecision: "a material claim on the clean fixture counts against precision unless a separately frozen adjudication establishes it true; RI-4 validity is evidence validity, not claim truth",
      evidenceIntegrity: "every material finding's repo-read refs verified: covering read + reproduction + RI-3 reconciliation (vacuously true when no material findings exist)",
      notScored: "model-generated APPROVE — RI-6 remains the decision authority",
    },
    decisionRule: {
      choosePi: "Pi MATERIALLY better: strict-oracle detection superiority, or a convergence margin GREATER than one run — a single stochastic run is not material — without worse fixed precision or evidence integrity",
      keepCurrent: "current arm reaches valid terminal submissions in >=4/6 runs AND shows >=1 strict-oracle broken detection while Pi submits in <=2/6",
      noWinner: "both fail similarly or results materially mixed — orchestration not established as the causal bottleneck; no per-arm tuning and rerun",
    },
    budgetSemantics: "maxCostUsd is a post-turn fail-closed crossing threshold, not a strict no-overshoot spend ceiling",
  };
  const hash = createHash("sha256").update(JSON.stringify({ ...manifest, gitHead: undefined })).digest("hex");
  return Object.freeze({ ...manifest, manifestHash: "sha256:" + hash });
}
