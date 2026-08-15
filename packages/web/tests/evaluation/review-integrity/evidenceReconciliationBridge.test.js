// RI-3/RI-4 reconciliation bridge acceptance (RI-9 amendment, Phase 6/7).
//
// The deliberately boring full loop, per the authorized slice:
//   1. RepositoryTools v2 grep() locates a known fixture fact;
//   2. read() obtains the cited lines;
//   3. the normal RI-4 evidence reference is constructed;
//   4. the evidence is independently reconstructed through the REAL RI-3
//      path: createContextBroker() + buildFixtureOctokit() +
//      readRepoFile(path, headSha, { range }) — never the surface directly;
//   5. path, HEAD identity, blob identity, and cited content must agree;
//   6. deliberately injected disagreement must prove
//      approvalEvidenceComplete=false.
//
// Plus the RI-4 tie-in (the real readRepoFile item validates a real P2
// finding) and the production-shape tests: remote-session HEAD binding,
// ranged reconstruction content, truncated rejection, and strict path
// binding. Zero model calls.

import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { createContextBroker } from "../../../src/services/reviewContextBroker.js";
import { parseEvidenceRef, validateFinding, PROOF_TYPES } from "../../../src/services/findingValidator.js";
import {
  constructEvidenceReference,
  verifyEvidenceReconciliation,
  normalizeFileRead,
  contentDigest,
} from "../../../src/services/evidenceReconciliationService.js";
import { buildFixtureOctokit } from "./fixtureOctokit.js";
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

/** Run steps 1-5 for one fixture through the REAL RI-3 path. */
async function runBridgeLoop(caseId, variant, spec) {
  const fixture = loadFixture(caseId, variant);
  const session = await sessionForFixture(fixture);
  const tools = createRepositoryTools(session);

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

  // Step 4: independent reconstruction through the REAL RI-3 path —
  // fixture octokit + context broker + ranged readRepoFile.
  const octokit = buildFixtureOctokit(fixture);
  const broker = createContextBroker({
    octokit,
    owner: "org",
    repo: "repo",
    baseSha: fixture.source.base,
    headSha: fixture.source.head,
  });
  const fileRead = await broker.readRepoFile(spec.path, fixture.source.head, {
    range: { startLine: reviewerEvidence.startLine, endLine: reviewerEvidence.endLine },
  });
  expect(fileRead.type).toBe("file_read");
  expect(fileRead.error).toBeUndefined();
  expect(octokit.fixtureGaps).toEqual([]);
  // A ranged read returns ONLY the requested window with absolute numbers.
  expect(fileRead.range).toEqual({
    startLine: reviewerEvidence.startLine,
    endLine: reviewerEvidence.endLine,
  });

  const reconstruction = normalizeFileRead(fileRead);

  // Step 5: agreement proof.
  const verdict = verifyEvidenceReconciliation({ reviewerEvidence, reconstruction });

  return {
    reference,
    parsedRef: parseEvidenceRef(reference),
    reviewerEvidence,
    reconstruction,
    fileRead,
    verdict,
    fixture,
  };
}

describe("RI-3/RI-4 bridge — agreement proof over every historical fixture (real broker path)", () => {
  it.each(BRIDGE_CASES)("%s/%s: grep → read → reference → readRepoFile → agree", async (caseId, variant, spec) => {
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

    // All dimensions agree; approval evidence is complete. The ranged
    // reconstruction content (only the cited window) agrees byte-for-byte.
    expect(verdict.agree).toBe(true);
    expect(verdict.approvalEvidenceComplete).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.dimensions).toEqual({
      faithful: true,
      reconstructionServed: true,
      reconstructionComplete: true,
      headBinding: true,
      pathBinding: true,
      blobIdentity: true,
      rangeRepresented: true,
      contentAgreement: true,
    });
    expect(verdict.digests.reviewer).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verdict.digests.reconstruction).toBe(verdict.digests.reviewer);
    expect(reviewerEvidence.blobSha).toBe(reconstruction.blobSha);
  }, 240000);

  it("RI-4 consumes the REAL readRepoFile item and validates the reference (findingValidator)", async () => {
    const { reference, fileRead, fixture } = await runBridgeLoop(
      "ri04", "broken",
      { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }
    );

    // The broker's own context item is exactly what RI-4 expects.
    const finding = {
      severity: "P2",
      category: "bug",
      claim: "findCommentByMarker fetches only one page of comments",
      affectedPaths: [fileRead.path],
      evidenceRefs: [reference],
      proof: { type: PROOF_TYPES.STATIC_TRACE, description: "single request with per_page, no loop" },
      confidence: 0.9,
    };
    const validation = validateFinding(finding, { review: { headSha: fixture.source.head } }, [fileRead]);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  }, 240000);

  it("a FULL-FILE readRepoFile (range: null) also reconciles a citation inside it", async () => {
    const fixture = loadFixture("ri03", "broken");
    const session = await sessionForFixture(fixture);
    const tools = createRepositoryTools(session);

    const readResult = await tools.read({ path: "packages/web-dashboard/next.config.ts", offset: 5, limit: 1 });
    expect(["success", "partial"]).toContain(readResult.status);

    const octokit = buildFixtureOctokit(fixture);
    const broker = createContextBroker({
      octokit, owner: "org", repo: "repo",
      baseSha: fixture.source.base, headSha: fixture.source.head,
    });
    const fullFile = await broker.readRepoFile("packages/web-dashboard/next.config.ts", fixture.source.head);
    expect(fullFile.type).toBe("file_read");
    expect(fullFile.range).toBeNull();

    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: {
        repositorySessionId: readResult.repositorySessionId,
        sessionHeadSha: readResult.headSha,
        snapshotRef: readResult.snapshotRef,
        path: "packages/web-dashboard/next.config.ts",
        blobSha: readResult.data.blobSha,
        startLine: readResult.data.startLine,
        endLine: readResult.data.endLine,
        content: readResult.data.content,
        faithful: true,
      },
      reconstruction: normalizeFileRead(fullFile),
    });
    expect(verdict.approvalEvidenceComplete).toBe(true);
    expect(verdict.dimensions.contentAgreement).toBe(true);
  }, 240000);
});

