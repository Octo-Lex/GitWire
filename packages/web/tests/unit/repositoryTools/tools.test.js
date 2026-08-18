// RepositoryTools v2 primitives (RI-9 amendment, Phase 3/4) — read, grep,
// find, ls behavior over a real materialized session. Includes the
// dirty-worktree and untracked-file immunity properties that make the Git
// object database — not the filesystem — the authority.

import fs from "node:fs";
import path from "node:path";
import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { isAuthoritativeAbsence } from "../../../src/lib/repositoryTools/contract.js";
import { buildSnapshotSource } from "./helpers.js";

const FILES = {
  "README.md": "# title\nsecond line\nthird line\n",
  "src/app.js": "export function main() {\n  return TARGET_TOKEN;\n}\n",
  "src/util.js": "export const helper = () => TARGET_TOKEN;\n",
  "src/deep/nested/thing.md": "nested file with TARGET_TOKEN inside\n",
  "assets/logo.bin": "\u0000\u0001\u0002binary\u0000bytes with TARGET_TOKEN inside\u0000",
  "docs/manual.md": "manual text, no tokens here\n",
};

let session;
let tools;

beforeAll(async () => {
  const head = await buildSnapshotSource(FILES, { ref: "tools-head" });
  session = await prepareRepository({
    invocationId: "tools-suite",
    headSha: "tools-head",
    acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
  });
  tools = createRepositoryTools(session);
});

afterAll(() => {
  session?.close?.();
});

