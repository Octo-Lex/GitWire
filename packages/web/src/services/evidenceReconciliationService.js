// Evidence reconciliation — the RI-3/RI-4 bridge over RepositoryTools v2
// (RI-9 amendment, Phase 6/7).
//
// Architectural rule: repository tools help the reviewer UNDERSTAND the
// repository; this service PROVES what immutable repository state the
// reviewer's evidence refers to. The reviewer's tool result is never the
// final authority — every repository-native evidence reference must be
// independently reconstructed through the exact-SHA integrity path (RI-3
// reviewContextBroker.readRepoFile) before it can support a material
// finding.
//
//   Linux checkout reports evidence X at HEAD
//   + RI-3 readRepoFile reconstructs X at the same HEAD
//   → evidence identity is trustworthy
//
//   any disagreement (path, head, blob identity, range, content) or any
//   truncated/partial reconstruction
//   → approvalEvidenceComplete = false → APPROVE forbidden
//
// Every dimension fails closed: missing fields, error reconstructions,
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

/**
 * A reconstruction's `range` must be explicitly null (the RI-3 full-file
 * contract) or a valid absolute window. Anything else — including an
 * absent or malformed field — is not a well-formed reconstruction.
 */
function wellFormedRange(range) {
  if (range === null) return true;
  return (
    range !== undefined &&
    typeof range === "object" &&
    Number.isInteger(range.startLine) && range.startLine >= 1 &&
    Number.isInteger(range.endLine) && range.endLine >= range.startLine
  );
}

/** A served reconstruction must carry explicit, well-formed completeness
 *  metadata. Missing `range` or non-boolean `truncated` is malformed and
 *  must never be upgraded into approval-complete evidence. */
function wellFormedServed(x) {
  return (
    x.status === "served" &&
    Object.prototype.hasOwnProperty.call(x, "range") &&
    wellFormedRange(x.range) &&
    Object.prototype.hasOwnProperty.call(x, "truncated") &&
    typeof x.truncated === "boolean"
  );
}

/**
 * Normalize an actual RI-3 readRepoFile() result into the internal
 * reconstruction shape. This is the ONLY supported way to produce a
 * "served" reconstruction — callers must not hand-build one.
 *
 * Success item:  { type: "file_read", path, ref, resolvedSha, blobSha,
 *                  contentDigest, range, truncated, content }
 * Error object:  { error: "not_found" | "invalid_ref" | ... }
 *
 * `range` and `truncated` are REQUIRED on success items — the real
 * readRepoFile() always sets both explicitly. An item missing them is
 * malformed and fails closed as a non-served reconstruction.
 *
 * @returns {{status: "served", resolvedSha, path, blobSha, range, truncated,
 *            content, contentDigest}
 *          | {status: "not_found"|"error", error: string}}
 */
export function normalizeFileRead(result) {
  if (result && typeof result === "object" && result.type === "file_read") {
    if (!wellFormedServed({ status: "served", ...result })) {
      return { status: "error", error: "malformed_file_read" };
    }
    return {
      status: "served",
      resolvedSha: result.resolvedSha,
      path: result.path,
      blobSha: result.blobSha,
      range: result.range,
      truncated: result.truncated,
      content: result.content,
      contentDigest: result.contentDigest ?? null,
    };
  }
  if (result && typeof result === "object" && typeof result.error === "string") {
    return { status: result.error === "not_found" ? "not_found" : "error", error: result.error };
  }
  return { status: "error", error: "unrecognized_read_result" };
}

/**
 * The expected HEAD identity for head binding: snapshot sessions carry the
 * GitHub-side snapshot ref; production remote sessions have snapshotRef
 * null and bind through their fetched full commit SHA (sessionHeadSha).
 */
function expectedHead(reviewerEvidence) {
  if (typeof reviewerEvidence.snapshotRef === "string" && reviewerEvidence.snapshotRef.length > 0) {
    return reviewerEvidence.snapshotRef;
  }
  return typeof reviewerEvidence.sessionHeadSha === "string" && reviewerEvidence.sessionHeadSha.length > 0
    ? reviewerEvidence.sessionHeadSha
    : null;
}

/** Absolute line number of the first line of reconstruction content. */
function reconstructionBaseLine(reconstruction) {
  return Number.isInteger(reconstruction?.range?.startLine) && reconstruction.range.startLine >= 1
    ? reconstruction.range.startLine
    : 1;
}

