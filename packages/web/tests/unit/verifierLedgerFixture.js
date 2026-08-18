// tests/unit/verifierLedgerFixture.js
// Shared fixture for the RI-5 falsification risk-ledger contract. Builds a
// structurally complete ledger with every obligation evidence-cleared, so
// tests can vary one axis at a time without re-verifying boilerplate.

import { RISK_CATEGORY_IDS } from "../../src/services/approvalVerificationService.js";

export function clearedObligation(description = "The change could alter caller-visible behavior at its call sites.", evidenceRef = "changed:src/app.js@HEAD:L2-L3") {
  return {
    description,
    resolution: {
      outcome: "evidence_cleared",
      evidenceRefs: [evidenceRef],
    },
  };
}

export function unresolvedObligation(description = "A dependency implementation could not be read within budget.") {
  return {
    description,
    resolution: {
      outcome: "unresolved",
      reason: "Read budget exhausted before the dependency could be inspected at HEAD.",
    },
  };
}

export function materialObligation(description = "The change breaks a documented contract.") {
  return {
    description,
    resolution: {
      outcome: "material_finding",
      findingIndex: 0,
    },
  };
}

/** Structurally complete ledger, every obligation evidence-cleared. */
export function completeClearedLedger(evidenceRef) {
  return {
    categories: RISK_CATEGORY_IDS.map(id => ({
      category: id,
      obligations: [clearedObligation(undefined, evidenceRef)],
      noneJustification: null,
    })),
  };
}

/**
 * Structurally complete ledger with NO obligations — every category carries
 * a specific noneJustification. Useful where the harness evidence has no
 * changed files or broker reads to cite.
 */
export function completeNoneJustifiedLedger() {
  const justifications = {
    changed_behavior: "The changed lines only rename an internal variable with no call sites; behavior is unaffected.",
    dependency_interface_contracts: "No signatures, exports, or consumed contracts change in this diff.",
    state_side_effects: "The diff touches pure functions only; no state, I/O, or cleanup paths exist.",
    config_runtime_assumptions: "The change reads no configuration and assumes no runtime facts beyond the language.",
    normative_docs_tests: "No normative documentation or tests describe the renamed variable.",
    counterexamples: "No input can distinguish the rename; behavior is definitionally identical.",
  };
  return {
    categories: RISK_CATEGORY_IDS.map(id => ({
      category: id,
      obligations: [],
      noneJustification: justifications[id],
    })),
  };
}

/**
 * Ledger with one category's obligations replaced. When the replacement
 * array is empty, a noneJustification keeps the ledger structurally valid.
 */
export function ledgerWithCategory(categoryId, obligations, noneJustification = null, evidenceRef) {
  return {
    categories: RISK_CATEGORY_IDS.map(id =>
      id === categoryId
        ? { category: id, obligations, noneJustification }
        : { category: id, obligations: [clearedObligation(undefined, evidenceRef)], noneJustification: null }
    ),
  };
}

/** Ledger missing one category entirely. */
export function ledgerMissingCategory(categoryId, evidenceRef) {
  return {
    categories: RISK_CATEGORY_IDS
      .filter(id => id !== categoryId)
      .map(id => ({ category: id, obligations: [clearedObligation(undefined, evidenceRef)], noneJustification: null })),
  };
}
