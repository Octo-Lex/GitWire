// packages/executor-service/src/pluginSandboxRunner.js
// #425 isolation boundary: narrowly typed plugin-evaluation sandbox runner.
//
// runPluginEvaluation() backs POST /v1/plugin-eval. It:
//   1. Validates a STRICT request shape (fixed keys, fixed kinds; any
//      caller-supplied argv/image/env/mount/path keys are rejected — this is
//      a plugin-evaluation API, never a generic execution API).
//   2. Inspects the operator-configured, digest-pinned sandbox image.
//   3. Materializes the serialized evaluation input into an ephemeral
//      workspace, mounted READ-ONLY into the sandbox.
//   4. Runs the disposable container with the full isolation flag set.
//   5. Parses the bounded stdout JSON response; on timeout it explicitly
//      kills and removes the named container (killing only the docker client
//      is not sufficient — the workload container must not survive).
//
// Isolation contract (hardened #425 freeze — disposable container or
// equivalent OS sandbox; a bare child process is NOT a boundary):
//   --network=none --read-only --user=1000:1000 --cap-drop=ALL
//   --security-opt=no-new-privileges --memory --cpus --pids-limit
//   --tmpfs=/tmp (bounded) --volume=<workspace>:/sandbox:ro
// No Docker socket, no production volumes, no credentials in the container
// environment (env is NOT forwarded — the request carries serialized data
// only, delivered as a read-only file).
//
// Failure is FAIL-CLOSED everywhere: timeout, malformed response, image
// mismatch, executor unavailability, crash, or output-limit violation
// produce a typed failure report. There is no fallback path and nothing in
// this module ever loads plugin code in-process.

import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Fixed request schema. Anything outside these keys is a protocol violation.
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "kind", "ctx", "config", "context", "expression", "expressions", "plugin_sources",
]);
const ALLOWED_KINDS = new Set(["custom_rules", "playground"]);

const DEFAULT_LIMITS = Object.freeze({
  wall_clock_ms: 10000,
  memory_mb: 256,
  cpus: 1,
  pids_limit: 64,
  tmpfs_kb: 8192,
  output_bytes: 262144, // 256 KB — evaluation results are small JSON
});

const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

let _cmdRunner = null;
let _imageInspector = null;

/** Test-only seam: inject a fake docker command runner. */
export function _setCmdRunnerForTests(fn) { _cmdRunner = fn; }

/** Test-only seam: inject a fake image inspector. */
export function _setImageInspectorForTests(fn) { _imageInspector = fn; }

function runCmd(cmd, opts = {}) {
  if (_cmdRunner) return _cmdRunner(cmd);
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      timeout: opts.timeoutMs || DEFAULT_LIMITS.wall_clock_ms,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      // An attached docker CLI waiting on a runaway container does not die
      // reliably on SIGTERM on some hosts (CI runners); SIGKILL guarantees
      // the client dies at the wall clock and the explicit kill/remove path
      // then takes down the named container.
      killSignal: "SIGKILL",
    });
    if (r.error) {
      const isTimeout = r.signal != null || (r.error && r.error.code === "ETIMEDOUT");
      return { ok: false, stdout: r.stdout || "", stderr: r.stderr || "", code: null, timed_out: isTimeout, started: r.pid > 0 };
    }
    return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "", code: r.status, timed_out: false, started: true };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err.message, code: null, timed_out: false, started: false };
  }
}

