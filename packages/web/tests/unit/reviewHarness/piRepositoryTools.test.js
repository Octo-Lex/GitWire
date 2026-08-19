// Pi repository-tool adapter (RI-9 Phase 8, Commit 3) — the qualified
// RepositoryTools v2 surface exposed to the harness model with contract
// distinctions preserved and internals redacted.

import { prepareRepository } from "../../../src/lib/repositoryTools/repositorySession.js";
import { createPiRepositoryTools } from "../../../src/lib/reviewHarness/pi/piRepositoryTools.js";
import { buildSnapshotSource } from "../repositoryTools/helpers.js";

const FILES = {
  "README.md": "# t\nsecond\nthird\n",
  "src/app.js": "export function main() {\n  return NEEDLE;\n}\n",
  "docs/guide.md": "guide without the needle\n",
};

let repositorySession;
let tools;
let repositoryTools;

beforeAll(async () => {
  const head = await buildSnapshotSource(FILES, { ref: "pi-tools" });
  repositorySession = await prepareRepository({
    invocationId: "pi-tools-test",
    headSha: "pi-tools",
    acquire: { mode: "snapshot", headTree: head, blobs: head.blobs },
  });
  ({ tools, repositoryTools } = createPiRepositoryTools({ repositorySession }));
});

afterAll(() => {
  repositorySession?.close?.();
});

async function callPresented(tool, params) {
  const result = await tool.execute("call-test", params);
  return JSON.parse(result.content[0].text);
}

describe("tool surface", () => {
  it("exposes exactly read/grep/find/ls with no mutation tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("read presents the envelope with identity, completeness, and content", async () => {
    const presented = await callPresented(tools.find((t) => t.name === "read"), { path: "README.md" });
    expect(presented.status).toBe("success");
    expect(presented.complete).toBe(true);
    expect(presented.data.content).toBe("# t\nsecond\nthird");
    expect(presented.data.blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(presented.headSha).toBe(repositorySession.headSha);
  });

  it("PARTIAL stays partial with reasons — never presented as complete", async () => {
    const presented = await callPresented(tools.find((t) => t.name === "read"), { path: "README.md", limit: 1 });
    expect(presented.status).toBe("partial");
    expect(presented.complete).toBe(false);
    expect(presented.partialReasons).toEqual(["output_lines"]);
    expect(presented.data.nextOffset).toBe(2);
  });

  it("ERROR stays error with its code — never an empty success", async () => {
    const presented = await callPresented(tools.find((t) => t.name === "read"), { path: "../escape" });
    expect(presented.status).toBe("error");
    expect(presented.complete).toBe(false);
    expect(presented.error.code).toBe("E_PATH_ESCAPE");
    expect(presented.data).toBeUndefined();
  });

  it("grep zero-match complete=true is presented as authoritative absence", async () => {
    const presented = await callPresented(tools.find((t) => t.name === "grep"), { pattern: "NOT_PRESENT", literal: true });
    expect(presented.status).toBe("success");
    expect(presented.complete).toBe(true);
    expect(presented.data.matches).toEqual([]);
  });

  it("find and ls operate over tracked truth", async () => {
    const found = await callPresented(tools.find((t) => t.name === "find"), { glob: "*.js" });
    expect(found.data.paths).toEqual(["src/app.js"]);
    const listed = await callPresented(tools.find((t) => t.name === "ls"), { path: "src" });
    expect(listed.data.entries.map((e) => e.name)).toEqual(["app.js"]);
  });
});

describe("redaction — what the model must never see", () => {
  it.each(["read", "grep", "find", "ls"])("%s output carries no session id, root path, or credential", async (name) => {
    const params = {
      read: { path: "README.md" },
      grep: { pattern: "NEEDLE" },
      find: {},
      ls: {},
    }[name];
    const tool = tools.find((t) => t.name === name);
    const result = await tool.execute("call-redact", params);
    const text = result.content[0].text;
    expect(text).not.toContain(repositorySession.id);
    expect(text).not.toContain(repositorySession.root.replaceAll("\\", "/"));
    expect(text).not.toContain(repositorySession.root);
    expect(text.toLowerCase()).not.toContain("credential");
    expect(text).not.toContain("apiKey");
  });
});

describe("audit trace — every adapter call is still recorded", () => {
  it("grows the repository session audit trace with each tool call", async () => {
    const before = repositorySession.auditTrace().length;
    await repositoryTools.grep({ pattern: "NEEDLE" });
    await repositoryTools.find({});
    const trace = repositorySession.auditTrace();
    expect(trace).toHaveLength(before + 2);
    expect(trace.at(-2)).toMatchObject({ operation: "grep", status: "success", complete: true });
    expect(trace.at(-1)).toMatchObject({ operation: "find", status: "success" });
  });
});
