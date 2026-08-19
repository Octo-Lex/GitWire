// Repository-instrument qualification — synthetic adversarial suite
// (RI-9 amendment, Phase 5).
//
// Pathological repositories built with real git, probing the classes that
// killed the previous instrument: oversized binaries before targets, huge
// files, UTF-8 multibyte content, every overflow/abort mode, escape
// attempts, untracked/dirty worktrees, and genuine absence. Deterministic:
// no LLM, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { isAuthoritativeAbsence } from "../../../src/lib/repositoryTools/contract.js";
import { buildSnapshotSource, makeOriginRepo } from "../../unit/repositoryTools/helpers.js";

let session;
let tools;

function buildAdversarialFiles() {
  const files = {};

  // 1. Large binary that sorts BEFORE every source file, seeded with the
  //    needle inside its bytes (the banner.png failure class).
  const bigBinary = Buffer.alloc(5 * 1024 * 1024);
  for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = (i * 31) & 0xff;
  bigBinary.write("NEEDLE_IN_BINARY", 1024 * 1024, "latin1");
  files["aaa-huge-banner.bin"] = bigBinary.toString("latin1");

  // 2. Many smaller binaries, also seeded. NUL bytes make them genuinely
  //    binary to `git grep -I` (no NUL ⇒ a text file, however "binary" the
  //    extension looks).
  for (let i = 0; i < 50; i++) {
    const b = Buffer.alloc(2048);
    for (let j = 0; j < b.length; j++) {
      b[j] = j % 64 === 0 ? 0x00 : 0x41 + ((i + j) % 26);
    }
    b.write("NEEDLE_IN_BINARY", 512, "latin1");
    files[`binaries/blob-${String(i).padStart(3, "0")}.bin`] = b.toString("latin1");
  }

  // 3. Huge source file with the needle only at the very end.
  const hugeLines = [];
  for (let i = 1; i <= 60000; i++) hugeLines.push(`line ${i} of the huge file: filler content`);
  hugeLines.push("export const HUGE_NEEDLE = 'the needle at the very end';");
  files["src/generated/huge.js"] = hugeLines.join("\n") + "\n";

  // 4. UTF-8 multibyte content.
  files["src/unicode.js"] =
    "// 汉字注释 with emoji 🔧 and combining é\n" +
    "export const MULTIBYTE_NEEDLE_汉 = '値';\n" +
    "const tail = '结束';\n";

  // 5. Needle spread across many files for result-overflow probing.
  for (let i = 0; i < 30; i++) {
    files[`overflow/file-${String(i).padStart(2, "0")}.txt`] = `entry ${i}\nOVERFLOW_NEEDLE here\n`;
  }

  // 6. Ordinary targets.
  files["src/late.js"] = "// a late source file after all the binaries\nexport const LATE_NEEDLE = 1;\n";
  files["README.md"] = "# adversarial fixture\n";

  return files;
}

beforeAll(async () => {
  const head = await buildSnapshotSource(buildAdversarialFiles(), { ref: "adversarial" });
  session = await prepareRepository({
    invocationId: "ri-qual-adversarial",
    headSha: "adversarial",
    acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
  });
  tools = createRepositoryTools(session);
}, 180000);

afterAll(() => {
  session?.close?.();
});

describe("the banner.png failure class is structurally eliminated", () => {
  it("a 5MB binary before the target does not hide a later match — and absence stays provable", async () => {
    const hit = await tools.grep({ pattern: "LATE_NEEDLE" });
    expect(hit.status).toBe("success");
    expect(hit.complete).toBe(true);
    expect(hit.data.matches.map((m) => m.path)).toEqual(["src/late.js"]);

    const absent = await tools.grep({ pattern: "NEVER_PRESENT_ANYWHERE" });
    expect(isAuthoritativeAbsence(absent)).toBe(true);
  });

  it("fifty seeded binaries are skipped as a class and reported", async () => {
    const result = await tools.grep({ pattern: "NEEDLE_IN_BINARY" });
    expect(result.status).toBe("success");
    expect(result.data.matches).toEqual([]);
    expect(isAuthoritativeAbsence(result)).toBe(true);
  });
});

