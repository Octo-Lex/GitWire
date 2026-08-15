// RepositorySession (RI-9 amendment Phase 1) — acquisition, identity, and
// lifecycle tests. Runs real git; no network, no models.

import fs from "node:fs";
import path from "node:path";
import { prepareRepository, validateRepoPath, RepositorySessionError } from "../../../src/lib/repositoryTools/repositorySession.js";
import { buildSnapshotSource, makeOriginRepo, listFilesRecursive } from "./helpers.js";

const FILES = {
  "README.md": "# test\nline2\nline3\n",
  "src/app.js": "export function main() {\n  return 42;\n}\n",
  "docs/guide.md": "guide\n",
};

describe("validateRepoPath", () => {
  it("accepts repository-relative paths", () => {
    expect(validateRepoPath("src/app.js")).toBe("src/app.js");
    expect(validateRepoPath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("accepts the root dot only when explicitly allowed", () => {
    expect(validateRepoPath(".", { allowDot: true })).toBe(".");
    expect(() => validateRepoPath(".")).toThrow(RepositorySessionError);
  });

  it.each([
    "/etc/passwd",
    "C:/windows/system32",
    "src/../../escape.js",
    "../escape",
    "..\\escape",
    "src//double",
    "src/./here",
    "",
  ])("rejects escape attempt %j", (bad) => {
    expect(() => validateRepoPath(bad)).toThrow(RepositorySessionError);
  });
});

describe("prepareRepository (snapshot mode)", () => {
  let session;

  afterEach(() => {
    session?.close?.();
    session = null;
  });

  it("materializes a faithful tree at a full-sha HEAD with a clean worktree", async () => {
    const head = await buildSnapshotSource(FILES, { ref: "head-ref" });
    const base = await buildSnapshotSource({ "README.md": "# old\n" }, { ref: "base-ref" });
    session = await prepareRepository({
      invocationId: "test-invocation-1",
      repository: "local/test",
      headSha: "head-ref",
      baseSha: "base-ref",
      acquire: { mode: "snapshot", baseTree: base, headTree: head, blobs: { ...base.blobs, ...head.blobs } },
    });

    expect(session.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(session.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(session.baseSha).not.toBe(session.headSha);
    expect(session.identityReport.checked).toBe(3);
    expect(session.identityReport.faithful).toEqual(
      expect.arrayContaining(["README.md", "src/app.js", "docs/guide.md"])
    );
    expect(session.identityReport.divergent).toEqual([]);
    await expect(session.assertCleanWorktree()).resolves.toBeUndefined();
  });

  it("materializes HEAD content, not the base content", async () => {
    const head = await buildSnapshotSource({ "README.md": "NEW\n" }, { ref: "h" });
    const base = await buildSnapshotSource({ "README.md": "OLD\n", "gone.txt": "bye\n" }, { ref: "b" });
    session = await prepareRepository({
      invocationId: "test-invocation-2",
      headSha: "h",
      acquire: { mode: "snapshot", baseTree: base, headTree: head, blobs: { ...base.blobs, ...head.blobs } },
    });
    expect(fs.readFileSync(path.join(session.workDir, "README.md"), "utf8")).toBe("NEW\n");
    expect(fs.existsSync(path.join(session.workDir, "gone.txt"))).toBe(false);
  });

  it("is deterministic — the same snapshot materializes to the same HEAD sha", async () => {
    const head = await buildSnapshotSource(FILES, { ref: "det" });
    const a = await prepareRepository({
      invocationId: "det-1",
      headSha: "det",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    const b = await prepareRepository({
      invocationId: "det-2",
      headSha: "det",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    expect(a.headSha).toBe(b.headSha);
    a.close();
    b.close();
  });

  it("records a divergence ledger for entries whose recorded sha does not match", async () => {
    const head = await buildSnapshotSource(
      { "a.txt": "plain text\n", "b.bin": "\u0000\uFFFD binary-ish\n" },
      { ref: "div", shaOverrides: { "a.txt": "deadbeef".repeat(5), "b.bin": "feedface".repeat(5) } }
    );
    session = await prepareRepository({
      invocationId: "div-1",
      headSha: "div",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    const byPath = Object.fromEntries(session.identityReport.divergent.map((d) => [d.path, d]));
    expect(byPath["a.txt"].kind).toBe("text");
    expect(byPath["b.bin"].kind).toBe("binary");
    expect(session.unfaithfulPaths()).toEqual(["a.txt", "b.bin"]);
  });

  it("fails closed on a snapshot gap (blob missing from the store)", async () => {
    const head = await buildSnapshotSource(FILES, { ref: "gap" });
    const missing = head.tree[0].sha;
    const blobs = { ...head.blobs };
    delete blobs[missing];
    await expect(
      prepareRepository({
        invocationId: "gap-1",
        headSha: "gap",
        acquire: { mode: "snapshot", headTree: head, blobs },
      })
    ).rejects.toMatchObject({ code: "E_SNAPSHOT_GAP" });
  });

  it("rejects a snapshot entry with a traversal path", async () => {
    const head = await buildSnapshotSource({ "ok.txt": "fine\n" }, { ref: "esc" });
    head.tree.push({ path: "../outside.txt", sha: head.tree[0].sha, size: 5 });
    await expect(
      prepareRepository({
        invocationId: "esc-1",
        headSha: "esc",
        acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
      })
    ).rejects.toMatchObject({ code: "E_PATH_ESCAPE" });
  });

  it("rejects invalid invocation ids and missing inputs", async () => {
    await expect(prepareRepository(null)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(
      prepareRepository({ invocationId: "bad id!", headSha: "x", acquire: { mode: "snapshot" } })
    ).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });
});

describe("prepareRepository (remote mode)", () => {
  let origin;
  let session;

  afterEach(() => {
    session?.close?.();
    session = null;
    origin?.cleanup?.();
    origin = null;
  });

  it("fetches the exact requested HEAD and proves identity", async () => {
    origin = makeOriginRepo([{ "one.txt": "one\n" }, { "one.txt": "one\n", "two.txt": "two\n" }]);
    const headSha = origin.shas[origin.shas.length - 1];
    session = await prepareRepository({
      invocationId: "remote-1",
      repository: "test/origin",
      headSha,
      baseSha: origin.shas[0],
      acquire: { mode: "remote", url: `file://${origin.dir.replaceAll("\\", "/")}` },
    });
    expect(session.headSha).toBe(headSha);
    expect(fs.readFileSync(path.join(session.workDir, "two.txt"), "utf8")).toBe("two\n");
    await expect(session.assertCleanWorktree()).resolves.toBeUndefined();
  });

  it("fails closed when the requested sha is not the commit (annotated tag peels elsewhere)", async () => {
    origin = makeOriginRepo([{ "a.txt": "a\n" }]);
    expect(origin.tagSha).not.toBe(origin.shas[0]);
    await expect(
      prepareRepository({
        invocationId: "remote-2",
        headSha: origin.tagSha,
        acquire: { mode: "remote", url: `file://${origin.dir.replaceAll("\\", "/")}` },
      })
    ).rejects.toMatchObject({ code: "E_IDENTITY_MISMATCH" });
  });

  it("requires a full 40-hex headSha", async () => {
    await expect(
      prepareRepository({
        invocationId: "remote-3",
        headSha: "624732c",
        acquire: { mode: "remote", url: "file:///nowhere" },
      })
    ).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("never persists the acquisition credential anywhere in the session", async () => {
    origin = makeOriginRepo([{ "sec.txt": "s\n" }]);
    const SECRET = "Authorization: Basic c2VjcmV0LXRva2Vu";
    session = await prepareRepository({
      invocationId: "remote-4",
      headSha: origin.shas[0],
      acquire: {
        mode: "remote",
        url: `file://${origin.dir.replaceAll("\\", "/")}`,
        readCredential: { header: SECRET },
      },
    });
    expect(JSON.stringify(session)).not.toContain("c2VjcmV0LXRva2Vu");
    for (const file of listFilesRecursive(session.root)) {
      expect(fs.readFileSync(file, "utf8")).not.toContain("c2VjcmV0LXRva2Vu");
    }
    const config = await session.run(["config", "--list", "--show-origin"]);
    expect(config.stdout.toString("utf8")).not.toContain("extraheader");
  });
});

describe("session lifecycle", () => {
  it("rejects operations after close and close is idempotent", async () => {
    const head = await buildSnapshotSource({ "x.txt": "x\n" }, { ref: "l" });
    const session = await prepareRepository({
      invocationId: "life-1",
      headSha: "l",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    const root = session.root;
    await expect(session.run(["rev-parse", "HEAD"])).resolves.toHaveProperty("code", 0);
    session.close();
    expect(fs.existsSync(root)).toBe(false);
    await expect(session.run(["rev-parse", "HEAD"])).rejects.toMatchObject({ code: "E_SESSION_CLOSED" });
    expect(() => session.recordOperation({ operation: "read" })).toThrow(RepositorySessionError);
    expect(() => session.close()).not.toThrow();
  });

  it("records an audit trace of operations", async () => {
    const head = await buildSnapshotSource({ "x.txt": "x\n" }, { ref: "t" });
    const session = await prepareRepository({
      invocationId: "life-2",
      headSha: "t",
      acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
    });
    session.recordOperation({ operation: "read", path: "x.txt", status: "success" });
    const trace = session.auditTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ operation: "read", path: "x.txt", status: "success" });
    expect(trace[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    session.close();
  });
});
