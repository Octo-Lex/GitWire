// tests/unit/verifierLedgerFixture.js
// Shared fixture for the RI-5 falsification risk-ledger contract. Builds a
// structurally complete ledger with every obligation evidence-cleared, so
// tests can vary one axis at a time without re-verifying boilerplate.

import { RISK_CATEGORY_IDS } from "../../src/services/approvalVerificationService.js";

export function clearedObligation(description = "The change could alter caller-visible behavior at its call sites.") {
  return {
    description,
    resolution: {
      outcome: "evidence_cleared",
      evidenceRefs: ["repo-read:src/app.js@HEAD:L10-L20"],
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
export function completeClearedLedger() {
  return {
    categories: RISK_CATEGORY_IDS.map(id => ({
      category: id,
      obligations: [clearedObligation()],
      noneJustification: null,
    })),
  };
}

/**
 * Ledger with one category's obligations replaced. When the replacement
 * array is empty, a noneJustification keeps the ledger structurally valid.
 */
export function ledgerWithCategory(categoryId, obligations, noneJustification = null) {
  return {
    categories: RISK_CATEGORY_IDS.map(id =>
      id === categoryId
        ? { category: id, obligations, noneJustification }
        : { category: id, obligations: [clearedObligation()], noneJustification: null }
    ),
  };
}

/** Ledger missing one category entirely. */
export function ledgerMissingCategory(categoryId) {
  return {
    categories: RISK_CATEGORY_IDS
      .filter(id => id !== categoryId)
      .map(id => ({ category: id, obligations: [clearedObligation()], noneJustification: null })),
  };
}