describe("huge source files", () => {
  it("grep finds the needle at the very end of a 60K-line file", async () => {
    const result = await tools.grep({ pattern: "HUGE_NEEDLE", path: "src/generated/huge.js" });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0].line).toBe(60001);
  });

  it("read windows with continuation cover the whole file", async () => {
    const first = await tools.read({ path: "src/generated/huge.js", offset: 1, limit: 100 });
    expect(first.status).toBe("partial");
    expect(first.data.truncation.totalLines).toBe(60001);
    expect(first.data.nextOffset).toBe(101);

    const last = await tools.read({ path: "src/generated/huge.js", offset: 60001, limit: 10 });
    expect(last.status).toBe("success");
    expect(last.data.content).toContain("HUGE_NEEDLE");
  });
});

describe("UTF-8 multibyte content", () => {
  it("read accounts bytes correctly and never splits inside a codepoint line", async () => {
    const result = await tools.read({ path: "src/unicode.js" });
    expect(result.status).toBe("success");
    expect(result.data.content).toContain("MULTIBYTE_NEEDLE_汉");
    expect(result.data.truncation.outputBytes).toBeGreaterThan(0);
  });

  it("grep matches multibyte patterns", async () => {
    const result = await tools.grep({ pattern: "漢字|汉字", path: "src/unicode.js" });
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0].line).toBe(1);
  });
});

describe("overflow modes stay partial", () => {
  it("result overflow: limit 5 of 30 matches → partial with matches-so-far", async () => {
    const result = await tools.grep({ pattern: "OVERFLOW_NEEDLE", limit: 5 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("result_limit");
    expect(result.data.matches).toHaveLength(5);
    expect(result.data.droppedMatches).toBe(25);
    expect(result.data.truncatedBy).toBe("result_limit");
  });

  it("output overflow: a tiny byte cap → partial output_bytes", async () => {
    const result = await tools.grep({ pattern: "OVERFLOW_NEEDLE", maxOutputBytes: 20 });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("output_bytes");
    expect(result.data.matches.length).toBeLessThan(30);
  });
});

describe("timeout and cancellation can never manufacture absence", () => {
  it("a 1ms timeout over a heavy repo is NEVER a successful empty search", async () => {
    const result = await tools.grep({ pattern: "filler content", timeoutMs: 1 });
    expect(result.status).not.toBe("success");
    expect(result.complete).toBe(false);
    expect(result.partialReasons).toContain("timeout");
    expect(isAuthoritativeAbsence(result)).toBe(false);
  });

  it("mid-flight cancellation is partial with the cancelled reason", async () => {
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    const result = await tools.grep({ pattern: "filler content", signal: controller.signal });
    expect(result.status === "partial" || result.status === "success").toBe(true);
    if (result.status === "success") {
      // finished before the abort landed — then it must genuinely be complete
      expect(result.complete).toBe(true);
    } else {
      expect(result.partialReasons).toContain("cancelled");
      expect(isAuthoritativeAbsence(result)).toBe(false);
    }
  });

  it("a pre-aborted signal is always cancelled-partial", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await tools.grep({ pattern: "LATE_NEEDLE", signal: controller.signal });
    expect(result.status).toBe("partial");
    expect(result.partialReasons).toContain("cancelled");
  });
});

describe("escape attempts are rejected by every tool", () => {
  it.each([
    ["read", (t) => t.read({ path: "../escape.txt" })],
    ["read", (t) => t.read({ path: "/etc/passwd" })],
    ["read", (t) => t.read({ path: "C:/windows/win.ini" })],
    ["grep", (t) => t.grep({ pattern: "x", path: "src/../../out" })],
    ["grep", (t) => t.grep({ pattern: "x", glob: "../**" })],
    ["find", (t) => t.find({ glob: "../*" })],
    ["ls", (t) => t.ls({ path: ".." })],
    ["ls", (t) => t.ls({ path: "src/../../../etc" })],
  ])("%s rejects escape %s", async (_tool, call) => {
    const result = await call(tools);
    expect(result.status).toBe("error");
    expect(["E_PATH_ESCAPE", "E_SCOPE_INVALID"]).toContain(result.error.code);
  });
});

describe("untracked files and dirty worktrees cannot change truth", () => {
  it("an untracked file containing the needle is invisible to grep and find", async () => {
    fs.writeFileSync(path.join(session.workDir, "src", "untracked-inject.js"), "export const LATE_NEEDLE = 'fake';\n");
    const grepResult = await tools.grep({ pattern: "LATE_NEEDLE" });
    expect(grepResult.data.matches.map((m) => m.path)).toEqual(["src/late.js"]);
    const findResult = await tools.find({ glob: "*.js" });
    expect(findResult.data.paths).not.toContain("src/untracked-inject.js");
    fs.rmSync(path.join(session.workDir, "src", "untracked-inject.js"), { force: true });
  });

  it("a dirtied tracked file still serves HEAD truth", async () => {
    const target = path.join(session.workDir, "src", "late.js");
    fs.writeFileSync(target, "GARBAGE: needle removed\n");
    const readResult = await tools.read({ path: "src/late.js" });
    expect(readResult.data.content).toContain("LATE_NEEDLE");
    fs.writeFileSync(target, "// a late source file after all the binaries\nexport const LATE_NEEDLE = 1;\n");
  });
});

describe("genuine zero-match search", () => {
  it("is authoritative absence — never an error, never partial", async () => {
    const result = await tools.grep({ pattern: "THIS_SYMBOL_DOES_NOT_EXIST_ANYWHERE" });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.matches).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(isAuthoritativeAbsence(result)).toBe(true);
  });
});

