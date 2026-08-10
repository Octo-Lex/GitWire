// tests/evaluation/review-integrity/fixtureOctokit.js
// Executable fixture repository surface.
//
// Builds a mock Octokit that serves fixture data through the same GitHub
// API route templates the review pipeline uses. The mock parses Octokit's
// literal route-template form:
//
//   octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path, ref })
//
// and resolves {path} from params, not from regex on the literal template.
//
// Supported operations:
//   GET .../pulls/{n}/files    — paginated PR files
//   GET .../contents/{path}    — file read at a ref (ref-bound context)
//   GET .../contents           — repo root listing
//   GET .../git/blobs/{sha}    — blob retrieval by SHA
//   GET .../git/trees/{sha}    — tree listing (recursive option, ref-sensitive)
//   GET .../search/code        — repository code search (DEFERRED to RI-3, returns empty)
//   POST .../check-runs        — check run create
//   PATCH .../check-runs/{id}  — check run update
//   POST .../reviews           — review mutation
//   GET .../labels             — repo labels
//
// Context files are ref-bound: each contextFile may specify which refs it
// is available at. A request at a different ref returns 404.

/**
 * Build a mock Octokit for a given fixture.
 *
 * @param {object} fixture — a fixture with prMetadata, changedFiles, contextFiles
 * @param {object} opts — { prNumber, owner, repo }
 * @returns {object} { request: fn } where fn has .mock.calls for audit
 */
