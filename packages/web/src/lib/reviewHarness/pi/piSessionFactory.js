// Controlled Pi session factory (RI-9 amendment, Phase 8, Commit 2).
//
// Creates an ephemeral, in-memory Pi agent session under GitWire's full
// control. Every Pi default that could leak repository or host influence
// into the reviewer runtime is disabled here:
//
//   in-memory session (SessionManager.inMemory)        — nothing hits disk
//   fully custom ResourceLoader                        — NO discovery:
//       no .pi extensions, no skills, no prompt templates, no themes,
//       no AGENTS.md/CLAUDE.md context files, GitWire-owned system prompt
//   noTools: "builtin"                                  — bash/read/edit/
//       write/grep/find/ls builtins are DISABLED; only the custom tools
//       GitWire passes (the qualified RepositoryTools v2 adapters and
//       submit_review) exist in the session
//   in-memory settings                                  — compaction off
//   in-memory model registry + runtime-only API key    — no auth.json,
//       no ~/.pi/agent state, no persisted credentials
//
// The factory owns a temporary agent directory that is removed on dispose.
// No GitHub mutation credential ever reaches this layer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
  createExtensionRuntime,
} from "@earendil-works/pi-coding-agent";

/** A ResourceLoader with NO discovery and a GitWire-owned system prompt. */
function gitWireResourceLoader(systemPrompt) {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Create one controlled, ephemeral Pi session.
 *
 * @param {object} input
 * @param {object} input.model pi-ai Model data object (built by the caller;
 *        the fake qualification provider or a configured real provider)
 * @param {string} input.runtimeApiKey provider API key — held in memory for
 *        this session only, never persisted
 * @param {string} input.systemPrompt GitWire-owned system prompt
 * @param {Array} input.customTools ToolDefinitions (the ONLY tools present)
 * @param {string} [input.thinkingLevel] default "off"
 * @returns {Promise<{session: object, dispose: () => void, constraints: object}>}
 */
export async function createControlledPiSession({
  model,
  runtimeApiKey,
  systemPrompt,
  customTools,
  thinkingLevel = "off",
}) {
  if (!model || typeof model !== "object") {
    throw new Error("createControlledPiSession requires a model object");
  }
  if (typeof runtimeApiKey !== "string" || runtimeApiKey.length === 0) {
    throw new Error("createControlledPiSession requires a runtimeApiKey");
  }
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) {
    throw new Error("createControlledPiSession requires a systemPrompt");
  }
  if (!Array.isArray(customTools) || customTools.length === 0) {
    throw new Error("createControlledPiSession requires at least one custom tool");
  }

  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitwire-pi-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gitwire-pi-cwd-"));

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  authStorage.setRuntimeApiKey(model.provider, runtimeApiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);

  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel,
      authStorage,
      modelRegistry,
      resourceLoader: gitWireResourceLoader(systemPrompt),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
      customTools,
    });

    const dispose = () => {
      try {
        session.dispose();
      } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    };

    return {
      session,
      dispose,
      constraints: {
        sessionMode: "in-memory",
        resourceDiscovery: "disabled",
        builtinTools: "disabled",
        systemPromptSource: "gitwire",
        modelProvider: model.provider,
        modelId: model.id,
      },
    };
  } catch (err) {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    throw err;
  }
}