describe("read", () => {
  it("reads the exact tracked blob with identity and completeness", async () => {
    const result = await tools.read({ path: "README.md" });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.content).toBe("# title\nsecond line\nthird line");
    expect(result.data.totalLines).toBe(3);
    expect(result.data.kind).toBe("text");
    expect(result.data.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.data.nextOffset).toBeNull();
  });

  it("returns a partial window with continuation when limit cuts the file", async () => {
    const result = await tools.read({ path: "README.md", offset: 2, limit: 1 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toEqual(["output_lines"]);
    expect(result.data.startLine).toBe(2);
    expect(result.data.endLine).toBe(2);
    expect(result.data.content).toBe("second line");
    expect(result.data.nextOffset).toBe(3);
  });

  it("returns a partial window when the byte cap cuts the file", async () => {
    const result = await tools.read({ path: "README.md", limit: 100, maxBytes: 8 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toEqual(["output_bytes"]);
    expect(result.data.content).toBe("# title");
  });

  it("reports a complete empty slice beyond EOF", async () => {
    const result = await tools.read({ path: "README.md", offset: 99 });
    expect(result.status).toBe("success");
    expect(result.data.content).toBe("");
  });

  it("identifies binaries without serving text content", async () => {
    const result = await tools.read({ path: "assets/logo.bin" });
    expect(result.status).toBe("success");
    expect(result.data.kind).toBe("binary");
    expect(result.data.byteSize).toBeGreaterThan(0);
    expect(result.data.content).toBeUndefined();
  });

  it("fails closed on escape attempts, unknown paths, and directories", async () => {
    expect((await tools.read({ path: "../outside.txt" })).error.code).toBe("E_PATH_ESCAPE");
    expect((await tools.read({ path: "/etc/passwd" })).error.code).toBe("E_PATH_ESCAPE");
    expect((await tools.read({ path: "nope.md" })).error.code).toBe("E_PATH_NOT_FOUND");
    expect((await tools.read({ path: "src" })).error.code).toBe("E_PATH_IS_DIRECTORY");
  });
});

describe("grep", () => {
  it("finds matches across the tracked tree with line numbers", async () => {
    const result = await tools.grep({ pattern: "TARGET_TOKEN" });
    expect(result.status).toBe("success");
    expect(result.data.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/app.js", line: 2 }),
        expect.objectContaining({ path: "src/util.js", line: 1 }),
        expect.objectContaining({ path: "src/deep/nested/thing.md", line: 1 }),
      ])
    );
    // binary blob is skipped as a class, and reported
    expect(result.data.matches.map((m) => m.path)).not.toContain("assets/logo.bin");
    expect(result.data.skippedBinary).toEqual([]);
  });

  it("genuine zero matches is authoritative absence", async () => {
    const result = await tools.grep({ pattern: "ABSOLUTELY_NOT_PRESENT" });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.matches).toEqual([]);
    expect(isAuthoritativeAbsence(result)).toBe(true);
  });

  it("literal mode does not interpret regex metacharacters", async () => {
    const regex = await tools.grep({ pattern: "TARGET_TOKEN" });
    const literal = await tools.grep({ pattern: "main()", literal: true });
    expect(regex.data.matches.length).toBeGreaterThan(0);
    expect(literal.data.matches.map((m) => m.path)).toContain("src/app.js");
  });

  it("ignoreCase matches case-insensitively", async () => {
    const result = await tools.grep({ pattern: "target_token", ignoreCase: true });
    expect(result.data.matches.length).toBeGreaterThanOrEqual(3);
  });

  it("attaches context lines to matches", async () => {
    const result = await tools.grep({ pattern: "return TARGET_TOKEN", context: 1 });
    const match = result.data.matches.find((m) => m.path === "src/app.js");
    expect(match.context).toEqual([
      { line: 1, text: "export function main() {" },
      { line: 3, text: "}" },
    ]);
  });

  it("intersects path scope and glob filter", async () => {
    const result = await tools.grep({ pattern: "TARGET_TOKEN", path: "src", glob: "*.md" });
    expect(result.status).toBe("success");
    expect(result.data.matches.map((m) => m.path)).toEqual(["src/deep/nested/thing.md"]);
  });

  it("scopes to a single file", async () => {
    const result = await tools.grep({ pattern: "TARGET_TOKEN", path: "src/app.js" });
    expect(result.data.matches.map((m) => m.path)).toEqual(["src/app.js"]);
  });

  it("rejects invalid scopes and patterns as envelopes", async () => {
    expect((await tools.grep({ pattern: "x", path: "does/not/exist" })).error.code).toBe("E_SCOPE_INVALID");
    expect((await tools.grep({ pattern: "x", path: "../up" })).error.code).toBe("E_PATH_ESCAPE");
    expect((await tools.grep({ pattern: "a(b" })).error.code).toBe("E_PATTERN_INVALID");
  });

  it("result limit yields partial with matches-so-far", async () => {
    const result = await tools.grep({ pattern: "TARGET_TOKEN", limit: 1 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("result_limit");
    expect(result.data.matches).toHaveLength(1);
  });

  it("output byte cap yields partial output_bytes", async () => {
    const result = await tools.grep({ pattern: "TARGET_TOKEN", maxOutputBytes: 10 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("output_bytes");
  });

  it("pre-aborted signal yields cancelled partial, never success absence", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await tools.grep({ pattern: "TARGET_TOKEN", signal: controller.signal });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("cancelled");
    expect(isAuthoritativeAbsence(result)).toBe(false);
  });
});

describe("find", () => {
  it("lists all tracked paths sorted", async () => {
    const result = await tools.find({});
    expect(result.status).toBe("success");
    expect(result.data.paths).toEqual([...Object.keys(FILES)].sort());
  });

  it("glob without slash matches basenames at any depth", async () => {
    const result = await tools.find({ glob: "*.md" });
    expect(result.data.paths).toEqual(["README.md", "docs/manual.md", "src/deep/nested/thing.md"]);
  });

  it("glob with slash anchors at the repository root", async () => {
    const result = await tools.find({ glob: "src/*.js" });
    expect(result.data.paths).toEqual(["src/app.js", "src/util.js"]);
  });

  it("double-star crosses directories", async () => {
    const result = await tools.find({ glob: "src/**/*.md" });
    expect(result.data.paths).toEqual(["src/deep/nested/thing.md"]);
  });

  it("no glob match is authoritative absence; limits are partial", async () => {
    const none = await tools.find({ glob: "*.nope" });
    expect(none.status).toBe("success");
    expect(isAuthoritativeAbsence(none)).toBe(true);

    const limited = await tools.find({ limit: 2 });
    expect(limited.status).toBe("partial");
    expect(limited.partialReasons).toContain("result_limit");
    expect(limited.data.paths).toHaveLength(2);
    expect(limited.data.totalMatched).toBe(Object.keys(FILES).length);
  });

  it("rejects traversal globs", async () => {
    const result = await tools.find({ glob: "../**" });
    expect(result.error.code).toBe("E_SCOPE_INVALID");
  });
});

describe("ls", () => {
  it("lists the repository root with files and directories", async () => {
    const result = await tools.ls({});
    expect(result.status).toBe("success");
    const names = result.data.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["README.md", "src", "docs", "assets"]));
    const src = result.data.entries.find((e) => e.name === "src");
    expect(src.type).toBe("tree");
  });

  it("lists a subdirectory", async () => {
    const result = await tools.ls({ path: "src" });
    expect(result.data.entries.map((e) => e.name).sort()).toEqual(["app.js", "deep", "util.js"]);
  });

  it("normalizes trailing slashes and rejects escapes", async () => {
    const result = await tools.ls({ path: "src/" });
    expect(result.status).toBe("success");
    expect((await tools.ls({ path: "src/app.js" })).error.code).toBe("E_PATH_IS_FILE");
    expect((await tools.ls({ path: "nope" })).error.code).toBe("E_PATH_NOT_FOUND");
    expect((await tools.ls({ path: ".." })).error.code).toBe("E_PATH_ESCAPE");
  });

  it("limit truncates with partial semantics", async () => {
    const result = await tools.ls({ path: "src", limit: 1 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("result_limit");
    expect(result.data.entries).toHaveLength(1);
    expect(result.data.totalEntries).toBe(3);
  });
});

describe("immutable HEAD authority (the core correction)", () => {
  it("a dirty worktree cannot change read or grep truth", async () => {
    const appPath = path.join(session.workDir, "src", "app.js");
    fs.writeFileSync(appPath, "DIRTIED: TARGET_TOKEN removed\n");

    const readResult = await tools.read({ path: "src/app.js" });
    expect(readResult.data.content).toContain("TARGET_TOKEN");

    const grepResult = await tools.grep({ pattern: "TARGET_TOKEN", path: "src/app.js" });
    expect(grepResult.data.matches.map((m) => m.line)).toEqual([2]);

    fs.writeFileSync(appPath, FILES["src/app.js"]);
  });

  it("an untracked file cannot inject matches or paths", async () => {
    const untracked = path.join(session.workDir, "untracked-inject.js");
    fs.writeFileSync(untracked, "export const x = TARGET_TOKEN;\n");

    const grepResult = await tools.grep({ pattern: "TARGET_TOKEN" });
    expect(grepResult.data.matches.map((m) => m.path)).not.toContain("untracked-inject.js");

    const findResult = await tools.find({});
    expect(findResult.data.paths).not.toContain("untracked-inject.js");

    fs.rmSync(untracked, { force: true });
  });

  it("every result names the immutable headSha it is bound to", async () => {
    for (const result of [
      await tools.read({ path: "README.md" }),
      await tools.grep({ pattern: "TARGET_TOKEN" }),
      await tools.find({}),
      await tools.ls({}),
    ]) {
      expect(result.headSha).toBe(session.headSha);
    }
  });
});