describe("production remote-session HEAD binding (snapshotRef is null there)", () => {
  const REMOTE_HEAD = "b".repeat(40);
  const OTHER_HEAD = "c".repeat(40);

  function remoteReviewerEvidence(snapshotRefAbsent) {
    return {
      repositorySessionId: "remote-session-1",
      sessionHeadSha: REMOTE_HEAD,
      ...(snapshotRefAbsent ? {} : { snapshotRef: null }),
      path: "src/app.js",
      blobSha: "d".repeat(40),
      startLine: 2,
      endLine: 3,
      content: "line two\nline three",
      faithful: true,
    };
  }

  function remoteReconstruction(resolvedSha) {
    return normalizeFileRead({
      type: "file_read",
      path: "src/app.js",
      ref: resolvedSha,
      resolvedSha,
      blobSha: "d".repeat(40),
      contentDigest: contentDigest("line one\nline two\nline three"),
      range: { startLine: 2, endLine: 3 },
      truncated: false,
      content: "line two\nline three",
    });
  }

  it("binds via sessionHeadSha when snapshotRef is null (field present)", () => {
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: remoteReviewerEvidence(false),
      reconstruction: remoteReconstruction(REMOTE_HEAD),
    });
    expect(verdict.dimensions.headBinding).toBe(true);
    expect(verdict.approvalEvidenceComplete).toBe(true);
  });

  it("binds via sessionHeadSha when the snapshotRef field is absent", () => {
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: remoteReviewerEvidence(true),
      reconstruction: remoteReconstruction(REMOTE_HEAD),
    });
    expect(verdict.dimensions.headBinding).toBe(true);
    expect(verdict.approvalEvidenceComplete).toBe(true);
  });

  it("a reconstruction resolved at a different HEAD fails headBinding in remote mode", () => {
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: remoteReviewerEvidence(false),
      reconstruction: remoteReconstruction(OTHER_HEAD),
    });
    expect(verdict.dimensions.headBinding).toBe(false);
    expect(verdict.approvalEvidenceComplete).toBe(false);
    expect(verdict.reasons).toContain("headBinding");
  });
});

