// Regression: workspace cleanup on PARTIAL setup failure (#425 merge blocker).
// If mkdtemp succeeds but chmod/writeFile later fails, the directory — and its
// readable evaluation input — must be removed before the executor_error return.
// node:fs/promises is mocked (unstable_mockModule) with injectable failures
// and a recording rm; the runner is imported dynamically AFTER the mock.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const fsState = {
  workspace: "/tmp/gitwire-plugin-eval-TESTDIR",
  failChmodDir: false,
  failWriteFile: false,
  rmCalls: [],
};

jest.unstable_mockModule("node:fs/promises", () => ({
  // tmpBase probe: reject so the runner falls back to os.tmpdir().
  access: async () => { throw new Error("ENOENT (mock)"); },
  mkdtemp: async (prefix) => {
    fsState.lastPrefix = String(prefix);
    return fsState.workspace;
  },
  chmod: async (target, mode) => {
    if (mode === 0o755 && fsState.failChmodDir) {
      throw new Error("EACCES (injected chmod failure)");
    }
    return undefined;
  },
  writeFile: async (path, content) => {
    if (fsState.failWriteFile) {
      throw Object.assign(new Error("ENOSPC (injected writeFile failure)"), { code: "ENOSPC" });
    }
    fsState.lastInput = { path: String(path), content: String(content) };
    return undefined;
  },
  rm: async (target, opts) => {
    fsState.rmCalls.push({ target: String(target), opts: { ...opts } });
    return undefined;
  },
}));

const { runPluginEvaluation, _setCmdRunnerForTests, _setImageInspectorForTests } =
  await import("../src/pluginSandboxRunner.js");

const REF = "registry.example.com/gitwire-plugin-sandbox";
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig() {
  return { plugin_sandbox_image_ref: REF, plugin_sandbox_image_digest: DIGEST };
}

function makeRequest() {
  return {
    kind: "custom_rules",
    ctx: { author: "alice" },
    config: { custom_rules: {} },
    plugin_sources: [],
  };
}

beforeEach(() => {
  fsState.failChmodDir = false;
  fsState.failWriteFile = false;
  fsState.rmCalls = [];
  fsState.lastInput = undefined;
  _setImageInspectorForTests((ref) => {
    void ref;
    return { ok: true, digest: DIGEST, all_digests: [DIGEST] };
  });
  _setCmdRunnerForTests((cmd) => {
    if (cmd[1] === "run") {
      return { ok: true, stdout: JSON.stringify({ ok: true, matched: [] }), stderr: "", code: 0, started: true, timed_out: false };
    }
    return { ok: true, stdout: "", stderr: "", code: 0 };
  });
});

describe("workspace cleanup on partial setup failure", () => {
  it("writeFile failure after mkdtemp: directory removed, executor_error returned", async () => {
    fsState.failWriteFile = true;
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("fail");
    expect(r.fail_reason).toBe("executor_error");
    expect(r.fail_detail).toContain("ENOSPC");
    expect(fsState.rmCalls).toEqual([
      { target: fsState.workspace, opts: { recursive: true, force: true } },
    ]);
  });

  it("directory chmod failure after mkdtemp: directory removed, executor_error returned", async () => {
    fsState.failChmodDir = true;
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("fail");
    expect(r.fail_reason).toBe("executor_error");
    // The injected failure fires BEFORE input.json is written, so nothing
    // sensitive was ever materialized — but the directory still must go.
    expect(fsState.lastInput).toBeUndefined();
    expect(fsState.rmCalls).toEqual([
      { target: fsState.workspace, opts: { recursive: true, force: true } },
    ]);
  });

  it("happy path: workspace still cleaned exactly once (execution-phase finally)", async () => {
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("pass");
    expect(fsState.rmCalls).toEqual([
      { target: fsState.workspace, opts: { recursive: true, force: true } },
    ]);
  });

  it("run-phase failure: cleanup happens once, not twice (setup catch untouched)", async () => {
    _setCmdRunnerForTests((cmd) => {
      if (cmd[1] === "run") {
        return { ok: false, stdout: "", stderr: "boom", code: 3, timed_out: false, started: true };
      }
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("sandbox_nonzero_exit");
    expect(fsState.rmCalls).toHaveLength(1);
  });
});