export function buildFixtureOctokit(fixture, opts = {}) {
  const { prNumber = 42, owner = "org", repo = "repo" } = opts;
  const calls = [];

  // Build content lookup maps.
  // Changed files: head content available at the head SHA, base content at the base SHA.
  // Context files: available at the refs specified in their `refs` array, or at
  // both head and base if no `refs` array is specified.
  const contentIndex = new Map(); // key = `${ref}:${path}` → content string

  const headSha = fixture.prMetadata?.head || "head";
  const baseSha = fixture.prMetadata?.base || "base";

  for (const cf of (fixture.changedFiles || [])) {
    if (cf.headContent) contentIndex.set(headSha + ":" + cf.filename, cf.headContent);
    if (cf.baseContent) contentIndex.set(baseSha + ":" + cf.filename, cf.baseContent);
  }

  for (const cf of (fixture.contextFiles || [])) {
    const refs = cf.refs || [headSha, baseSha];
    for (const ref of refs) {
      contentIndex.set(ref + ":" + cf.path, cf.content);
    }
  }

  // Build blob index (for git/blobs/{sha} — returns raw base64 content)
  // Include both context files AND changed files (head/base blobs)
  const blobIndex = new Map(); // key = sha → { content, encoding }
  for (const cf of (fixture.contextFiles || [])) {
    if (cf.sha) {
      blobIndex.set(cf.sha, { content: Buffer.from(cf.content).toString("base64"), encoding: "base64" });
    }
  }
  for (const cf of (fixture.changedFiles || [])) {
    if (cf.headBlobSha && cf.headContent) {
      blobIndex.set(cf.headBlobSha, { content: Buffer.from(cf.headContent).toString("base64"), encoding: "base64" });
    }
    if (cf.baseBlobSha && cf.baseContent) {
      blobIndex.set(cf.baseBlobSha, { content: Buffer.from(cf.baseContent).toString("base64"), encoding: "base64" });
    }
  }

  // Build tree index (for git/trees/{sha} — returns file list)
  // Trees are ref-sensitive: the head tree includes head-version files,
  // the base tree includes base-version files.
  const treeIndex = new Map(); // key = sha → tree array
  const headTree = [
    ...(fixture.changedFiles || []).filter(f => f.headContent !== null).map(f => ({ path: f.filename, type: "blob", sha: f.headBlobSha, mode: "100644" })),
    ...(fixture.contextFiles || []).filter(f => (f.refs || [headSha, baseSha]).includes(headSha)).map(f => ({ path: f.path, type: "blob", sha: f.sha, mode: "100644" })),
  ];
  const baseTree = [
    ...(fixture.changedFiles || []).filter(f => f.baseContent !== null && f.status !== "added").map(f => ({ path: f.filename, type: "blob", sha: f.baseBlobSha, mode: "100644" })),
    ...(fixture.contextFiles || []).filter(f => (f.refs || [headSha, baseSha]).includes(baseSha)).map(f => ({ path: f.path, type: "blob", sha: f.sha, mode: "100644" })),
  ];
  treeIndex.set(headSha, headTree);
  treeIndex.set(baseSha, baseTree);

  /**
   * Resolve a route template by substituting {param} placeholders from params.
   * "GET /repos/{owner}/{repo}/contents/{path}" with {owner:"o",repo:"r",path:"src/x.js"}
   * → { method: "GET", path: "/repos/o/r/contents/src/x.js" }
   */
  function resolveRoute(route, params) {
    const spaceIdx = route.indexOf(" ");
    const method = route.substring(0, spaceIdx).toUpperCase();
    const template = route.substring(spaceIdx + 1);
    // Replace each {param} with the value from params
    const resolved = template.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
    return { method, path: resolved };
  }

  /**
   * Match a resolved path against known patterns.
   */
  function matchRoute(method, path) {
    // Normalize: remove leading slash, collapse multiple slashes
    const p = path.replace(/^\/+/, "").replace(/\/+/g, "/");

    // GET PR files (paginated)
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/.test(p)) {
      return { type: "prFiles" };
    }

    // GET contents/{path} — file read at ref
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/contents\//.test(p)) {
      const pathMatch = p.match(/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
      return { type: "content", path: decodeURIComponent(pathMatch[1]) };
    }

    // GET contents (repo root listing)
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/contents$/.test(p)) {
      return { type: "rootListing" };
    }

    // GET git/blobs/{sha}
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/git\/blobs\//.test(p)) {
      const shaMatch = p.match(/git\/blobs\/(.+)$/);
      return { type: "blob", sha: decodeURIComponent(shaMatch[1]) };
    }

    // GET git/trees/{sha}
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/git\/trees\//.test(p)) {
      const shaMatch = p.match(/git\/trees\/(.+)$/);
      return { type: "tree", sha: decodeURIComponent(shaMatch[1]) };
    }

    // GET search/code (RI-3+)
    if (method === "GET" && /search\/code/.test(p)) {
      return { type: "searchCode" };
    }

    // POST check-runs
    if (method === "POST" && /repos\/[^/]+\/[^/]+\/check-runs$/.test(p)) {
      return { type: "createCheckRun" };
    }

    // PATCH check-runs/{id}
    if (method === "PATCH" && /repos\/[^/]+\/[^/]+\/check-runs\//.test(p)) {
      return { type: "updateCheckRun" };
    }

    // POST reviews
    if (method === "POST" && /repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(p)) {
      return { type: "postReview" };
    }

    // GET labels
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/labels$/.test(p)) {
      return { type: "labels" };
    }

    // GET issues (for repo context queries)
    if (method === "GET" && /repos\/[^/]+\/[^/]+\/issues/.test(p)) {
      return { type: "issues" };
    }

    return { type: "unknown" };
  }

  const requestFn = function request(route, params) {
    params = params || {};
    const { method, path } = resolveRoute(route, params);
    const match = matchRoute(method, path);
    calls.push({ route, params, method, path, matchType: match.type });

    switch (match.type) {

      case "prFiles": {
        const page = params.page || 1;
        const perPage = params.per_page || 100;
        const allFiles = (fixture.changedFiles || []).map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions || 0,
          deletions: f.deletions || 0,
          patch: f.patch || "",
          sha: "blob_" + f.filename,
        }));
        const start = (page - 1) * perPage;
        const pageData = allFiles.slice(start, start + perPage);
        return Promise.resolve({ data: pageData });
      }

      case "content": {
        const filePath = match.path;
        const ref = params.ref || headSha;
        const key = ref + ":" + filePath;
        if (contentIndex.has(key)) {
          return Promise.resolve({
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(contentIndex.get(key)).toString("base64"),
              path: filePath,
              sha: "blob_" + filePath,
            },
          });
        }
        return Promise.reject(new Error("404 Not Found: " + filePath + " at ref " + ref));
      }

      case "rootListing": {
        const listing = [
          ...(fixture.changedFiles || []).map(f => ({
            name: f.filename.split("/").pop(),
            path: f.filename,
            type: "file",
          })),
          ...(fixture.contextFiles || []).map(f => ({
            name: f.path.split("/").pop(),
            path: f.path,
            type: "file",
          })),
        ];
        return Promise.resolve({ data: listing });
      }

      case "blob": {
        if (blobIndex.has(match.sha)) {
          return Promise.resolve({ data: blobIndex.get(match.sha) });
        }
        return Promise.reject(new Error("404 Blob not found: " + match.sha));
      }

      case "tree": {
        const sha = match.sha;
        const recursive = params.recursive === "1" || params.recursive === 1;
        if (treeIndex.has(sha)) {
          return Promise.resolve({
            data: {
              sha,
              tree: treeIndex.get(sha),
              truncated: false,
            },
          });
        }
        return Promise.reject(new Error("404 Tree not found: " + sha));
      }

      case "searchCode": {
        // Deferred to RI-3 (Context Broker). Returns empty until implemented.
        return Promise.resolve({ data: { total_count: 0, items: [] } });
      }

      case "createCheckRun":
        return Promise.resolve({ data: { id: 12345 } });

      case "updateCheckRun":
        return Promise.resolve({ data: { id: params.check_run_id || 12345 } });

      case "postReview":
        return Promise.resolve({ data: { id: 67890 } });

      case "labels":
        return Promise.resolve({ data: [] });

      case "issues":
        return Promise.resolve({ data: [] });

      default:
        return Promise.resolve({ data: {} });
    }
  };

  // Expose calls for audit
  requestFn.mock = { calls };
  requestFn.calls = calls;
  return { request: requestFn };
}
