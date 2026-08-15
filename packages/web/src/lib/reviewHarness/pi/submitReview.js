// Terminal submit_review tool for the Pi harness (RI-9 amendment, Phase 8,
// Commit 4).
//
// The session's ONLY terminal tool — and it is DATA SUBMISSION, never a
// decision. The model cannot submit "APPROVE" as an authoritative action:
// GitWire still owns findings → RI-4 validation → verifier → RI-6 policy →
// RI-7 exactly-once mutation. submit_review:
//   1. validates the payload structure (schema, not policy);
//   2. preserves the raw submission verbatim;
//   3. requests session termination (the harness aborts the run once the
//      tool result is recorded);
//   4. performs NO GitHub mutation and NO policy decision.
//
// A malformed submission is reported back to the model as a tool error and
// NEVER captured — if the model never recovers, the run ends incomplete and
// approval is impossible. A duplicate submission after a valid one is
// ignored deterministically; the first valid submission stands.

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

/**
 * Structural validation of a submission payload. This is NOT RI-4 finding
 * validation — material-finding evidence binding happens later in GitWire.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateSubmission(payload) {
  const errors = [];
  const p = payload ?? {};
  if (typeof p !== "object" || Array.isArray(p)) {
    return { ok: false, errors: ["submission must be an object"] };
  }
  if (!Array.isArray(p.findings)) {
    errors.push("findings must be an array");
  } else {
    p.findings.forEach((f, i) => {
      const prefix = `findings[${i}]`;
      if (!f || typeof f !== "object") {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!SEVERITIES.has(f.severity)) errors.push(`${prefix}.severity must be P0|P1|P2|P3`);
      if (typeof f.claim !== "string" || f.claim.length === 0) errors.push(`${prefix}.claim must be a non-empty string`);
      if (!Array.isArray(f.evidenceRefs)) errors.push(`${prefix}.evidenceRefs must be an array`);
      if (f.affectedPaths !== undefined && !Array.isArray(f.affectedPaths)) errors.push(`${prefix}.affectedPaths must be an array when present`);
    });
  }
  if (!Array.isArray(p.unresolvedContextRequests)) {
    errors.push("unresolvedContextRequests must be an array");
  }
  if (typeof p.approvalEvidenceComplete !== "boolean") {
    errors.push("approvalEvidenceComplete must be a boolean");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build the submit_review tool bound to one run context.
 *
 * @param {object} runContext { submission?: {payload, submittedAt},
 *        submitAttempts: number, terminationRequested: boolean }
 * @returns {object} ToolDefinition
 */
export function createSubmitReviewTool(runContext) {
  return defineTool({
    name: "submit_review",
    label: "Submit review",
    description:
      "Submit the structured review result and END the review. This submits DATA for GitWire's independent validation — it is not an approval decision. " +
      "Payload: { findings: [{ severity: 'P0'|'P1'|'P2'|'P3', claim, description?, affectedPaths?, evidenceRefs: [repo-read:<path>@HEAD:L<start>-L<end> | changed:<path>@HEAD:L<start>-L<end>], proof?, confidence? }], unresolvedContextRequests: [], approvalEvidenceComplete: boolean }. " +
      "Call it exactly once, after your evidence is gathered.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          severity: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
          claim: Type.String({ description: "one-sentence claim of what is wrong (or empty array element style for none)" }),
          description: Type.Optional(Type.String({ description: "consequence chain: what breaks, when" })),
          affectedPaths: Type.Optional(Type.Array(Type.String())),
          evidenceRefs: Type.Array(Type.String({ description: "evidence reference, e.g. repo-read:src/app.js@HEAD:L3-L5" })),
          proof: Type.Optional(Type.Object({ type: Type.String(), description: Type.Optional(Type.String()) })),
          confidence: Type.Optional(Type.Number()),
        })
      ),
      unresolvedContextRequests: Type.Array(Type.Any()),
      approvalEvidenceComplete: Type.Boolean({
        description: "true only if ALL evidence needed to justify an approval decision was completely retrieved",
      }),
    }),
    execute: async (_toolCallId, params) => {
      runContext.submitAttempts += 1;

      if (runContext.submission !== undefined) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "E_ALREADY_SUBMITTED", message: "A valid submission was already captured; this duplicate is ignored." } }) }],
          details: { duplicate: true },
        };
      }

      const { ok, errors } = validateSubmission(params);
      if (!ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "E_INVALID_SUBMISSION", message: errors.join("; ") } }) }],
          details: { invalid: true, errors },
        };
      }

      runContext.submission = {
        payload: JSON.parse(JSON.stringify(params)),
        submittedAt: new Date().toISOString(),
      };
      runContext.terminationRequested = true;
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Review submitted. Terminating session; no further tool calls will execute." }) }],
        details: { submitted: true },
      };
    },
  });
}
