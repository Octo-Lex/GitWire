// RI-3/RI-4 reconciliation bridge acceptance (RI-9 amendment, Phase 6/7).
//
// The deliberately boring full loop, per the authorized slice:
//   1. RepositoryTools v2 grep() locates a known fixture fact;
//   2. read() obtains the cited lines;
//   3. the normal RI-4 evidence reference is constructed;
//   4. the evidence is independently reconstructed through the exact-SHA
//      integrity path (the faithful snapshot surface = GitHub-side truth);
//   5. path, HEAD identity, blob identity, and cited content must agree;
//   6. deliberately injected disagreement must prove
//      approvalEvidenceComplete=false.
//
// Plus the RI-4 tie-in: the reconstruction record, expressed as a context
// item, validates the constructed reference through the real
// findingValidator. Zero model calls.

import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { parseEvidenceRef, validateFinding, PROOF_TYPES } from "../../../src/services/findingValidator.js";
import {
  constructEvidenceReference,
  verifyEvidenceReconciliation,
  contentDigest,
} from "../../../src/services/evidenceReconciliationService.js";
import { resolveSurfacePath } from "./fixtures/repoSurface.js";
import { sessionForFixture, loadFixture, closeAllFixtureSessions } from "./fixtures/fixtureGitMaterializer.js";

const COMMENT_MARKERS = "packages/web/src/lib/commentMarkers.js";
const AI_REVIEW = "packages/web/src/services/aiReviewService.js";

// Known defect-supporting facts per fixture (broken AND fixed variants;
// mirrors the qualification oracles).
const BRIDGE_CASES = [
  ["ri01", "broken", { pattern: "reopened", literal: true, path: "README.md", expect: "reopened" }],
  ["ri01", "fixed", { pattern: "Phase 0 at a glance", literal: true, path: "README.md", expect: "Phase 0" }],
  ["ri02", "broken", { pattern: "0.5 exit proof", literal: true, path: "docs/roadmap.md", expect: "0.5 exit proof" }],
  ["ri02", "fixed", { pattern: "Agent replacement", literal: true, path: "docs/phase-0-spec.md", expect: "Agent replacement" }],
  ["ri03", "broken", { pattern: 'baseUrl + "/intelligence"', literal: true, path: AI_REVIEW, expect: "/intelligence" }],
  ["ri03", "fixed", { pattern: "dashboard/intelligence", literal: true, path: AI_REVIEW, expect: "/dashboard/intelligence" }],
  ["ri04", "broken", { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }],
  ["ri04", "fixed", { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }],
];

afterAll(() => {
  closeAllFixtureSessions();
});

/** Run steps 1-5 for one fixture; returns the reconciliation record. */
async function runBridgeLoop(caseId, variant, spec) {
  const fixture = loadFixture(caseId, variant);
  const session = await sessionForFixture(fixture);
  const tools = createRepositoryTools(session);
  const repoKey = fixture.source.repo.includes("AlCode") ? "alcode" : "gitwire";

  // Step 1: grep locates the known fact at the immutable HEAD.
  const located = await tools.grep({ pattern: spec.pattern, literal: true, path: spec.path });
  expect(located.status).toBe("success");
  expect(located.complete).toBe(true);
  const match = located.data.matches.find((m) => m.text.includes(spec.expect));
  expect(match).toBeDefined();

  // Step 2: read obtains the cited window (a mid-file window is a valid
  // partial result — completeness of the WINDOW is not the point here).
  const readResult = await tools.read({ path: spec.path, offset: match.line, limit: 4 });
  expect(["success", "partial"]).toContain(readResult.status);
  expect(readResult.data.content).toContain(spec.expect);

  const reviewerEvidence = {
    repositorySessionId: readResult.repositorySessionId,
    sessionHeadSha: readResult.headSha,
    snapshotRef: readResult.snapshotRef,
    path: readResult.data.path,
    blobSha: readResult.data.blobSha,
    startLine: readResult.data.startLine,
    endLine: readResult.data.endLine,
    content: readResult.data.content,
    faithful: session.identityReport.faithful.includes(spec.path),
  };

  // Step 3: construct the normal RI-4 evidence reference.
  const reference = constructEvidenceReference({
    path: reviewerEvidence.path,
    side: "HEAD",
    startLine: reviewerEvidence.startLine,
    endLine: reviewerEvidence.endLine,
  });

  // Step 4: independent exact-SHA reconstruction (GitHub-side surface).
  const surface = resolveSurfacePath(repoKey, fixture.source.head, spec.path);
  expect(surface.status).toBe("served");
  const reconstruction = {
    status: surface.status,
    resolvedSha: fixture.source.head,
    path: spec.path,
    blobSha: surface.blobSha,
    content: surface.content,
  };

  // Step 5: agreement proof.
  const verdict = verifyEvidenceReconciliation({ reviewerEvidence, reconstruction });

  return { reference, parsedRef: parseEvidenceRef(reference), reviewerEvidence, reconstruction, verdict, fixture };
}