function inspectImage(imageRef) {
  // Forward the inspected reference to the test seam so tests can assert
  // WHICH ref was inspected (tag vs pinned).
  if (_imageInspector) return _imageInspector(imageRef);
  try {
    const jsonResult = spawnSync("docker", ["inspect", "--format", "{{json .RepoDigests}}", imageRef], {
      encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (jsonResult.error || jsonResult.status !== 0) return { ok: false };
    let repoDigests = [];
    try { repoDigests = JSON.parse((jsonResult.stdout || "").trim()); } catch { return { ok: false }; }
    const digests = repoDigests
      .map((d) => { const m = d.match(/@(sha256:[0-9a-f]{64})$/); return m ? m[1] : null; })
      .filter(Boolean);
    if (digests.length === 0) return { ok: false };
    return { ok: true, digest: digests[0], all_digests: digests };
  } catch {
    return { ok: false };
  }
}

// The docker argv is FIXED here. The request never contributes argv, image,
// env, mounts, or container options.
function buildRunArgv(runtime, imageRef, limits, workspace, containerName) {
  return [
    runtime, "run", "--rm",
    `--name=${containerName}`,
    "--network=none",
    "--read-only",
    `--user=${CONTAINER_UID}:${CONTAINER_GID}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory=${limits.memory_mb}m`,
    `--cpus=${limits.cpus}`,
    `--pids-limit=${limits.pids_limit}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${limits.tmpfs_kb}k`,
    `--volume=${workspace}:/sandbox:ro`,
    imageRef,
  ];
}

function validateRequest(request) {
  if (!request || typeof request !== "object") return "request must be an object";
  for (const key of Object.keys(request)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return `unexpected key '${key}': the plugin-eval protocol is fixed (kind, ctx, config, context, expression, expressions, plugin_sources) — no argv, image, environment, mounts, or container options are accepted`;
    }
  }
  if (!ALLOWED_KINDS.has(request.kind)) return `kind must be one of [custom_rules, playground], got '${request.kind}'`;
  if (!Array.isArray(request.plugin_sources)) return "plugin_sources must be an array";
  for (const p of request.plugin_sources) {
    if (!p || typeof p.source !== "string" || typeof p.filename !== "string") {
      return "each plugin_source must be { source: string, filename: string }";
    }
  }
  if (request.kind === "custom_rules" && (!request.ctx || !request.config)) {
    return "custom_rules requires ctx and config";
  }
  if (request.kind === "playground" && typeof request.expression !== "string") {
    return "playground requires expression";
  }
  return null;
}

function sandboxInputFor(request) {
  if (request.kind === "custom_rules") {
    return { kind: "custom_rules", ctx: request.ctx, config: request.config, plugin_sources: request.plugin_sources };
  }
  return {
    kind: "playground",
    expression: request.expression,
    context: request.context ?? {},
    expressions: request.expressions ?? {},
    plugin_sources: request.plugin_sources,
  };
}

function failure(reason, detail, extra = {}) {
  return { overall: "fail", fail_reason: reason, fail_detail: detail, ...extra };
}

/**
 * Run a plugin evaluation in the disposable sandbox. NEVER executes plugin
 * code in-process; NEVER falls back. See module header for the contract.
 *
 * @param {object} params
 * @param {object} params.request - fixed-shape evaluation request
 * @param {object} params.config - frozen executor config (sandbox image ref+digest)
 * @returns {Promise<object>} evaluation report; overall "pass" only on a
 *   completed, well-formed sandbox round trip.
 */
export async function runPluginEvaluation({ request, config }) {
  const shapeError = validateRequest(request);
  if (shapeError) return failure("protocol_violation", shapeError);

  const limits = { ...DEFAULT_LIMITS };

  // Sandbox image identity: operator-configured ref + digest, both required.
  // Absence is a refusal, not a degradation — plugin evaluation cannot run
  // without a pinned sandbox.
  if (!config.plugin_sandbox_image_ref || !config.plugin_sandbox_image_digest) {
    return failure("sandbox_image_not_configured",
      "GITWIRE_PLUGIN_SANDBOX_IMAGE_REF and _DIGEST must both be set on the executor service");
  }
  // Ref contract: repository[:tag] WITHOUT a digest suffix. This code pins
  // and runs ref@digest itself; an embedded digest would either duplicate
  // or contradict the configured one — surface it instead of guessing.
  if (/@sha256:[0-9a-f]{64}$/i.test(config.plugin_sandbox_image_ref)) {
    return failure("sandbox_image_ref_invalid",
      `GITWIRE_PLUGIN_SANDBOX_IMAGE_REF must be repository[:tag] WITHOUT a digest suffix (the executor pins ref@digest itself): ${config.plugin_sandbox_image_ref}`);
  }

  // Inspect the PINNED reference — exactly what will run — never the mutable
  // tag: the documented install procedure pulls ref@digest only (digest-only
  // pulls leave the tag unset locally), so a tag-based inspect would refuse
  // every evaluation on a correctly-installed host.
  const pinnedRef = config.plugin_sandbox_image_ref + "@" + config.plugin_sandbox_image_digest;
  const inspection = inspectImage(pinnedRef);
  if (!inspection.ok) {
    return failure("image_inspection_failed", "docker inspect did not succeed or image has no RepoDigests");
  }
  const allDigests = inspection.all_digests || [inspection.digest];
  if (!allDigests.includes(config.plugin_sandbox_image_digest)) {
    return failure("image_inspection_failed",
      `configured digest '${config.plugin_sandbox_image_digest}' not found in RepoDigests: [${allDigests.join(", ")}]`);
  }

  const containerName = `gitwire-plugin-eval-${randomUUID().slice(0, 12)}`;
  const runtime = "docker";

  let workspace;
  try {
    const tmpBase = await import("node:fs/promises").then((fs) =>
      fs.access("/workspace-tmp").then(() => "/workspace-tmp").catch(() => tmpdir()));
    workspace = await mkdtemp(join(tmpBase, "gitwire-plugin-eval-"));
    // The container runs as uid 1000 while this directory belongs to the
    // executor's user (0700 by default from mkdtemp) — without a traversable
    // mode the sandbox cannot even reach the input file on hosts that honor
    // unix permissions on bind mounts (Linux; Docker Desktop on Windows
    // masks them). Input itself stays read-only inside the container.
    await chmod(workspace, 0o755);
    // Read-only for the container; writable here only during materialization.
    await writeFile(join(workspace, "input.json"), JSON.stringify(sandboxInputFor(request)), "utf-8");
    await chmod(join(workspace, "input.json"), 0o644);
  } catch (err) {
    return failure("executor_error", `workspace setup failed: ${err.message}`);
  }

  try {
    // Run by the DIGEST-PINNED reference (pinnedRef above): running the tag
    // would race a concurrent re-push (TOCTOU). ref@digest is immutable —
    // what was inspected is exactly what runs.
    const argv = buildRunArgv(runtime, pinnedRef, limits, workspace, containerName);
    const started = Date.now();
    const r = runCmd(argv, { timeoutMs: limits.wall_clock_ms });
    const duration_ms = Date.now() - started;

    // Explicit kill/remove path: a timeout kills the docker CLIENT; the
    // named workload container can outlive it. Always attempt removal of a
    // possibly-surviving container on timeout or nonzero exit.
    let containerKilled = false;
    if (r.timed_out || r.code !== 0) {
      const kill = runCmd([runtime, "kill", containerName], { timeoutMs: 5000 });
      const remove = runCmd([runtime, "rm", "-f", containerName], { timeoutMs: 5000 });
      containerKilled = kill.code === 0 || remove.code === 0;
    }

    if (r.timed_out) {
      return failure("sandbox_timeout", `sandbox exceeded ${limits.wall_clock_ms}ms wall clock and was killed (container removed: ${containerKilled})`, {
        container_name: containerName,
        container_removed: containerKilled,
        duration_ms,
      });
    }
    if (r.code !== 0) {
      return failure("sandbox_nonzero_exit", `sandbox exited ${r.code}: ${(r.stderr || "").slice(0, 400)}`, {
        container_name: containerName,
        container_removed: containerKilled,
        duration_ms,
      });
    }

    const stdout = r.stdout || "";
    if (Buffer.byteLength(stdout, "utf8") > limits.output_bytes) {
      return failure("output_limit_exceeded", `sandbox stdout exceeded ${limits.output_bytes} bytes`, {
        container_name: containerName, duration_ms,
      });
    }
    let response;
    try {
      response = JSON.parse(stdout);
    } catch {
      return failure("malformed_response", `sandbox stdout is not JSON: ${stdout.slice(0, 200)}`, {
        container_name: containerName, duration_ms,
      });
    }
    if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
      return failure("malformed_response", "sandbox response must be { ok: boolean, ... }", {
        container_name: containerName, duration_ms,
      });
    }

    return {
      overall: "pass",
      evaluation_ok: response.ok,
      result: response.ok ? (response.result ?? response.matched ?? null) : null,
      evaluation_error: response.ok ? null : String(response.error || "unknown evaluation error"),
      sandbox_image_ref: config.plugin_sandbox_image_ref,
      sandbox_image_digest: config.plugin_sandbox_image_digest,
      isolation: {
        network_disabled: true,
        read_only_rootfs: true,
        non_root: true,
        capabilities_dropped: true,
        no_new_privileges: true,
        input_mount_read_only: true,
        docker_socket_exposed: false,
        resource_limits: { memory_mb: limits.memory_mb, cpus: limits.cpus, pids_limit: limits.pids_limit, wall_clock_ms: limits.wall_clock_ms },
      },
      duration_ms,
    };
  } finally {
    if (workspace) {
      try { await rm(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
