// tests/evaluation/review-integrity/fixtureOctokit.js
// Executable fixture repository surface.
//
// Builds an Octokit mock that serves fixture data through the same GitHub
// API calls the review pipeline uses: paginated PR files, file reads at
// base/head, content/blob retrieval, and repository search. A fixture's
// contextFiles are served as repository contents — they are not inert data.

/**
 * Build a mock Octokit for a given fixture.
 *
 * Supported operations:
 *   GET /repos/{owner}/{repo}/pulls/{pull_number}/files  — paginated PR files
 *   GET /repos/{owner}/{repo}/contents/{path}?ref={sha}  — file read at ref
 *   POST /repos/{owner}/{repo}/check-runs                 — check run create
 *   PATCH /repos/{owner}/{repo}/check-runs/{check_run_id} — check run update
 *   POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews — review mutation
 *   GET /repos/{owner}/{repo}/git/trees/{tree_sha}        — tree listing
 *
 * Records all calls for audit.
 *
 * @param {object} fixture — a fixture from registry.js
 * @param {object} opts — { prNumber, owner, repo }
 * @returns {object} mock octokit with .request method and .mock.calls audit
 */
export function buildFixtureOctokit(fixture, opts = {}) {
  const { prNumber = 42, owner = "org", repo = "repo" } = opts;
  const calls = [];

  // Build a map of context files for content lookup
  const contextMap = new Map();
  for (const cf of (fixture.contextFiles || [])) {
    contextMap.set(cf.path, cf);
  }

  // Build changed-file content maps for base/head reads
  const headContentMap = new Map();
  const baseContentMap = new Map();
  for (const cf of fixture.changedFiles) {
    if (cf.headContent) headContentMap.set(cf.filename, cf.headContent);
    if (cf.baseContent) baseContentMap.set(cf.filename, cf.baseContent);
  }

  const mockRequest = function mockFn(method, params) {
    calls.push({ method, params });

    // GET PR files (paginated)
    if (method.includes("GET") && method.includes("/pulls/") && method.includes("/files")) {
      const page = params.page || 1;
      const perPage = params.per_page || 100;
      const allFiles = fixture.changedFiles.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
        sha: "headsha_" + f.filename,
        contents_url: `https://api.github.com/repos/${owner}/${repo}/contents/${f.filename}?ref=head`,
      }));
      const start = (page - 1) * perPage;
      const pageData = allFiles.slice(start, start + perPage);
      return Promise.resolve({ data: pageData });
    }

    // GET file contents at a ref
    if (method.includes("GET") && method.includes("/contents/")) {
      const path = method.match(/\/contents\/(.+?)(?:\?|$)/)?.[1] || params.path || "";
      const ref = params.ref || "head";

      // Check changed files first (head or base content)
      if (ref === "head" || ref === fixture.prMetadata?.head) {
        if (headContentMap.has(path)) {
          return Promise.resolve({ data: { content: Buffer.from(headContentMap.get(path)).toString("base64"), encoding: "base64" } });
        }
      }
      if (ref === "base" || ref === fixture.prMetadata?.base) {
        if (baseContentMap.has(path)) {
          return Promise.resolve({ data: { content: Buffer.from(baseContentMap.get(path)).toString("base64"), encoding: "base64" } });
        }
      }

      // Check context files (available at any ref)
      if (contextMap.has(path)) {
        return Promise.resolve({ data: { content: Buffer.from(contextMap.get(path).content).toString("base64"), encoding: "base64" } });
      }

      return Promise.reject(new Error("404 Not Found: " + path));
    }

    // GET contents without explicit path (repo root listing)
    if (method.includes("GET") && method.includes("/contents") && !method.includes("/contents/")) {
      const allPaths = [
        ...fixture.changedFiles.map((f) => ({ name: f.filename.split("/").pop(), path: f.filename, type: "file" })),
        ...(fixture.contextFiles || []).map((f) => ({ name: f.path.split("/").pop(), path: f.path, type: "file" })),
      ];
      return Promise.resolve({ data: allPaths });
    }

    // POST check-run
    if (method.includes("POST") && method.includes("check-runs")) {
      return Promise.resolve({ data: { id: 12345 } });
    }

    // PATCH check-run
    if (method.includes("PATCH") && method.includes("check-runs")) {
      return Promise.resolve({ data: { id: params.check_run_id || 12345 } });
    }

    // POST review
    if (method.includes("POST") && method.includes("/reviews")) {
      return Promise.resolve({ data: { id: 67890 } });
    }

    // GET labels
    if (method.includes("GET") && method.includes("/labels")) {
      return Promise.resolve({ data: [] });
    }

    // GET issues (for repo context)
    if (method.includes("GET") && method.includes("/issues")) {
      return Promise.resolve({ data: [] });
    }

    // GET tree
    if (method.includes("GET") && method.includes("/git/trees")) {
      return Promise.resolve({ data: { tree: [] } });
    }

    // Default
    return Promise.resolve({ data: {} });
  };

  // Attach calls for audit — compatible with both jest.fn() and plain function
  mockRequest.calls = calls;
  // Also expose as .mock.calls for Jest assertion compatibility
  mockRequest.mock = { calls };
  return { request: mockRequest };
}
