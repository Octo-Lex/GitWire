// Evidence reconciliation — the RI-3/RI-4 bridge over RepositoryTools v2
// (RI-9 amendment, Phase 6/7).
//
// Architectural rule: repository tools help the reviewer UNDERSTAND the
// repository; this service PROVES what immutable repository state the
// reviewer's evidence refers to. The reviewer's tool result is never the
// final authority — every repository-native evidence reference must be
// independently reconstructed through the exact-SHA integrity path (RI-3:
// GitHub-side immutable acquisition at the review head) before it can
// support a material finding.
//
//   Linux checkout reports evidence X at HEAD
//   + exact-SHA reconstruction reports X at the same HEAD
//   → evidence identity is trustworthy
//
//   any disagreement (path, head, blob identity, range, content)
//   → approvalEvidenceComplete = false → APPROVE forbidden
//
// Every dimension fails closed: missing fields, non-served reconstructions,
// unfaithful blobs, and thrown errors all count as disagreement.

import { createHash } from "node:crypto";
import { splitLines } from "../lib/repositoryTools/read.js";

/** sha256 digest in the RI-3 ReviewEvidence form: "sha256:<hex>". */
export function contentDigest(content) {
  return "sha256:" + createHash("sha256").update(String(content ?? ""), "utf-8").digest("hex");
}

/**
 * Construct an RI-4 repository-native evidence reference from a
 * RepositoryTools read window.
 *
 * Grammar (findingValidator.parseEvidenceRef):
 *   repo-read:{path}@{SIDE}:L{start}-L{end}
 *   repo-read:{path}@{SIDE}:L{line}
 */
export function constructEvidenceReference({ path, side = "HEAD", startLine, endLine }) {
  if (!path || typeof path !== "string") {
    throw new Error("constructEvidenceReference requires a path");
  }
  if (side !== "HEAD" && side !== "BASE") {
    throw new Error("side must be HEAD or BASE");
  }
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error("startLine must be a positive integer");
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new Error("endLine must be an integer >= startLine");
  }
  const range = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `repo-read:${path}@${side}:${range}`;
}

/** Slice reconstruction content to the cited window using read()'s line
 *  convention (trailing newline does not create a phantom line). */
function sliceWindow(fullContent, startLine, endLine) {
  const lines = splitLines(String(fullContent ?? ""));
  if (startLine < 1 || endLine > lines.length || startLine > endLine) return null;
  return lines.slice(startLine - 1, endLine).join("\n");
}

/**
 * Verify that reviewer-side repository evidence and the independent
 * exact-SHA reconstruction describe the SAME immutable bytes.
 *
 * @param {object} input
 * @param {object} input.reviewerEvidence — from RepositoryTools read():
 *   { repositorySessionId, sessionHeadSha, snapshotRef, path, blobSha,
 *     startLine, endLine, content, faithful }
 * @param {object} input.reconstruction — from the RI-3 exact-SHA path
 *   (reviewContextBroker.readRepoFile / faithful snapshot surface):
 *   { status: "served"|"not_found"|"gap", resolvedSha, path?, blobSha, content }
 * @returns {{agree: boolean, approvalEvidenceComplete: boolean,
 *           dimensions: object, reasons: string[], digests: object}}
 */
export function verifyEvidenceReconciliation(input) {
  const { reviewerEvidence, reconstruction } = input ?? {};
  const dimensions = {
    faithful: false,
    reconstructionServed: false,
    headBinding: false,
    pathBinding: false,
    blobIdentity: false,
    rangeValid: false,
    contentAgreement: false,
  };

  const record = {
    agree: false,
    approvalEvidenceComplete: false,
    dimensions,
    reasons: [],
    digests: { reviewer: null, reconstruction: null },
  };

  try {
    const r = reviewerEvidence ?? {};
    const x = reconstruction ?? {};

    dimensions.faithful = r.faithful === true;
    dimensions.reconstructionServed = x.status === "served";
    dimensions.headBinding =
      typeof r.snapshotRef === "string" &&
      r.snapshotRef.length > 0 &&
      typeof x.resolvedSha === "string" &&
      x.resolvedSha === r.snapshotRef &&
      typeof r.repositorySessionId === "string" &&
      r.repositorySessionId.length > 0;
    dimensions.pathBinding =
      typeof r.path === "string" && r.path.length > 0 && (x.path === undefined || x.path === r.path);
    dimensions.blobIdentity =
      typeof r.blobSha === "string" &&
      /^[0-9a-f]{40}$/.test(r.blobSha) &&
      r.blobSha === x.blobSha;
    dimensions.rangeValid =
      Number.isInteger(r.startLine) && r.startLine >= 1 &&
      Number.isInteger(r.endLine) && r.endLine >= r.startLine &&
      typeof x.content === "string" &&
      sliceWindow(x.content, r.startLine, r.endLine) !== null;
    dimensions.contentAgreement =
      dimensions.rangeValid &&
      typeof r.content === "string" &&
      sliceWindow(x.content, r.startLine, r.endLine) === r.content;
  } catch {
    // Any structural failure is disagreement — fail closed.
    record.reasons = ["reconciliation_error"];
    return record;
  }

  record.reasons = Object.entries(dimensions).filter(([, ok]) => !ok).map(([name]) => name);
  record.digests.reviewer = contentDigest(reviewerEvidence?.content);
  const reconstructionWindow = dimensions.reconstructionServed && dimensions.rangeValid
    ? sliceWindow(reconstruction.content, reviewerEvidence.startLine, reviewerEvidence.endLine)
    : null;
  record.digests.reconstruction = reconstructionWindow === null ? null : contentDigest(reconstructionWindow);
  record.agree = record.reasons.length === 0;
  record.approvalEvidenceComplete = record.agree;
  return record;
}