/** Extract the cited window from reconstruction content, or null if out of
 *  the represented bounds.
 *
 *  Line convention follows the content's provenance: a RANGED read
 *  (range present) joined exactly its N lines with "\n", so a trailing
 *  newline is the separator before a final EMPTY line, not a file
 *  terminator — split without dropping it. FULL-FILE content keeps the
 *  file convention (a trailing newline does not create a phantom line). */
function citedWindow(reconstruction, startLine, endLine) {
  if (typeof reconstruction?.content !== "string") return null;
  const lines = reconstruction.range
    ? String(reconstruction.content).split("\n")
    : splitLines(reconstruction.content);
  const base = reconstructionBaseLine(reconstruction);
  const relStart = startLine - base;
  const relEnd = relStart + (endLine - startLine + 1); // exclusive bound
  if (relStart < 0 || relEnd > lines.length || relStart > relEnd) return null;
  return lines.slice(relStart, relEnd).join("\n");
}

/**
 * Verify that reviewer-side repository evidence and the independent
 * exact-SHA reconstruction describe the SAME immutable bytes.
 *
 * @param {object} input
 * @param {object} input.reviewerEvidence — from RepositoryTools read():
 *   { repositorySessionId, sessionHeadSha, snapshotRef?, path, blobSha,
 *     startLine, endLine, content, faithful }
 *   snapshotRef is present for snapshot sessions and null for production
 *   remote sessions (which bind via sessionHeadSha).
 * @param {object} input.reconstruction — normalizeFileRead(readRepoFile(...))
 * @returns {{agree: boolean, approvalEvidenceComplete: boolean,
 *           dimensions: object, reasons: string[], digests: object}}
 */
export function verifyEvidenceReconciliation(input) {
  const { reviewerEvidence, reconstruction } = input ?? {};

  const dimensions = {
    faithful: false,
    reconstructionServed: false,
    reconstructionComplete: false,
    headBinding: false,
    pathBinding: false,
    blobIdentity: false,
    rangeRepresented: false,
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
    // Served requires explicit, well-formed completeness metadata: an
    // absent or malformed `range`, or a non-boolean `truncated`, is a
    // malformed reconstruction — never upgraded to agreement evidence.
    dimensions.reconstructionServed = wellFormedServed(x);
    // A truncated reconstruction is a bounded-partial window: it can never
    // serve as complete proof, exactly like partial RepositoryTools results.
    dimensions.reconstructionComplete = dimensions.reconstructionServed && x.truncated !== true;

    const head = expectedHead(r);
    dimensions.headBinding =
      head !== null &&
      typeof x.resolvedSha === "string" &&
      x.resolvedSha === head &&
      typeof r.repositorySessionId === "string" &&
      r.repositorySessionId.length > 0;

    dimensions.pathBinding =
      typeof r.path === "string" && r.path.length > 0 && x.path === r.path;

    dimensions.blobIdentity =
      typeof r.blobSha === "string" &&
      /^[0-9a-f]{40}$/.test(r.blobSha) &&
      r.blobSha === x.blobSha;

    dimensions.rangeRepresented =
      Number.isInteger(r.startLine) && r.startLine >= 1 &&
      Number.isInteger(r.endLine) && r.endLine >= r.startLine &&
      x.status === "served" &&
      citedWindow(x, r.startLine, r.endLine) !== null &&
      (x.range
        ? r.endLine <= (Number.isInteger(x.range.endLine) ? x.range.endLine : x.range.startLine)
        : true);

    dimensions.contentAgreement =
      dimensions.rangeRepresented &&
      typeof r.content === "string" &&
      citedWindow(x, r.startLine, r.endLine) === r.content;
  } catch {
    // Any structural failure is disagreement — fail closed.
    return { ...record, reasons: ["reconciliation_error"] };
  }

  record.reasons = Object.entries(dimensions).filter(([, ok]) => !ok).map(([name]) => name);
  record.digests.reviewer = contentDigest(reviewerEvidence?.content);
  const window = dimensions.reconstructionServed
    ? citedWindow(reconstruction, reviewerEvidence.startLine, reviewerEvidence.endLine)
    : null;
  record.digests.reconstruction = window === null ? null : contentDigest(window);
  record.agree = record.reasons.length === 0;
  record.approvalEvidenceComplete = record.agree;
  return record;
}
