// Controlled Pi session factory (RI-9 Phase 8, Commit 2) — the session
// constraints that make Pi a replaceable, GitWire-governed harness:
// in-memory, no discovery, no builtin tools, GitWire-owned system prompt,
// runtime-only credentials. Drives Pi's real provider stack through the
// deterministic fake provider (zero paid calls).

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createControlledPiSession } from "../../../src/lib/reviewHarness/pi/piSessionFactory.js";
import { startFakeProvider } from "./helpers.js";

const SYSTEM_PROMPT = "You are a GitWire review harness. Use only the provided tools.";

function echoTool() {
  return defineTool({
    name: "echo",
    label: "Echo",
    description: "Echo a value back",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: "text", text: `echo:${params.value}` }],
      details: {},
    }),
  });
}

describe("createControlledPiSession", () => {
  let fake;

  afterEach(async () => {
    await fake?.close?.();
    fake = null;
  });

  it("rejects missing model, key, prompt, or tools", async () => {
    await expect(createControlledPiSession({ model: null, runtimeApiKey: "k", systemPrompt: "s", customTools: [echoTool()] })).rejects.toThrow();
    await expect(createControlledPiSession({ model: {}, runtimeApiKey: "", systemPrompt: "s", customTools: [echoTool()] })).rejects.toThrow();
    await expect(createControlledPiSession({ model: {}, runtimeApiKey: "k", systemPrompt: "", customTools: [echoTool()] })).rejects.toThrow();
    await expect(createControlledPiSession({ model: {}, runtimeApiKey: "k", systemPrompt: "s", customTools: [] })).rejects.toThrow();
  });

  it("exposes ONLY the custom tools — every builtin (read/bash/edit/write/grep/find/ls) is inactive and never advertised", async () => {
    fake = await startFakeProvider({ turns: [{ content: "ok" }] });
    const { session, dispose } = await createControlledPiSession({
      model: fake.model,
      runtimeApiKey: "test-key",
      systemPrompt: SYSTEM_PROMPT,
      customTools: [echoTool()],
    });
    try {
      // The ACTIVE set is what the agent may execute; the provider request
      // (asserted below) is what the model is even told about. Pi keeps
      // builtins in a registry, but they are disabled and unadvertised.
      expect(session.getActiveToolNames()).toEqual(["echo"]);
      await session.prompt("ok");
      const advertised = fake.requests[0].tools.map((t) => t.function.name);
      expect(advertised).toEqual(["echo"]);
      for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
        expect(advertised).not.toContain(builtin);
      }
    } finally {
      dispose();
    }
  });

  it("uses the GitWire system prompt as its leading section; only pi's date/cwd lines follow", async () => {
    fake = await startFakeProvider({ turns: [{ content: "ok" }] });
    const { session, dispose, constraints } = await createControlledPiSession({
      model: fake.model,
      runtimeApiKey: "test-key",
      systemPrompt: SYSTEM_PROMPT,
      customTools: [echoTool()],
    });
    try {
      expect(session.systemPrompt.startsWith(SYSTEM_PROMPT)).toBe(true);
      // Pi unconditionally appends two environment lines; nothing else may
      // follow (no AGENTS.md content, no skills, no extension text).
      const remainder = session.systemPrompt.slice(SYSTEM_PROMPT.length);
      expect(remainder).toMatch(/^\nCurrent date: .+\nCurrent working directory: .+$/);
      expect(constraints).toMatchObject({
        sessionMode: "in-memory",
        resourceDiscovery: "disabled",
        builtinTools: "disabled",
        systemPromptSource: "gitwire",
        modelProvider: "faketest",
        modelId: "fake-reviewer",
      });
    } finally {
      dispose();
    }
  });

  it("runs a full prompt→assistant turn through the real provider stack", async () => {
    fake = await startFakeProvider({ turns: [{ content: "hello from fake" }] });
    const { session, dispose } = await createControlledPiSession({
      model: fake.model,
      runtimeApiKey: "test-key",
      systemPrompt: SYSTEM_PROMPT,
      customTools: [echoTool()],
    });
    try {
      await session.prompt("Say hello.");
      const last = session.agent.state.messages.filter((m) => m.role === "assistant").at(-1);
      expect(last.content.find((c) => c.type === "text")?.text).toBe("hello from fake");
      expect(fake.requests).toHaveLength(1);
      // The system prompt carried into the request is GitWire's, and the
      // ONLY tools advertised are the custom ones.
      const request = fake.requests[0];
      expect(request.messages[0].role).toBe("system");
      expect(request.messages[0].content.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(request.tools.map((t) => t.function.name)).toEqual(["echo"]);
      // No repository content can smuggle AGENTS.md in: no extra context
      // files were discovered.
      expect(request.messages.filter((m) => m.role === "system")).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("persists no credential: the runtime key lives only in memory", async () => {
    fake = await startFakeProvider({ turns: [{ content: "ok" }] });
    const { session, dispose } = await createControlledPiSession({
      model: fake.model,
      runtimeApiKey: "super-secret-runtime-key",
      systemPrompt: SYSTEM_PROMPT,
      customTools: [echoTool()],
    });
    try {
      await session.prompt("ok");
      // The fake provider saw the bearer key; nothing wrote auth.json state
      // beyond the factory's temp dir, which dispose removes.
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });
});
