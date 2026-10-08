// Tests for the plugin sandbox runner (#425 isolation boundary).
//
// runPluginEvaluation() is the core of POST /v1/plugin-eval: strict protocol
// validation, digest-pinned image gate, read-only input mount, full isolation
// flag set, explicit kill/remove on timeout, and fail-closed reporting.
//
// Tests inject cmdRunner + imageInspector so no real Docker is needed; the
// live end-to-end proofs run in CI (plugin-sandbox live proof job).

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  runPluginEvaluation,
  _setCmdRunnerForTests,
  _setImageInspectorForTests,
} from "../src/pluginSandboxRunner.js";

const REF = "registry.example.com/gitwire-plugin-sandbox";
const DIGEST = "sha256:" + "a".repeat(64);

function makeConfig(overrides = {}) {
  return {
    plugin_sandbox_image_ref: REF,
    plugin_sandbox_image_digest: DIGEST,
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    kind: "custom_rules",
    ctx: { action: "opened", author: "alice" },
    config: { custom_rules: { "r1": { when: "true", actions: [] } } },
    plugin_sources: [{ source: "module.exports = { ok: () => true }", filename: "p.js" }],
    ...overrides,
  };
}

// Records every docker invocation so tests can assert the exact argv and the
// kill/remove sequence.
function makeRecorder(behavior) {
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    return behavior(cmd, calls.length);
  };
  return { calls, runner };
}

beforeEach(() => {
  _setCmdRunnerForTests(null);
  _setImageInspectorForTests(null);
});

describe("plugin sandbox runner — protocol strictness", () => {
  it("rejects caller-supplied argv/image/env/mount keys", async () => {
    for (const key of ["argv", "image", "image_ref", "env", "mounts", "volumes", "entrypoint", "container_options"]) {
      const r = await runPluginEvaluation({ request: makeRequest({ [key]: ["x"] }), config: makeConfig() });
      expect(r.overall).toBe("fail");
      expect(r.fail_reason).toBe("protocol_violation");
      expect(r.fail_detail).toContain(key);
    }
  });

  it("rejects unknown kinds and malformed plugin sources", async () => {
    expect((await runPluginEvaluation({ request: makeRequest({ kind: "shell" }), config: makeConfig() })).fail_reason).toBe("protocol_violation");
    expect((await runPluginEvaluation({ request: makeRequest({ plugin_sources: "not-array" }), config: makeConfig() })).fail_reason).toBe("protocol_violation");
    expect((await runPluginEvaluation({ request: makeRequest({ plugin_sources: [{ src: "x" }] }), config: makeConfig() })).fail_reason).toBe("protocol_violation");
    expect((await runPluginEvaluation({ request: { kind: "custom_rules", plugin_sources: [] }, config: makeConfig() })).fail_reason).toBe("protocol_violation");
    expect((await runPluginEvaluation({ request: { kind: "playground", plugin_sources: [] }, config: makeConfig() })).fail_reason).toBe("protocol_violation");
  });
});

describe("plugin sandbox runner — image identity gate", () => {
  it("refuses when the sandbox image is not configured (fail-closed, no docker calls)", async () => {
    const rec = makeRecorder(() => ({ ok: true, stdout: "", stderr: "", code: 0 }));
    _setCmdRunnerForTests(rec.runner);
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig({ plugin_sandbox_image_ref: null, plugin_sandbox_image_digest: null }) });
    expect(r.overall).toBe("fail");
    expect(r.fail_reason).toBe("sandbox_image_not_configured");
    expect(rec.calls.length).toBe(0);
  });

  it('inspects the PINNED ref@digest, not the mutable tag (digest-only installs work)', async () => {
    const seen = [];
    _setImageInspectorForTests((ref) => { seen.push(ref); return { ok: true, digest: DIGEST, all_digests: [DIGEST] }; });
    const rec = makeRecorder((cmd) => {
      if (cmd[1] === 'run') return { ok: true, stdout: JSON.stringify({ ok: true, matched: [] }), stderr: '', code: 0, started: true, timed_out: false };
      return { ok: true, stdout: '', stderr: '', code: 0 };
    });
    _setCmdRunnerForTests(rec.runner);
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe('pass');
    expect(seen).toEqual([REF + '@' + DIGEST]);
  });

  it('rejects a digest-qualified ref with an explicit contract message', async () => {
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig({ plugin_sandbox_image_ref: REF + '@' + DIGEST }) });
    expect(r.overall).toBe('fail');
    expect(r.fail_reason).toBe('sandbox_image_ref_invalid');
    expect(r.fail_detail).toContain('WITHOUT a digest suffix');
  });

  it("refuses when inspection finds no RepoDigests", async () => {
    _setImageInspectorForTests(() => ({ ok: false }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("image_inspection_failed");
  });

  it("refuses when the configured digest is absent from RepoDigests (bad/missing sandbox identity)", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: "sha256:" + "b".repeat(64), all_digests: ["sha256:" + "b".repeat(64)] }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("image_inspection_failed");
    expect(r.fail_detail).toContain(DIGEST);
  });
});

