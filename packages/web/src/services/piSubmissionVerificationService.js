// Pi submission evidence verification (RI-9 Phase 8 correction).
//
// The reviewer's submission is NOT trusted. For every repository-native
// evidence reference, this service proves three independent things:
//
//   1. OBSERVATION — a RepositoryTools `read` on that path actually ran
//      during the review and its delivered window covered the cited range
//      (proved from the session's append-only audit trace: the entry
//      records params and returnedItems, so the observed window is
//      [offset, offset + returnedItems - 1]);
//   2. REPRODUCTION — re-running the same read against the immutable
//      session produces the reviewer-side evidence (blob identity + cited
//      content) from the SESSION channel;
//   3. RECONCILIATION — the independent RI-3 exact-SHA reconstruction of
//      the cited range agrees on path, HEAD, blob identity, range, and
//      bytes (the already-closed bridge reconciliation).
//
// A reference the model never observed cannot pass step 1 — the reviewer
// side and the reconstruction side come from different channels, so a
// fabricated reference cannot reconcile against itself. Any failed step
// makes the finding's evidence incomplete: approval stays impossible.

import { parseEvidenceRef } from "./findingValidator.js";
import { verifyEvidenceReconciliation, normalizeFileRead } from "./evidenceReconciliationService.js";
import { createRepositoryTools } from "../lib/repositoryTools/index.js";

/**
 * Find an observed read that covered the cited range.
 * @returns {{windowStart: number, windowEnd: number, params: object} | null}
 */
function findCoveringRead(toolTrace, pathname, startLine, endLine) {
  for (const entry of toolTrace) {
    if (entry.operation !== "read") continue;
    if (entry.params?.path !== pathname) continue;
    if (entry.status === "error") continue;
    const offset = Number.isInteger(entry.params.offset) ? entry.params.offset : 1;
    const returned = Number.isInteger(entry.returnedItems) ? entry.returnedItems : 0;
    if (returned <= 0) continue;
    const windowStart = offset;
    const windowEnd = offset + returned - 1;
    if (windowStart <= startLine && endLine <= windowEnd) {
      return { windowStart, windowEnd, params: { ...entry.params }, returnedItems: returned };
    }
  }
  return null;
}

/** Slice the cited range out of a reproduced window (window convention:
 *  joined lines, trailing newline is a separator before an empty line). */
function citedSliceFromWindow(data, startLine, endLine) {
  const lines = String(data.content ?? "").split("\n");
  const relStart = startLine - data.startLine;
  const relEnd = relStart + (endLine - startLine + 1);
  if (relStart < 0 || relEnd > lines.length) return null;
  return lines.slice(relStart, relEnd).join("\n");
}

/**
 * Verify every repo-read evidence reference of a submission.
 *
 * @param {object} input
 * @param {object} input.submission the submit_review payload
 * @param {object} input.repositorySession the immutable session the tools read
 * @param {Array} input.toolTrace the session audit trace (snapshot at submit time)
 * @param {Function} input.reconstruct async (path, startLine, endLine) => the
 *        normalized RI-3 readRepoFile result for the cited range
 * @returns {Promise<{evidenceComplete: boolean, findings: Array}>}
 */
export async function verifySubmissionEvidence({ submission, repositorySession, toolTrace, reconstruct }) {
  const repositoryTools = createRepositoryTools(repositorySession);
  const findingsOut = [];
  let allMaterialComplete = true;

  for (const finding of submission.findings ?? []) {
    const material = ["P0", "P1", "P2"].includes(finding.severity);
    const out = {
      claim: finding.claim,
      severity: finding.severity,
      material,
      refs: [],
    };
    let findingComplete = true;

    for (const ref of finding.evidenceRefs ?? []) {
      const parsed = parseEvidenceRef(ref);
      if (!parsed) {
        out.refs.push({ ref, parsed: false, evidenceIncompleteReason: "unparseable_ref" });
        findingComplete = false;
        continue;
      }
      if (parsed.type !== "repo-read") {
        // changed: refs bind to ReviewEvidence patches — RI-4 territory,
        // not repository reconciliation. Deferred, not fabricated.
        out.refs.push({ ref, parsed: true, type: parsed.type, verification: "deferred_to_ri4_patch_validation" });
        continue;
      }

      // 1. Observation: did a real read cover the cited range?
      const covering = findCoveringRead(toolTrace, parsed.path, parsed.startLine, parsed.endLine);
      if (!covering) {
        out.refs.push({
          ref,
          parsed: true,
          type: "repo-read",
          coveringRead: null,
          evidenceIncompleteReason: "no_observed_covering_read",
        });
        findingComplete = false;
        continue;
      }

      // 2. Reproduction: same request against the immutable session.
      const reproduced = await repositoryTools.read({
        path: parsed.path,
        offset: covering.windowStart,
        limit: covering.windowEnd - covering.windowStart + 1,
      });
      if (reproduced.status === "error") {
        out.refs.push({
          ref,
          parsed: true,
          type: "repo-read",
          coveringRead: covering,
          reproduced: { status: "error", error: reproduced.error },
          evidenceIncompleteReason: "reproduction_failed",
        });
        findingComplete = false;
        continue;
      }
      const citedContent = citedSliceFromWindow(reproduced.data, parsed.startLine, parsed.endLine);
      if (citedContent === null) {
        out.refs.push({
          ref,
          parsed: true,
          type: "repo-read",
          coveringRead: covering,
          reproduced: { status: reproduced.status },
          evidenceIncompleteReason: "cited_range_outside_reproduced_window",
        });
        findingComplete = false;
        continue;
      }

      // 3. Independent RI-3 reconstruction + bridge reconciliation.
      const reconstruction = await reconstruct(parsed.path, parsed.startLine, parsed.endLine);
      const reconciliation = verifyEvidenceReconciliation({
        reviewerEvidence: {
          repositorySessionId: repositorySession.id,
          sessionHeadSha: repositorySession.headSha,
          snapshotRef: repositorySession.snapshotRefs?.head ?? null,
          path: parsed.path,
          blobSha: reproduced.data.blobSha,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
          content: citedContent,
          faithful: repositorySession.identityReport.faithful.includes(parsed.path),
        },
        reconstruction,
      });
      out.refs.push({
        ref,
        parsed: true,
        type: "repo-read",
        coveringRead: covering,
        reproduced: { status: reproduced.status, blobSha: reproduced.data.blobSha },
        reconciliation,
      });
      if (!reconciliation.approvalEvidenceComplete) {
        findingComplete = false;
      }
    }

    if (material && !findingComplete) allMaterialComplete = false;
    out.evidenceComplete = findingComplete;
    findingsOut.push(out);
  }

  return { evidenceComplete: allMaterialComplete, findings: findingsOut };
}

/**
 * Build the RI-3 reconstruction function over a Context Broker bound to the
 * review's immutable HEAD (the runner's wiring; tests may inject their own).
 */
export function brokerReconstruct(broker, headRef) {
  return async (path, startLine, endLine) => {
    const fileRead = await broker.readRepoFile(path, headRef, {
      range: { startLine, endLine },
    });
    return normalizeFileRead(fileRead);
  };
}
