// src/services/reviewEvidenceService.js
// Evidence eligibility for material findings (frozen v1.2, WP-4).
//
// Separates "the reviewer said this" from "this claim is eligible to
// influence deterministic repository policy". Every material finding
// (critical / high / medium — the P0/P1/P2 band) gets a canonical evidence
// receipt validated against the exact review SHA and the patches actually
// acquired for the review:
//
//   valid receipt   → the finding may influence deterministic blocking policy
//   invalid receipt → the finding stays visible to the maintainer and in the
//                     receipt, but cannot independently produce POLICY_BLOCKED
//
// Deleted lines are valid REVIEW evidence even though they can never become
// GitHub RIGHT-side inline annotations (#144 body-only presentation): the
// distinction is between review evidence and annotation capability.
//
// Pure computation plus node:crypto for the patch digest — no network, no DB.

import { createHash } from "node:crypto";

const MATERIAL_SEVERITIES = ["critical", "high", "medium"];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Build evidence receipts for a finding set against the reviewed files.
 *
 * @param {object} input
 * @param {Array}  input.findings - validated legacy findings ({severity, file, line})
 * @param {Array}  input.files    - reviewable file objects ({filename, patch})
 * @param {string} input.headSha  - exact head the files were acquired at
 * @returns {{
 *   receipts: Array<{findingIndex: number, path: string|null, headSha: string,
 *     range: {side: "old"|"new", start: number, end: number}|null,
 *     evidenceType: "changed_file"|null, digest: string|null, valid: boolean, reason: string}>,
 *   materialEvidenceValid: boolean
 * }}
 */
export function buildEvidenceReceipts({ findings, files, headSha }) {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const receipts = [];
  let materialEvidenceValid = true;

  findings.forEach((finding, findingIndex) => {
    const receipt = buildOneReceipt(finding, byPath, headSha);
    receipt.findingIndex = findingIndex;
    receipts.push(receipt);

    const isMaterial = MATERIAL_SEVERITIES.includes(finding.severity);
    if (isMaterial && !receipt.valid) {
      materialEvidenceValid = false;
    }
  });

  // No material findings → nothing stands between the coverage evidence and
  // the judgment, so evidence eligibility is vacuously satisfied.
  const hasMaterial = findings.some((f) => MATERIAL_SEVERITIES.includes(f.severity));
  if (!hasMaterial) materialEvidenceValid = true;

  return { receipts, materialEvidenceValid };
}

function buildOneReceipt(finding, byPath, headSha) {
  const base = {
    findingIndex: null,
    path: finding.file ?? null,
    headSha,
    range: null,
    evidenceType: null,
    digest: null,
    valid: false,
    reason: "",
  };

  if (!finding.file) return { ...base, reason: "no_location" };

  const file = byPath.get(finding.file);
  if (!file) return { ...base, reason: "path_not_in_review_scope" };

  const digest = createHash("sha256").update(file.patch ?? "").digest("hex").slice(0, 16);

  if (!file.patch) {
    return { ...base, digest, reason: "no_patch_evidence" };
  }
  if (typeof finding.line !== "number" || !Number.isFinite(finding.line)) {
    return { ...base, digest, reason: "no_line_reference" };
  }

  const span = findRepresentedSpan(file.patch, finding.line);
  if (!span) {
    return { ...base, digest, reason: "line_outside_patch" };
  }

  return {
    ...base,
    digest,
    range: { side: span.side, start: span.start, end: span.end },
    evidenceType: "changed_file",
    valid: true,
    reason: "validated",
  };
}

/**
 * Locate findingLine inside a unified-diff patch's represented hunks. The
 * ranges declared by each @@ header are exactly the represented lines, on
 * the old side (deletions, LEFT) and the new side (additions/context,
 * RIGHT). Deleted lines count as valid evidence.
 *
 * @returns {{side: "old"|"new", start: number, end: number}|null}
 */
function findRepresentedSpan(patch, findingLine) {
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) continue;

    const oldStart = parseInt(hunk[1], 10);
    const oldCount = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
    const newStart = parseInt(hunk[3], 10);
    const newCount = hunk[4] === undefined ? 1 : parseInt(hunk[4], 10);

    if (findingLine >= oldStart && findingLine < oldStart + oldCount) {
      return { side: "old", start: oldStart, end: oldStart + oldCount - 1 };
    }
    if (findingLine >= newStart && findingLine < newStart + newCount) {
      return { side: "new", start: newStart, end: newStart + newCount - 1 };
    }
  }
  return null;
}