describe("plugin sandbox runner — container argv and lifecycle", () => {
  it("runs with the full isolation flag set and read-only input mount, fixed argv, named container", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    const rec = makeRecorder((cmd) => {
      if (cmd[0] === "docker" && cmd[1] === "run") {
        return { ok: true, stdout: JSON.stringify({ ok: true, matched: [{ name: "r1" }] }), stderr: "", code: 0, started: true, timed_out: false };
      }
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    _setCmdRunnerForTests(rec.runner);

    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("pass");
    expect(r.evaluation_ok).toBe(true);
    expect(r.result).toEqual([{ name: "r1" }]);

    const run = rec.calls.find((c) => c[1] === "run");
    expect(run).toBeDefined();
    const argv = run.join(" ");
    expect(argv).toContain("--network=none");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--user=1000:1000");
    expect(argv).toContain("--cap-drop=ALL");
    expect(argv).toContain("--security-opt=no-new-privileges");
    expect(argv).toContain("--memory=256m");
    expect(argv).toContain("--cpus=1");
    expect(argv).toContain("--pids-limit=64");
    expect(argv).toContain("--tmpfs=/tmp:rw,noexec,nosuid,size=8192k");
    expect(argv).toMatch(/--volume=[^ ]+:\/sandbox:ro/);
    expect(argv).toContain(`--name=gitwire-plugin-eval-`);
    expect(argv).toContain(REF);
    // Fixed argv: nothing from the request can add container arguments.
    // Runs by the digest-pinned form, not the mutable tag (TOCTOU fix).
    expect(run[run.length - 1]).toBe(REF + "@" + DIGEST);
    // Isolation attestation on the report.
    expect(r.isolation).toMatchObject({ network_disabled: true, read_only_rootfs: true, non_root: true, capabilities_dropped: true, no_new_privileges: true, input_mount_read_only: true, docker_socket_exposed: false });
  });

  it("timeout hard-kills and removes the named container, then fails closed", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    const rec = makeRecorder((cmd) => {
      if (cmd[1] === "run") return { ok: false, stdout: "", stderr: "", code: null, timed_out: true, started: true };
      if (cmd[1] === "kill") return { ok: true, stdout: "", stderr: "", code: 0 };
      if (cmd[1] === "rm") return { ok: true, stdout: "", stderr: "", code: 0 };
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    _setCmdRunnerForTests(rec.runner);

    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("fail");
    expect(r.fail_reason).toBe("sandbox_timeout");
    expect(r.container_removed).toBe(true);

    const runCall = rec.calls.find((c) => c[1] === "run");
    const name = runCall.find((a) => a.startsWith("--name=")).split("=")[1];
    const kill = rec.calls.find((c) => c[1] === "kill");
    const rm = rec.calls.find((c) => c[1] === "rm");
    expect(kill).toBeDefined();
    expect(rm).toBeDefined();
    expect(kill[kill.length - 1]).toBe(name);
    expect(rm[rm.length - 1]).toBe(name);
    expect(rm).toContain("-f");
  });

  it("nonzero exit triggers kill/remove and fails closed", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    const rec = makeRecorder((cmd) => {
      if (cmd[1] === "run") return { ok: false, stdout: "", stderr: "boom", code: 3, timed_out: false, started: true };
      return { ok: true, stdout: "", stderr: "", code: 0 };
    });
    _setCmdRunnerForTests(rec.runner);
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("sandbox_nonzero_exit");
    expect(rec.calls.some((c) => c[1] === "rm")).toBe(true);
  });

  it("malformed stdout JSON fails closed", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    _setCmdRunnerForTests(() => ({ ok: true, stdout: "not json", stderr: "", code: 0, timed_out: false }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("malformed_response");
  });

  it("response without the ok flag fails closed", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    _setCmdRunnerForTests(() => ({ ok: true, stdout: JSON.stringify({ nope: 1 }), stderr: "", code: 0, timed_out: false }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("malformed_response");
  });

  it("oversized output fails closed", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    _setCmdRunnerForTests(() => ({ ok: true, stdout: "x".repeat(262145), stderr: "", code: 0, timed_out: false }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.fail_reason).toBe("output_limit_exceeded");
  });

  it("an evaluation error inside the sandbox is a pass round trip with evaluation_ok=false", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    _setCmdRunnerForTests(() => ({ ok: true, stdout: JSON.stringify({ ok: false, error: "plugin exploded" }), stderr: "", code: 0, timed_out: false }));
    const r = await runPluginEvaluation({ request: makeRequest(), config: makeConfig() });
    expect(r.overall).toBe("pass");
    expect(r.evaluation_ok).toBe(false);
    expect(r.evaluation_error).toBe("plugin exploded");
  });

  it("playground requests map the serialized result through", async () => {
    _setImageInspectorForTests(() => ({ ok: true, digest: DIGEST, all_digests: [DIGEST] }));
    _setCmdRunnerForTests(() => ({ ok: true, stdout: JSON.stringify({ ok: true, result: { value: 42, trace: [] } }), stderr: "", code: 0, timed_out: false }));
    const r = await runPluginEvaluation({
      request: { kind: "playground", expression: "1 + 1", context: {}, plugin_sources: [] },
      config: makeConfig(),
    });
    expect(r.overall).toBe("pass");
    expect(r.result).toEqual({ value: 42, trace: [] });
  });
});
