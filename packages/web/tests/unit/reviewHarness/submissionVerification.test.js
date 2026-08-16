// Pi submission evidence verification (RI-9 Phase 8 correction, blocker 3)
// — a fabricated reference the model never observed must fail; a genuinely
// observed one must pass observation → reproduction → reconciliation.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import {
  verifySubmissionEvidence,
  brokerReconstruct,
} from "../../../src/services/piSubmissionVerificationService.js";
import { normalizeFileRead } from "../../../src/services/evidenceReconciliationService.js";
import { buildSnapshotSource } from "../repositoryTools/helpers.js";

const FILES = {
  "README.md": "# title\nsecond line\nthird line\n",
  "src/app.js": "export function main() {\n  return NEEDLE;\n}\nconst tail = 1;\n",
};

let repositorySession;
let repositoryTools;
let headTree;

function fakeBrokerReconstruct() {
  // Deterministic RI-3 stand-in built from the same snapshot source: serves
  // ranged fileRead items for the immutable head ref.
  const byPath = new Map(headTree.tree.map((e) => [e.path, e]));
  return async (path, startLine, endLine) => {
    const entry = byPath.get(path);
    if (!entry) return normalizeFileRead({ error: "not_found" });
    const content = headTree.blobs[entry.sha];
    const lines = content === "" ? [] : content.split("\n").slice(startLine - 1, endLine).join("\n");
    return normalizeFileRead({
      type: "file_read",
      path,
      ref: headTree.ref,
      resolvedSha: headTree.ref,
      blobSha: entry.sha,
      range: { startLine, endLine },
      truncated: false,
      content: lines,
    });
  };
}

function submissionWithRef(ref) {
  return {
    findings: [{ severity: "P2", claim: "claim under test", evidenceRefs: [ref] }],
    unresolvedContextRequests: [],
    approvalEvidenceComplete: false,
  };
}

beforeAll(async () => {
  headTree = await buildSnapshotSource(FILES, { ref: "verify-head" });
  repositorySession = await prepareRepository({
    invocationId: "verify-sub-test",
    headSha: "verify-head",
    acquire: { mode: "snapshot", headTree, blobs: headTree.blobs },
  });
  repositoryTools = createRepositoryTools(repositorySession);
});

afterAll(() => {
  repositorySession?.close?.();
});

async function verify(submission) {
  return verifySubmissionEvidence({
    submission,
    repositorySession,
    toolTrace: repositorySession.auditTrace(),
    reconstruct: fakeBrokerReconstruct(),
  });
}

describe("observed evidence passes the triple proof", () => {
  it("a genuinely read window reconciles: observation + reproduction + RI-3", async () => {
    // The model really read src/app.js lines 1-4.
    const read = await repositoryTools.read({ path: "src/app.js", offset: 1, limit: 4 });
    expect(read.status).toBe("success");

    const result = await verify(submissionWithRef("repo-read:src/app.js@HEAD:L2-L3"));
    expect(result.evidenceComplete).toBe(true);
    const ref = result.findings[0].refs[0];
    expect(ref.parsed).toBe(true);
    expect(ref.coveringRead).toMatchObject({ windowStart: 1, windowEnd: 4 });
    expect(ref.reproduced.status).toBe("success");
    expect(ref.reconciliation.approvalEvidenceComplete).toBe(true);
  });

  it("a partial covering window still proves the cited range", async () => {
    await repositoryTools.read({ path: "README.md", offset: 2, limit: 5 }); // partial window (file has 3 lines)
    const result = await verify(submissionWithRef("repo-read:README.md@HEAD:L2-L3"));
    expect(result.evidenceComplete).toBe(true);
  });
});

describe("fabricated evidence fails closed", () => {
  it("a syntactically valid ref to a NEVER-READ file has no covering read", async () => {
    const result = await verify(submissionWithRef("repo-read:docs/never-read.md@HEAD:L1-L5"));
    expect(result.evidenceComplete).toBe(false);
    const ref = result.findings[0].refs[0];
    expect(ref.evidenceIncompleteReason).toBe("no_observed_covering_read");
    expect(ref.coveringRead).toBeNull();
    expect(ref.reconciliation).toBeUndefined();
  });

  it("a ref to a READ file but OUTSIDE every observed window fails", async () => {
    // Earlier tests read src/app.js windows 1-4 and 1-2 — cite line 5,
    // which no observed window has ever covered.
    const result = await verify(submissionWithRef("repo-read:src/app.js@HEAD:L5-L5"));
    expect(result.evidenceComplete).toBe(false);
    expect(result.findings[0].refs[0].evidenceIncompleteReason).toBe("no_observed_covering_read");
  });

  it("an unparseable ref fails the finding", async () => {
    const result = await verify(submissionWithRef("not-a-ref"));
    expect(result.evidenceComplete).toBe(false);
    expect(result.findings[0].refs[0].evidenceIncompleteReason).toBe("unparseable_ref");
  });

  it("a reconciliation mismatch (wrong blob identity on the RI-3 side) fails", async () => {
    await repositoryTools.read({ path: "README.md", offset: 1, limit: 3 });
    const poisoned = async (path, startLine, endLine) => {
      const good = await fakeBrokerReconstruct()(path, startLine, endLine);
      return { ...good, blobSha: "0".repeat(40) };
    };
    const result = await verifySubmissionEvidence({
      submission: submissionWithRef("repo-read:README.md@HEAD:L1-L1"),
      repositorySession,
      toolTrace: repositorySession.auditTrace(),
      reconstruct: poisoned,
    });
    expect(result.evidenceComplete).toBe(false);
    expect(result.findings[0].refs[0].reconciliation.approvalEvidenceComplete).toBe(false);
  });

  it("P3 findings with fabricated refs do not block, but are recorded", async () => {
    const result = await verify({
      findings: [{ severity: "P3", claim: "minor", evidenceRefs: ["repo-read:docs/never-read.md@HEAD:L1-L1"] }],
      unresolvedContextRequests: [],
      approvalEvidenceComplete: false,
    });
    expect(result.findings[0].evidenceComplete).toBe(false);
    expect(result.evidenceComplete).toBe(true); // non-material does not gate approval
  });
});

describe("brokerReconstruct wiring", () => {
  it("builds the RI-3 reconstruction over a context broker", async () => {
    // Minimal broker stub — brokerReconstruct only calls readRepoFile.
    const calls = [];
    const broker = {
      readRepoFile: async (path, ref, opts) => {
        calls.push({ path, ref, range: opts.range });
        return {
          type: "file_read",
          path,
          ref,
          resolvedSha: ref,
          blobSha: "a".repeat(40),
          range: opts.range,
          truncated: false,
          content: "x\ny",
        };
      },
    };
    const reconstruct = brokerReconstruct(broker, "abc1234");
    const out = await reconstruct("README.md", 1, 2);
    expect(out.status).toBe("served");
    expect(out.range).toEqual({ startLine: 1, endLine: 2 });
    expect(calls[0]).toEqual({ path: "README.md", ref: "abc1234", range: { startLine: 1, endLine: 2 } });
  });
});
