// tests/evaluation/review-integrity/fixtureOctokit-surface.test.js
// Surface tests proving the executable fixture repository handles the
// actual Octokit route-template form correctly.
//
// These tests are NOT about review behavior — they verify that a future
// v2 reviewer or verifier can actually retrieve fixture data through the
// GitHub API surface.

import { buildFixtureOctokit } from "./fixtureOctokit.js";
import { getAllFixtures } from "./fixtures/registry.js";

// Minimal fixture for surface testing
const TEST_FIXTURE = {
  prMetadata: { head: "headsha123", base: "basesha456", title: "Test PR", body: "Test body", author: "dev" },
  changedFiles: [
    {
      filename: "src/app.js",
      status: "modified",
      additions: 10,
      deletions: 3,
      patch: "--- a/src/app.js\n+++ b/src/app.js\n@@ -1,3 +1,5 @@\n+new line\n",
      headContent: "export function app() { return 'new'; }\n",
      baseContent: "export function app() { return 'old'; }\n",
    },
    {
      filename: "src/utils.js",
      status: "added",
      additions: 5,
      deletions: 0,
      patch: "--- /dev/null\n+++ b/src/utils.js\n@@ -0,0 +1,5 @@\n+export const x = 1;\n",
      headContent: "export const x = 1;\n",
      baseContent: null,
    },
  ],
  contextFiles: [
    {
      path: "config/settings.json",
      sha: "configsha789",
      content: '{"name": "test"}',
      refs: ["headsha123", "basesha456"], // available at both refs
    },
    {
      path: "docs/api.md",
      sha: "docsha012",
      content: "# API Documentation\n",
      refs: ["headsha123"], // only at head
    },
  ],
};

describe("fixtureOctokit surface", () => {
  let octokit;

  beforeEach(() => {
    octokit = buildFixtureOctokit(TEST_FIXTURE, { owner: "org", repo: "repo" });
  });

  // 1. Changed file at head
  it("fetches a changed file's content at head SHA via template route", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "src/app.js", ref: "headsha123" },
    );

    expect(res.data.type).toBe("file");
    expect(res.data.encoding).toBe("base64");
    const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
    expect(decoded).toBe("export function app() { return 'new'; }\n");
  });

  // 2. Changed file at base
  it("fetches a changed file's content at base SHA via template route", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "src/app.js", ref: "basesha456" },
    );

    const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
    expect(decoded).toBe("export function app() { return 'old'; }\n");
  });

  // 3. Unchanged context file (available at both refs)
  it("fetches an unchanged context file at head ref", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "config/settings.json", ref: "headsha123" },
    );

    const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
    expect(decoded).toBe('{"name": "test"}');
  });

  it("fetches the same context file at base ref", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "config/settings.json", ref: "basesha456" },
    );

    const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
    expect(decoded).toBe('{"name": "test"}');
  });

  // 4. Ref-bound context: file only at head, not at base → 404
  it("returns 404 for a context file not available at the requested ref", async () => {
    await expect(
      octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: "org", repo: "repo", path: "docs/api.md", ref: "basesha456" },
      ),
    ).rejects.toThrow("404");
  });

  // 5. Unknown path → 404
  it("returns 404 for an unknown path", async () => {
    await expect(
      octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: "org", repo: "repo", path: "nonexistent.js", ref: "headsha123" },
      ),
    ).rejects.toThrow("404");
  });

  // 6. Paginated PR files
  it("returns changed files via PR files endpoint", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner: "org", repo: "repo", pull_number: 42, per_page: 100 },
    );

    expect(res.data).toHaveLength(2);
    expect(res.data[0].filename).toBe("src/app.js");
    expect(res.data[0].patch).toContain("new line");
    expect(res.data[1].filename).toBe("src/utils.js");
  });

  // 7. Blob retrieval by SHA
  it("retrieves a blob by SHA", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      { owner: "org", repo: "repo", file_sha: "configsha789" },
    );

    const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
    expect(decoded).toBe('{"name": "test"}');
  });

  // 8. Tree listing
  it("lists repository tree at a given SHA", async () => {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner: "org", repo: "repo", tree_sha: "headsha123" },
    );

    expect(res.data.tree).toBeDefined();
    expect(res.data.tree.length).toBeGreaterThan(0);
    const paths = res.data.tree.map(t => t.path);
    expect(paths).toContain("src/app.js");
    expect(paths).toContain("config/settings.json");
  });

  // 9. Call audit
  it("records all calls for audit", async () => {
    await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner: "org", repo: "repo", pull_number: 42 },
    );

    expect(octokit.request.mock.calls).toHaveLength(1);
    expect(octokit.request.mock.calls[0].matchType).toBe("prFiles");
  });
});

// 10. Surface test against REAL historical fixtures (not synthetic)
describe("fixtureOctokit surface — historical fixtures", () => {
  const fixtures = getAllFixtures();

  for (const f of fixtures) {
    it(`${f.caseId} ${f.variant}: serves PR files via template route`, async () => {
      const octokit = buildFixtureOctokit(f);
      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        { owner: "org", repo: "repo", pull_number: 42, per_page: 100 },
      );

      // Must return the exact number of changed files from the snapshot
      expect(res.data).toHaveLength(f.changedFiles.length);
      // Each file must have a filename and patch
      for (const file of res.data) {
        expect(file.filename).toBeDefined();
        expect(typeof file.patch).toBe("string");
      }
    });

    it(`${f.caseId} ${f.variant}: serves changed-file content at head via template route`, async () => {
      const octokit = buildFixtureOctokit(f);
      const firstFile = f.changedFiles[0];

      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: "org", repo: "repo", path: firstFile.filename, ref: f.prMetadata.head },
      );

      expect(res.data.type).toBe("file");
      expect(res.data.encoding).toBe("base64");
      // Content should be decodable
      const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
      expect(decoded.length).toBeGreaterThan(0);
    });

    it(`${f.caseId} ${f.variant}: serves context files at the correct ref`, async () => {
      if (!f.contextFiles || f.contextFiles.length === 0) {
        // No context files in this fixture — skip the content check
        return;
      }
      const octokit = buildFixtureOctokit(f);
      const ctxFile = f.contextFiles[0];
      const ref = (ctxFile.refs || [f.prMetadata.base])[0];

      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: "org", repo: "repo", path: ctxFile.path, ref },
      );

      const decoded = Buffer.from(res.data.content, "base64").toString("utf-8");
      expect(decoded).toBe(ctxFile.content);
    });
  }
});