describe("ranged reconstruction content is mapped by range, never re-sliced absolutely", () => {
  it("a 4-line window with range {49,52} reconciles a 49-52 citation", () => {
    const reconstruction = normalizeFileRead({
      type: "file_read",
      path: "src/deep.js",
      ref: "a".repeat(40),
      resolvedSha: "a".repeat(40),
      blobSha: "e".repeat(40),
      range: { startLine: 49, endLine: 52 },
      truncated: false,
      content: "alpha\nbeta\ngamma\ndelta",
    });
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: {
        repositorySessionId: "s1",
        sessionHeadSha: "a".repeat(40),
        snapshotRef: null,
        path: "src/deep.js",
        blobSha: "e".repeat(40),
        startLine: 49,
        endLine: 52,
        content: "alpha\nbeta\ngamma\ndelta",
        faithful: true,
      },
      reconstruction,
    });
    expect(verdict.dimensions.rangeRepresented).toBe(true);
    expect(verdict.dimensions.contentAgreement).toBe(true);
    expect(verdict.approvalEvidenceComplete).toBe(true);
  });

  it("a citation OUTSIDE the ranged window is not represented", () => {
    const reconstruction = normalizeFileRead({
      type: "file_read",
      path: "src/deep.js",
      ref: "a".repeat(40),
      resolvedSha: "a".repeat(40),
      blobSha: "e".repeat(40),
      range: { startLine: 49, endLine: 52 },
      truncated: false,
      content: "alpha\nbeta\ngamma\ndelta",
    });
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: {
        repositorySessionId: "s1",
        sessionHeadSha: "a".repeat(40),
        snapshotRef: null,
        path: "src/deep.js",
        blobSha: "e".repeat(40),
        startLine: 60,
        endLine: 61,
        content: "whatever",
        faithful: true,
      },
      reconstruction,
    });
    expect(verdict.dimensions.rangeRepresented).toBe(false);
    expect(verdict.approvalEvidenceComplete).toBe(false);
  });
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
    "path absent on the exact-SHA side (not_found error object)",
    (rev, rec) => { Object.assign(rec, normalizeFileRead({ error: "not_found" })); },
    "reconstructionServed"
  );
  expectDisagreement(
    "reconstruction hits an invalid-ref error",
    (rev, rec) => { Object.assign(rec, normalizeFileRead({ error: "invalid_ref" })); },
    "reconstructionServed"
  );
  expectDisagreement(
    "MISSING reconstruction path is disagreement, not a pass",
    (rev, rec) => { delete rec.path; },
    "pathBinding"
  );
  expectDisagreement(
    "truncated reconstruction cannot serve as complete proof",
    (rev, rec) => { rec.truncated = true; },
    "reconstructionComplete"
  );
  expectDisagreement(
    "snapshot-divergent (unfaithful) blob claimed as evidence",
    (rev) => { rev.faithful = false; },
    "faithful"
  );
  expectDisagreement(
    "cited range beyond the reconstruction's represented window",
    (rev) => { rev.endLine = rev.endLine + 100000; },
    "rangeRepresented"
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
    // A hand-built "served" shape bypassing normalizeFileRead is still
    // rejected unless it carries the real file_read fields.
    expect(verifyEvidenceReconciliation({
      reviewerEvidence: baseline.reviewerEvidence,
      reconstruction: { status: "served" },
    }).approvalEvidenceComplete).toBe(false);
  });
});

describe("omitted completeness metadata is never upgraded (fail-closed)", () => {
  // Baseline pieces come from the real broker path above.
  let baseline;

  beforeAll(async () => {
    baseline = await runBridgeLoop(
      "ri04", "broken",
      { pattern: "findCommentByMarker", literal: true, path: COMMENT_MARKERS, expect: "findCommentByMarker" }
    );
    expect(baseline.verdict.approvalEvidenceComplete).toBe(true);
  }, 240000);

  it("omitted range never reconciles — normalizer rejects, verifier rejects", () => {
    const rawItem = { ...baseline.fileRead };
    delete rawItem.range;
    const normalized = normalizeFileRead(rawItem);
    expect(normalized.status).toBe("error");
    expect(normalized.error).toBe("malformed_file_read");
    expect(verifyEvidenceReconciliation({
      reviewerEvidence: baseline.reviewerEvidence,
      reconstruction: normalized,
    }).approvalEvidenceComplete).toBe(false);

    // Direct hand-built served shape without the field — same verdict.
    const handBuilt = { ...baseline.reconstruction };
    delete handBuilt.range;
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: baseline.reviewerEvidence,
      reconstruction: handBuilt,
    });
    expect(verdict.dimensions.reconstructionServed).toBe(false);
    expect(verdict.approvalEvidenceComplete).toBe(false);
    expect(verdict.reasons).toContain("reconstructionServed");
  });

  it("omitted truncated never reconciles — normalizer rejects, verifier rejects", () => {
    const rawItem = { ...baseline.fileRead };
    delete rawItem.truncated;
    const normalized = normalizeFileRead(rawItem);
    expect(normalized.status).toBe("error");
    expect(normalized.error).toBe("malformed_file_read");
    expect(verifyEvidenceReconciliation({
      reviewerEvidence: baseline.reviewerEvidence,
      reconstruction: normalized,
    }).approvalEvidenceComplete).toBe(false);

    const handBuilt = { ...baseline.reconstruction };
    delete handBuilt.truncated;
    const verdict = verifyEvidenceReconciliation({
      reviewerEvidence: baseline.reviewerEvidence,
      reconstruction: handBuilt,
    });
    expect(verdict.dimensions.reconstructionServed).toBe(false);
    expect(verdict.approvalEvidenceComplete).toBe(false);
  });

  it("a malformed range object never reconciles", () => {
    for (const badRange of [
      { startLine: 49 },                       // missing endLine
      { startLine: 0, endLine: 4 },            // startLine below 1
      { startLine: 10, endLine: 4 },           // endLine before startLine
      { startLine: "49", endLine: 52 },        // non-integer
      undefined,                               // present but undefined
    ]) {
      const rawItem = { ...baseline.fileRead, range: badRange };
      expect(normalizeFileRead(rawItem).status).toBe("error");
      const verdict = verifyEvidenceReconciliation({
        reviewerEvidence: baseline.reviewerEvidence,
        reconstruction: { ...baseline.reconstruction, range: badRange },
      });
      expect(verdict.approvalEvidenceComplete).toBe(false);
    }
  });
});