// Symlink probes need an origin repository that actually contains a symlink
// entry (mode 120000). Snapshot acquisition cannot express symlinks, and
// Windows without developer mode cannot materialize them during checkout —
// on such hosts the probe skips VISIBLY and must be run on the Linux
// executor before instrument sign-off.
function canCreateSymlinks() {
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwire-sym-probe-"));
    fs.symlinkSync(".", path.join(dir, "link"), "dir");
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const symlinkDescribe = canCreateSymlinks() ? describe : describe.skip;

symlinkDescribe("symlink entries are identified, never followed out of the tree", () => {
  let symSession;
  let symTools;
  let origin;

  beforeAll(async () => {
    // Build an origin whose HEAD contains a committed symlink pointing at a
    // path OUTSIDE the repository tree.
    origin = makeOriginRepo([{ "real.txt": "SYMLINK_SENTINEL\n" }]);
    const linkPath = path.join(origin.dir, "outside-link");
    fs.symlinkSync("..", linkPath, "dir");
    const { spawnSync } = await import("node:child_process");
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Origin", GIT_AUTHOR_EMAIL: "origin@test.invalid",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:01+00:00",
      GIT_COMMITTER_NAME: "Test Origin", GIT_COMMITTER_EMAIL: "origin@test.invalid",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:01+00:00",
    };
    const add = spawnSync("git", ["add", "outside-link"], { cwd: origin.dir, env, encoding: "utf8" });
    const commit = spawnSync("git", ["commit", "-q", "-m", "symlink commit"], { cwd: origin.dir, env, encoding: "utf8" });
    if (add.status !== 0 || commit.status !== 0) {
      throw new Error(`symlink origin setup failed: ${add.stderr || commit.stderr}`);
    }
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: origin.dir, env, encoding: "utf8" }).stdout.trim();

    symSession = await prepareRepository({
      invocationId: "ri-qual-symlink",
      headSha,
      acquire: { mode: "remote", url: `file://${origin.dir.replaceAll("\\", "/")}` },
    });
    symTools = createRepositoryTools(symSession);
  }, 120000);

  afterAll(() => {
    symSession?.close?.();
    origin?.cleanup?.();
  });

  it("read reports kind=symlink with the target instead of following it", async () => {
    const result = await symTools.read({ path: "outside-link" });
    expect(result.status).toBe("success");
    expect(result.data.kind).toBe("symlink");
    expect(result.data.target).toBe("..");
  });

  it("ls exposes the symlink entry with its mode", async () => {
    const result = await symTools.ls({ path: "." });
    const entry = result.data.entries.find((e) => e.name === "outside-link");
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("symlink");
    expect(entry.mode).toBe("120000");
  });

  it("grep cannot escape through the symlink — matches stay inside tracked content", async () => {
    const result = await symTools.grep({ pattern: "SYMLINK_SENTINEL" });
    expect(result.status).toBe("success");
    expect(result.data.matches.map((m) => m.path)).toEqual(["real.txt"]);
  });
});
