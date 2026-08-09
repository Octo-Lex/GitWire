// tests/unit/comment-markers-pagination.test.js
// Helper-level tests for findCommentByMarker pagination and postMarkedComment
// exactly-once behavior.
//
// The defect (Codex P2): findCommentByMarker fetched only one page of 100
// comments. If the marker comment was on page 2+, it returned null, and
// postMarkedComment created a duplicate. This violated the frozen requirement:
// retry/reprocessing → update/reuse the marker-backed comment rather than
// duplicate.
//
// The fix: findCommentByMarker now paginates through ALL pages until either
// all pages are searched or ambiguity (2+ matches) is proven.

import { jest } from "@jest/globals";

const { findCommentByMarker, postMarkedComment, buildMarker } = await import("../../src/lib/commentMarkers.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const MARKER = "<!-- gitwire:triage:999:42 -->";

function makeComment(id, body) {
  return { id, body, user: { login: "gitwire-hq[bot]" } };
}

// Build an octokit mock whose GET comments endpoint paginates.
// Each "page" is an array of comment objects. The mock returns pages
// sequentially based on the `page` query param.
function makePaginatedOctokit(pages) {
  return {
    request: jest.fn().mockImplementation((method, params) => {
      if (method.includes("GET") && method.includes("/comments")) {
        const pageNum = params.page || 1;
        const pageData = pages[pageNum - 1] || [];
        return Promise.resolve({ data: pageData });
      }
      if (method.includes("PATCH")) {
        return Promise.resolve({ data: { id: params.comment_id } });
      }
      if (method.includes("POST") && method.includes("/comments")) {
        return Promise.resolve({ data: { id: 99999 } });
      }
      return Promise.resolve({ data: {} });
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("findCommentByMarker pagination", () => {

  // 1. Marker exists only on page 2 → found and updated, no POST
  it("finds marker on page 2 and returns the existing comment", async () => {
    // Page 1: 100 filler comments (full page → more pages exist)
    const filler = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, "some other comment " + i)
    );
    // Page 2: the marker comment + a few fillers (partial page → last page)
    const page2 = [
      ...filler.slice(0, 3),
      makeComment(200, MARKER + "\n👋 **Automated triage**"),
      ...filler.slice(3, 5),
    ];

    const octokit = makePaginatedOctokit([filler, page2]);
    const result = await findCommentByMarker(octokit, "org", "repo", "42", MARKER);

    // Should have found the comment
    expect(result).not.toBeNull();
    expect(result.id).toBe(200);
    // Should have fetched page 1 AND page 2
    const getCalls = octokit.request.mock.calls.filter(
      ([m]) => m.includes("GET") && m.includes("/comments")
    );
    expect(getCalls).toHaveLength(2);
    expect(getCalls[0][1].page).toBe(1);
    expect(getCalls[1][1].page).toBe(2);
  });

  // 2. No marker across multiple pages → null (exactly one new comment on POST)
  it("returns null when marker is not found across all pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, "filler " + i)
    );
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeComment(i + 101, "more filler " + i)
    );

    const octokit = makePaginatedOctokit([page1, page2]);
    const result = await findCommentByMarker(octokit, "org", "repo", "42", MARKER);

    expect(result).toBeNull();
    // Should have fetched both pages
    const getCalls = octokit.request.mock.calls.filter(
      ([m]) => m.includes("GET") && m.includes("/comments")
    );
    expect(getCalls).toHaveLength(2);
  });

  // 3. One marker on page 1 and another on page 2 → ambiguous/block, no mutation
  it("returns ambiguous when markers span multiple pages", async () => {
    const page1 = Array.from({ length: 99 }, (_, i) =>
      makeComment(i + 1, "filler " + i)
    );
    page1.push(makeComment(100, MARKER + "\nfirst triage comment"));

    const page2 = [
      makeComment(101, MARKER + "\nsecond triage comment"),
      ...Array.from({ length: 5 }, (_, i) => makeComment(i + 102, "filler")),
    ];

    const octokit = makePaginatedOctokit([page1, page2]);
    const result = await findCommentByMarker(octokit, "org", "repo", "42", MARKER);

    expect(result.ambiguous).toBe(true);
    expect(result.comments).toHaveLength(2);
  });
});

describe("postMarkedComment exactly-once behavior", () => {

  // 4. Marker on page 2 → update (PATCH), no POST
  it("updates existing comment when marker is on page 2 (no duplicate POST)", async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, "filler " + i)
    );
    const page2 = [makeComment(200, MARKER + "\nold triage")];

    const octokit = makePaginatedOctokit([filler, page2]);
    const result = await postMarkedComment(octokit, "org", "repo", 42, "triage", "999:42", "new body");

    expect(result.action).toBe("updated");
    expect(result.comment_id).toBe(200);
    // Should have PATCHed, NOT POSTed
    const patchCalls = octokit.request.mock.calls.filter(([m]) => m.includes("PATCH"));
    const postCalls = octokit.request.mock.calls.filter(
      ([m]) => m.includes("POST") && m.includes("/comments")
    );
    expect(patchCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(0);
  });

  // 5. No marker across pages → create (exactly one POST)
  it("creates exactly one new comment when marker not found", async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      makeComment(i + 1, "filler " + i)
    );
    const page2 = Array.from({ length: 50 }, (_, i) =>
      makeComment(i + 101, "more filler " + i)
    );

    const octokit = makePaginatedOctokit([filler, page2]);
    const result = await postMarkedComment(octokit, "org", "repo", 42, "triage", "999:42", "new body");

    expect(result.action).toBe("created");
    const postCalls = octokit.request.mock.calls.filter(
      ([m]) => m.includes("POST") && m.includes("/comments")
    );
    expect(postCalls).toHaveLength(1);
  });

  // 6. Ambiguous markers across pages → blocked, no mutation
  it("blocks with no mutation when markers are ambiguous across pages", async () => {
    const page1 = Array.from({ length: 99 }, (_, i) =>
      makeComment(i + 1, "filler " + i)
    );
    page1.push(makeComment(100, MARKER + "\nfirst"));
    const page2 = [makeComment(101, MARKER + "\nsecond")];

    const octokit = makePaginatedOctokit([page1, page2]);
    const result = await postMarkedComment(octokit, "org", "repo", 42, "triage", "999:42", "new body");

    expect(result.action).toBe("blocked");
    expect(result.reason).toBe("marker_ambiguous");
    // No PATCH, no POST
    const patchCalls = octokit.request.mock.calls.filter(([m]) => m.includes("PATCH"));
    const postCalls = octokit.request.mock.calls.filter(
      ([m]) => m.includes("POST") && m.includes("/comments")
    );
    expect(patchCalls).toHaveLength(0);
    expect(postCalls).toHaveLength(0);
  });
});