describe("RI-3/RI-4 bridge — agreement proof over every historical fixture", () => {
  it.each(BRIDGE_CASES)("%s/%s: grep → read → reference → reconstruct → agree", async (caseId, variant, spec) => {
    const { reference, parsedRef, verdict, reviewerEvidence, reconstruction } = await runBridgeLoop(caseId, variant, spec);

    // The reference parses under the real RI-4 grammar.
    expect(parsedRef).toMatchObject({
      type: "repo-read",
      path: spec.path,
      side: "HEAD",
      startLine: reviewerEvidence.startLine,
      endLine: reviewerEvidence.endLine,
    });
    expect(parsedRef.raw).toBe(reference);

    // All dimensions agree; approval evidence is complete.
    expect(verdict.agree).toBe(true);
    expect(verdict.approvalEvidenceComplete).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.dimensions).toEqual({
      faithful: true,
      reconstructionServed: true,
      headBinding: true,
      pathBinding: true,
      blobIdentity: true,
      rangeValid: true,
      contentAgreement: true,
    });
    expect(verdict.digests.reviewer).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.digests.reconstruction).toBe(verdict.digests.reviewer);
    expect(reviewerEvidence.blobSha).toBe(reconstruction.blobSha);
  }, 240000);

  it("RI-4 consumes the reconstruction as a context item and validates the reference (real findingValidator)", async () => {
    const { reference, reviewerEvidence, reconstruction, fixture } = await runBridgeLoop(
      "ri04", "broken",
      { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }
    );

    const contextItem = {
      type: "file_read",
      path: reviewerEvidence.path,
      ref: fixture.source.head,
      resolvedSha: reconstruction.resolvedSha,
      blobSha: reconstruction.blobSha,
      contentDigest: contentDigest(reconstruction.content),
      range: { startLine: reviewerEvidence.startLine, endLine: reviewerEvidence.endLine },
      content: reconstruction.content,
    };
    const finding = {
      severity: "P2",
      category: "bug",
      claim: "findCommentByMarker fetches only one page of comments",
      affectedPaths: [reviewerEvidence.path],
      evidenceRefs: [reference],
      proof: { type: PROOF_TYPES.STATIC_TRACE, description: "single request with per_page, no loop" },
      confidence: 0.9,
    };
    const validation = validateFinding(finding, { review: { headSha: fixture.source.head } }, [contextItem]);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  }, 240000);
});

describe("RI-3/RI-4 bridge — injected disagreement forces approvalEvidenceComplete=false", () => {
  let baseline;

  beforeAll(async () => {
    baseline = await runBridgeLoop(
      "ri04", "broken",
      { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }
    );
    expect(baseline.verdict.approvalEvidenceComplete).toBe(true);
  }, 240000);

  /** Every injection must fail closed on its named dimension. */
  function expectDisagreement(label, mutate, expectedReason) {
    it(label, () => {
      const reviewerEvidence = { ...baseline.reviewerEvidence };
      const reconstruction = { ...baseline.reconstruction };
      mutate(reviewerEvidence, reconstruction);
      const verdict = verifyEvidenceReconciliation({ reviewerEvidence, reconstruction });
      expect(verdict.agree).toBe(false);
      expect(verdict.approvalEvidenceComplete).toBe(false);
      expect(verdict.reasons).toContain(expectedReason);
    });
  }

  expectDisagreement(
    "one tampered character in the reviewer's cited content",
    (rev) => { rev.content = rev.content + " TAMPERED"; },
    "contentAgreement"
  );
  expectDisagreement(
    "wrong blob identity on the reconstruction side",
    (rev, rec) => { rec.blobSha = "0".repeat(40); },
    "blobIdentity"
  );
  expectDisagreement(
    "reconstruction resolved at a different head (BASE instead of HEAD)",
    (rev, rec) => { rec.resolvedSha = "b8ccfb8"; },
    "headBinding"
  );
  expectDisagreement(
    "path absent on the exact-SHA side",
    (rev, rec) => { rec.status = "not_found"; },
    "reconstructionServed"
  );
  expectDisagreement(
    "reconstruction hits a fixture gap",
    (rev, rec) => { rec.status = "gap"; },
    "reconstructionServed"
  );
  expectDisagreement(
    "snapshot-divergent (unfaithful) blob claimed as evidence",
    (rev) => { rev.faithful = false; },
    "faithful"
  );
  expectDisagreement(
    "cited range beyond end of the reconstructed blob",
    (rev) => { rev.endLine = rev.endLine + 100000; },
    "rangeValid"
  );
  expectDisagreement(
    "missing resolvedSha on the reconstruction",
    (rev, rec) => { delete rec.resolvedSha; },
    "headBinding"
  );
  expectDisagreement(
    "empty repository session identity",
    (rev) => { rev.repositorySessionId = ""; },
    "headBinding"
  );

  it("structurally broken inputs fail closed without throwing", () => {
    expect(verifyEvidenceReconciliation({ reviewerEvidence: null, reconstruction: null }).approvalEvidenceComplete).toBe(false);
    expect(verifyEvidenceReconciliation({}).approvalEvidenceComplete).toBe(false);
    expect(verifyEvidenceReconciliation().approvalEvidenceComplete).toBe(false);
  });
});
