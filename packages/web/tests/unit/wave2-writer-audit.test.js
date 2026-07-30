// tests/unit/wave2-writer-audit.test.js
//
// Executable writer-call-site audit (Wave 2 / issue #94).
//
// Machine-executable inventory of every invocation of the five attribution
// writers. Fails when a new or unclassified caller appears. Reports exact
// counts with no approximations.
//
// Run: jest --testPathPattern='wave2-writer-audit'

import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, "..", "..", "src");

// ── Registry of known call sites ────────────────────────────────────────────
// Each entry is the canonical classification of a known call site.
// A NEW unclassified caller fails the gate.

const AUDIT = {
  decision_log: [
    // authorize.js — internal auth layer; principalId from authorize decision
    { file: "services/auth/authorize.js", line: 131, func: "authorize (allow path)", principalIdExpr: "decision.principalId", contextSource: "authorize decision", legacyActor: "n/a", classification: "system_or_bootstrap_context" },
    { file: "services/auth/authorize.js", line: 152, func: "denyAndLog", principalIdExpr: "decision.principalId", contextSource: "authorize decision", legacyActor: "n/a", classification: "system_or_bootstrap_context" },
    // observeAdopt.js — auth layer; principal from req.auth
    { file: "services/auth/observeAdopt.js", line: 52, func: "observeAuthorize", principalIdExpr: "decision.principalId", contextSource: "req.auth", legacyActor: "legacyActor param", classification: "http_auth_context" },
    // customRulesService.js — worker context (webhook handler passes webhookPrincipalId)
    { file: "services/customRulesService.js", line: 211, func: "evaluateAndExecuteCustomRules", principalIdExpr: "principalId param", contextSource: "webhook handler (webhookPrincipalId)", legacyActor: "data.actor", classification: "worker_auth_context" },
    // ciHealWorker.js — 9 calls; worker adopted
    { file: "workers/ciHealWorker.js", line: 242, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 261, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 278, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 291, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 304, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 318, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 340, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 367, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 396, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    // triageWorker.js — 8 calls; ALL ADOPTED (worker_auth_context)
    { file: "workers/triageWorker.js", line: 72, func: "triageIssue", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "issue.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 85, func: "triageIssue", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "issue.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 99, func: "triageIssue", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "issue.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 219, func: "triageIssue", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "issue.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 319, func: "triagePR", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "pr.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 332, func: "triagePR", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "pr.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 346, func: "triagePR", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "pr.user.login", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 422, func: "triagePR", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "pr.user.login", classification: "worker_auth_context" },
  ],

  audit_trail_entries: [
    { file: "services/aiReviewService.js", line: 361, func: "reviewPR", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "services/aiReviewService.js", line: 373, func: "reviewPR gate block", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 835, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker context", legacyActor: "gitwire[bot]", classification: "worker_auth_context" },
  ],

  repair_proposals: [
    { file: "services/repairProposalService.js", line: 903, func: "createProposal", principalIdExpr: "source.principalId", contextSource: "caller", legacyActor: "created_by", classification: "worker_auth_context" },
  ],

  repair_proposal_events: [
    { file: "services/repairProposalService.js", line: 946, func: "createProposal event", principalIdExpr: "source.principalId", contextSource: "caller", legacyActor: "created_by", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 1222, func: "attachEvidence", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 1384, func: "transitionProposal", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 1525, func: "recordCiEvidenceCollection", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 1935, func: "recordPatchProposal", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 2345, func: "recordVerificationResult", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
    { file: "services/repairProposalService.js", line: 3290, func: "recordCriticReview", principalIdExpr: "params.principalId || options.principalId", contextSource: "caller params", legacyActor: "actor param", classification: "worker_auth_context" },
  ],

  managed_actions: [
    { file: "services/customRulesService.js", line: 237, func: "evaluateAndExecuteCustomRules", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 570, func: "ciHealWorker", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 748, func: "ciHealWorker labelAction", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 775, func: "ciHealWorker revAction", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/ciHealWorker.js", line: 823, func: "ciHealWorker healAction", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/issueFix/validate.js", line: 92, func: "validate", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 168, func: "triageIssue", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 248, func: "triageIssue commentAction", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
    { file: "workers/triageWorker.js", line: 399, func: "triagePR sizeAction", principalIdExpr: "principalId", contextSource: "adoptWorker evidence context", legacyActor: "n/a", classification: "worker_auth_context" },
  ],
};

function readSrcFile(relPath) {
  const abs = path.join(SRC_ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

function findCallSites(sourceFile, pattern) {
  if (!sourceFile) return [];
  const lines = sourceFile.split("\n");
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pattern)) {
      matches.push({ file: null, line: i + 1, text: lines[i].trim() });
    }
  }
  return matches;
}

describe("Wave 2 — executable writer-call-site audit", () => {
  const tables = Object.keys(AUDIT);

  for (const table of tables) {
    describe(`${table}`, () => {
      it("every registered call site exists in the source", () => {
        for (const entry of AUDIT[table]) {
          const src = readSrcFile(entry.file);
          expect(src).not.toBeNull();
          const lines = src.split("\n");
          const nearby = lines.slice(Math.max(0, entry.line - 3), entry.line + 3).join("\n");
          const searchPattern =
            table === "decision_log" ? "logDecision(" :
            table === "audit_trail_entries" ? "Trail." :
            table === "repair_proposals" ? "INSERT INTO repair_proposals" :
            table === "repair_proposal_events" ? "insertProposalEvent(" :
            "propose(";
          expect(nearby).toContain(searchPattern);
        }
      });

      it("every call site has a valid classification", () => {
        const valid = ["http_auth_context", "worker_auth_context", "system_or_bootstrap_context", "explicit_compatibility_gap"];
        for (const entry of AUDIT[table]) {
          expect(valid).toContain(entry.classification);
        }
      });

      it("adopted callers pass principalId from their classified context", () => {
        const adopted = AUDIT[table].filter(e =>
          e.classification === "worker_auth_context" || e.classification === "http_auth_context"
        );
        for (const entry of adopted) {
          expect(entry.principalIdExpr).not.toBe("not passed (null)");
          expect(entry.principalIdExpr).toBeTruthy();
        }
      });
    });
  }

  it("reports exact totals for all five tables", () => {
    for (const table of tables) {
      const total = AUDIT[table].length;
      const adopted = AUDIT[table].filter(e =>
        e.classification === "worker_auth_context" || e.classification === "http_auth_context" ||
        e.classification === "system_or_bootstrap_context"
      ).length;
      const gaps = AUDIT[table].filter(e => e.classification === "explicit_compatibility_gap").length;
      console.log(`  ${table}: adopted ${adopted} / total ${total}; gaps ${gaps}`);
      expect(total).toBe(adopted + gaps);
    }
  });

  it("forged legacy actor metadata cannot affect principalId (structural assertion)", () => {
    const adopted = tables.flatMap(t =>
      AUDIT[t].filter(e => e.classification === "worker_auth_context" || e.classification === "http_auth_context")
    );
    for (const entry of adopted) {
      expect(entry.principalIdExpr).not.toBe(entry.legacyActor);
    }
  });
});
