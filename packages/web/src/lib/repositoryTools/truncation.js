// Shared completeness and truncation semantics for RepositoryTools v2
// (RI-9 amendment, Phase 4).
//
// One library defines partiality and output-window behavior for all four
// tools. A partial result must remain partial through:
//   tool → agent transcript → ReviewEvidence → approval-evidence
//   calculation → receipt
// No downstream layer may silently reinterpret a partial result as
// exhaustive evidence — propagatePartial()/assertPartialityPreserved()
// make that mechanically enforceable.

import { describeCompleteness } from "./contract.js";

export const TRUNCATION_REASONS = Object.freeze(["result_limit", "output_bytes", "output_lines"]);

/**
 * Window a line array for `read`: explicit line and UTF-8 byte caps,
 * continuation offset, and the amendment's truncation metadata.
 *
 * @param {object} input
 * @param {string[]} input.lines all lines of the blob (no phantom trailing line)
 * @param {number} input.offset 1-based first line to deliver
 * @param {number} input.limit max lines to deliver
 * @param {number} input.maxBytes max UTF-8 bytes of delivered content
 * @param {number} input.totalBytes total byte size of the blob
 * @returns {object} {content, startLine, endLine, outputLines, outputBytes,
 *          complete, nextOffset, truncation}
 */
export function windowTextLines({ lines, offset, limit, maxBytes, totalBytes }) {
  const totalLines = lines.length;
  const picked = [];
  let bytes = 0;
  let lineNo = offset;
  let truncatedBy = null;
  while (lineNo <= totalLines && picked.length < limit) {
    const weight = Buffer.byteLength(lines[lineNo - 1], "utf8") + 1;
    if (bytes + weight > maxBytes) {
      truncatedBy = "output_bytes";
      break;
    }
    picked.push(lines[lineNo - 1]);
    bytes += weight;
    lineNo++;
  }
  const complete = lineNo > totalLines;
  if (!complete && truncatedBy === null) {
    truncatedBy = picked.length >= limit ? "output_lines" : "output_bytes";
  }
  return {
    content: picked.join("\n"),
    startLine: offset,
    endLine: offset + picked.length - 1,
    outputLines: picked.length,
    outputBytes: Buffer.byteLength(picked.join("\n"), "utf8"),
    complete,
    nextOffset: complete ? null : lineNo,
    truncation: {
      totalLines,
      totalBytes,
      outputLines: picked.length,
      outputBytes: bytes,
      truncated: !complete,
      truncatedBy: complete ? null : truncatedBy,
      maxLines: limit,
      maxBytes,
      continuation: complete ? null : lineNo,
    },
  };
}

/**
 * Bound an item list (grep matches, find paths, ls entries) by count and
 * cumulative UTF-8 weight. Stopping early is always PARTIAL — matches-so-far
 * plus the machine reason it stopped.
 *
 * @param {object} input
 * @param {Array} input.items
 * @param {number} input.limit
 * @param {number} input.maxBytes
 * @param {(item: *) => number} input.weigh
 * @returns {{kept: Array, dropped: number, truncated: boolean,
 *           truncatedBy: string|null, outputBytes: number, partialReasons: string[]}}
 */
export function boundItems({ items, limit, maxBytes, weigh }) {
  const partialReasons = [];
  let bytes = 0;
  const kept = [];
  let truncatedBy = null;
  for (const item of items) {
    if (kept.length >= limit) {
      truncatedBy = "result_limit";
      break;
    }
    const weight = weigh(item);
    if (bytes + weight > maxBytes) {
      truncatedBy = "output_bytes";
      break;
    }
    bytes += weight;
    kept.push(item);
  }
  const truncated = truncatedBy !== null;
  if (truncated) partialReasons.push(truncatedBy);
  return {
    kept,
    dropped: truncated ? items.length - kept.length : 0,
    truncated,
    truncatedBy,
    outputBytes: bytes,
    partialReasons,
  };
}

/**
 * Receipt-safe partiality propagation record. This is what travels with the
 * evidence through transcript → ReviewEvidence → approval calculation →
 * receipt: the completeness string is derived once, upstream, and the
 * record carries it alongside the structured flags.
 */
export function propagatePartial(result) {
  return Object.freeze({
    operation: result.operation,
    repositorySessionId: result.repositorySessionId,
    headSha: result.headSha,
    completeness: describeCompleteness(result),
    status: result.status,
    complete: result.complete,
    partialReasons: Object.freeze([...result.partialReasons]),
  });
}

/**
 * Mechanical guard: after any serialization/transfer step, the propagated
 * record must still say exactly what the original result said. Throws if a
 * downstream layer flattened a partial into something that reads as
 * exhaustive.
 */
export function assertPartialityPreserved(result, propagated) {
  const original = describeCompleteness(result);
  if (propagated.completeness !== original) {
    throw new Error(
      `partiality corrupted in propagation: original=${original} propagated=${propagated.completeness}`
    );
  }
  if (propagated.complete !== result.complete) {
    throw new Error(
      `complete flag corrupted in propagation: original=${result.complete} propagated=${propagated.complete}`
    );
  }
  if (propagated.status !== result.status) {
    throw new Error(
      `status corrupted in propagation: original=${result.status} propagated=${propagated.status}`
    );
  }
  return true;
}
