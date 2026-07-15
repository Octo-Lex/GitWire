// packages/executor-service/src/validatorRunner.js
// Validator runner (v0.23.0 Task 5, step 3-4).
//
// runValidatorJob() is the core of POST /v1/validate. It:
//   1. Inspects the pinned validator image (digest must match config)
//   2. Materializes the request's files into an ephemeral workspace
//   3. Runs each allowlisted command in an isolated container
//   4. Returns the executor report object (overall pass/fail/inconclusive)
//
// Isolation contract (non-negotiable, mirrors dockerExecutorBackend):
//   --network=none --read-only --user=1000:1000 --pids-limit --memory --tmpfs
//   No --privileged, no host Docker socket inside the validator, no shell.
//
// Command IDs are allowlisted (lint/test/build/typecheck). Non-allowlisted
// IDs produce exit_status=null → inconclusive. Never arbitrary shell.
//
// Test-injectable: cmdRunner (docker run/exec) + imageInspector (docker inspect)
// seams mirror the runtime-probe pattern. Production wires spawnSync-based
// implementations.

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { computeExecutorReportHash, buildExecutorReportRef } from "./executorReportHash.js";
import { enforceDescriptorPolicy } from "./commandDescriptorPolicy.js";

// ── Command allowlist (duplicated locally to keep the package standalone) ───
// Mirrors packages/web/src/lib/validationCommandTemplates.js. Four IDs only;
// the `--` separator is literal. Non-allowlisted IDs → exit_status null.
const COMMAND_TEMPLATES = Object.freeze({
  lint:      ["npm", "run", "lint", "--"],
  test:      ["npm", "test", "--"],
  build:     ["npm", "run", "build", "--"],
  typecheck: ["npm", "run", "typecheck", "--"],
});

function resolveCommandTemplate(id) {
  const t = COMMAND_TEMPLATES[id];
  if (!t) throw new Error(`Validation command '${id}' is not allowlisted`);
  return t;
}

// ── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_LIMITS = Object.freeze({
  wall_clock_ms: 30000,
  memory_mb: 512,
  pids_limit: 64,
  output_bytes: 1048576,
});

const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

// ── Production command runner (test-injectable) ─────────────────────────────
let _cmdRunner = null;
let _imageInspector = null;

/**
 * Test-only seam: inject a fake docker command runner.
 * Signature: (cmd: string[]) => { ok: boolean, stdout: string, stderr: string, code: number|null }
 * Pass null to restore real spawnSync.
 */
export function _setCmdRunnerForTests(fn) { _cmdRunner = fn; }

/**
 * Test-only seam: inject a fake image inspector.
 * Signature: () => { ok: boolean, digest: string|null, hash: string|null }
 * Pass null to restore real docker inspect.
 */
export function _setImageInspectorForTests(fn) { _imageInspector = fn; }

function runCmd(cmd, opts = {}) {
  if (_cmdRunner) return _cmdRunner(cmd);
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), {
      encoding: "utf-8",
      timeout: opts.timeoutMs || DEFAULT_LIMITS.wall_clock_ms,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error) {
      // Distinguish three failure modes:
      //   1. Timeout: process started, ran past wall_clock, killed by signal.
      //      spawnSync sets r.signal (typically 'SIGTERM' or 'SIGKILL').
      //   2. Spawn failure: process never started (ENOENT, EACCES, etc).
      //      r.status is undefined, r.signal is null.
      //   3. Other error after start: rare edge case.
      //
      // "started" means the OS actually launched the process. A timeout means
      // the process started. A spawn error (ENOENT/EACCES) means it did not.
      const isTimeout = r.signal != null || (r.error && r.error.code === "ETIMEDOUT");
      const processStarted = r.status !== undefined || r.signal != null;
      return {
        ok: false, stdout: r.stdout || "", stderr: r.stderr || "", code: null,
        started: processStarted,
        completed: false,
        timed_out: isTimeout,
      };
    }
    return {
      ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "", code: r.status,
      started: true, completed: true, timed_out: false,
    };
  } catch (err) {
    return {
      ok: false, stdout: "", stderr: err.message, code: null,
      started: false, completed: false, timed_out: false,
    };
  }
}

function inspectImage(imageRef) {
  if (_imageInspector) return _imageInspector();
  try {
    // P1 #1 fix: use RepoDigests, not .Image. The .Image field returns the
    // image's local layer ID (e.g. sha256:<config-digest>), which is NOT the
    // same as the registry-pushed content digest (sha256:<manifest-digest>).
    // RepoDigests contains entries like "registry/repo@sha256:<manifest-digest>"
    // which IS what GITWIRE_VALIDATOR_IMAGE_DIGEST pins. Parse the digest from
    // RepoDigests and compare.
    const jsonResult = spawnSync("docker", ["inspect", "--format", "{{json .RepoDigests}}", imageRef], {
      encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (jsonResult.error || jsonResult.status !== 0) return { ok: false };

    let repoDigests = [];
    try {
      repoDigests = JSON.parse((jsonResult.stdout || "").trim());
    } catch {
      return { ok: false };
    }

    // Extract sha256:<hex> from RepoDigests entries (format: "repo@sha256:...").
    const digests = repoDigests
      .map(d => { const m = d.match(/@(sha256:[0-9a-f]{64})$/); return m ? m[1] : null; })
      .filter(Boolean);

    if (digests.length === 0) return { ok: false };

    // Also get the full inspect JSON for inspection_hash (audit trail).
    const fullInspect = spawnSync("docker", ["inspect", imageRef], {
      encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
    const inspectJson = (fullInspect.stdout || "").trim();
    const hash = "sha256:" + createHash("sha256").update(inspectJson).digest("hex");

    // Return ALL parsed digests. The caller selects the one matching
    // config.validator_image_digest — if none match, it's image_inspection_failed.
    // This handles images pushed to multiple registries (multiple RepoDigests).
    return { ok: true, digest: digests[0], hash, all_digests: digests };
  } catch {
    return { ok: false };
  }
}

function hashOutput(s) {
  return "sha256:" + createHash("sha256").update(s || "").digest("hex");
}

// Workspace tempdir base. Must be a host-shared volume (Docker-in-LXC: the
// nested Docker daemon needs to see these files on the host filesystem, not
// inside the executor-service container's overlay). docker-compose.yml mounts
// executor_workspaces:/workspace-tmp for this purpose. Falls back to tmpdir()
// in non-container (dev/test) contexts.
const WORKSPACE_TMP = process.env.EXECUTOR_WORKSPACE_TMP || "/workspace-tmp";

// ── Workspace materialization ───────────────────────────────────────────────
async function materializeWorkspace(files) {
  const tmpBase = WORKSPACE_TMP && await import("node:fs/promises").then(fs => fs.access(WORKSPACE_TMP).then(() => WORKSPACE_TMP).catch(() => tmpdir())) || tmpdir();
  const workspace = await mkdtemp(join(tmpBase, "gitwire-validator-"));
  // Docker-in-LXC UID mapping: the executor-service container runs as uid 1000,
  // but the host sees the tempdir as root-owned (uid 0). The nested Docker
  // container (validator) runs as --user=1000:1000 and can't write to a
  // root-owned directory. chmod 0o777 makes the workspace writable regardless
  // of how Docker-in-LXC maps UIDs. Safe because it's an ephemeral tempdir
  // cleaned up in finally.
  await chmod(workspace, 0o777);
  for (const f of files || []) {
    // Path-traversal guard — mirrors dockerExecutorBackend.
    if (f.path.includes("..") || f.path.startsWith("/")) {
      throw new Error(`workspace_setup_failed: invalid path '${f.path}'`);
    }
    const fullPath = join(workspace, f.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, f.content ?? "", "utf-8");
  }
  return workspace;
}

// ── Build the docker run argv with all isolation flags ──────────────────────
// P1 #2 fix: workspace is a parameter, not a placeholder string. The old code
// embedded WORKSPACE_PLACEHOLDER inside a --volume arg and then tried to
// replace it via .map(arg => arg === "WORKSPACE_PLACEHOLDER"), which never
// matched because the arg was "--volume=WORKSPACE_PLACEHOLDER:/workspace:rw".
// Real Docker would mount a named volume called WORKSPACE_PLACEHOLDER.
function buildRunArgv(runtime, imageRef, argv, limits, workspace) {
  return [
    runtime, "run", "--rm",
    "--network=none",
    "--read-only",
    `--user=${CONTAINER_UID}:${CONTAINER_GID}`,
    `--memory=${limits.memory_mb}m`,
    `--pids-limit=${limits.pids_limit}`,
    `--tmpfs=/tmp:rw,size=${Math.floor(limits.output_bytes / 1024)}k`,
    "--workdir=/workspace",
    `--volume=${workspace}:/workspace:rw`,
    imageRef,
    ...argv,
  ];
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Run a validator job: inspect image, materialize workspace, run commands,
 * produce the executor report.
 *
 * @param {object} params
 * @param {object} params.request - the POST /v1/validate request body
 * @param {object} params.config - frozen config from loadExecutorServiceConfig()
 * @param {function} [params.cmdRunner] - injected runner (tests)
 * @param {function} [params.imageInspector] - injected inspector (tests)
 * @returns {Promise<object>} executor report (pass/fail/inconclusive)
 */
export async function runValidatorJob({ request, config, cmdRunner, imageInspector }) {
  // Honor test seams if passed via params (preferred over module setters for
  // per-call injection); fall back to module setters.
  if (cmdRunner) _setCmdRunnerForTests(cmdRunner);
  if (imageInspector) _setImageInspectorForTests(imageInspector);

  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  const runtime = "docker"; // v0.23.0 default; podman fallback is future work

  try {
    // ── Step 1: validate image identity ────────────────────────────────────
    // The request must name the same image the service is configured to run.
    if (request.validator_image_ref !== config.validator_image_ref) {
      return inconclusive("validator_image_ref_mismatch",
        `request ref '${request.validator_image_ref}' != configured '${config.validator_image_ref}'`,
        config);
    }

    // Inspect the image; the configured digest must be present in the
    // image's RepoDigests (handles multi-registry images with multiple digests).
    const inspection = inspectImage(config.validator_image_ref);
    if (!inspection.ok) {
      return inconclusive("image_inspection_failed", "docker inspect did not succeed", config);
    }
    // Check if the configured digest appears in ANY of the image's parsed
    // RepoDigests entries, not just the first one.
    const allDigests = inspection.all_digests || [inspection.digest];
    const matchingDigest = allDigests.find(d => d === config.validator_image_digest);
    if (!matchingDigest) {
      return inconclusive("image_inspection_failed",
        `configured digest '${config.validator_image_digest}' not found in RepoDigests: [${allDigests.join(", ")}]`,
        config);
    }
    // Use the matching digest for the report's inspected_image_digest.
    inspection.digest = matchingDigest;

    // ── Step 2: materialize workspace ──────────────────────────────────────
    let workspace;
    try {
      workspace = await materializeWorkspace(request.files);
    } catch (wsErr) {
      return inconclusive("executor_error", wsErr.message, config);
    }

    // P2 fix: wrap all post-materialization execution in try/finally so the
    // workspace tempdir is always cleaned up, regardless of pass/fail/error.
    try {
      // ── Step 3: run each allowlisted command ─────────────────────────────
      // Task 8D: when the request carries a command_descriptors entry keyed by
      // command_id, the descriptor's argv is executed (argv-only, no shell)
      // AFTER passing the authoritative policy gate. A policy-rejected
      // descriptor produces a visible rejected command_result (fail-closed,
      // never a silent fallback to the legacy template). Commands without a
      // descriptor use the legacy COMMAND_TEMPLATES.
      const commandResults = [];
      let aggregateExitStatus = 0;
      const descriptors = (request.command_descriptors && typeof request.command_descriptors === "object")
        ? request.command_descriptors
        : {};

      // Build step metadata lookup from execution_steps (planner-issued).
      const stepMeta = new Map();
      if (Array.isArray(request.execution_steps)) {
        for (const step of request.execution_steps) {
          if (step && step.command_id) {
            stepMeta.set(step.command_id, step);
          }
        }
      }

      for (const cmdId of request.commands) {
        const descriptor = descriptors[cmdId];
        const meta = stepMeta.get(cmdId) || {};

        // ── Descriptor path ────────────────────────────────────────────────
        if (descriptor) {
          // A shape_invalid descriptor (carried from the web adapter) is
          // rejected immediately — preserve its shape_reasons.
          if (descriptor.policy_status === "shape_invalid") {
            commandResults.push({
              command: cmdId,
              step_id: meta.step_id || cmdId,
              sequence: meta.sequence ?? commandResults.length,
              semantic_id: descriptor.semantic_id || null,
              command_source: "ci_workflow_descriptor",
              status: "rejected",
              // Task 8D blocker fix: a shape_invalid descriptor carries no
              // argv/target_paths by definition (its shape is the reason it
              // was rejected). Record them as empty arrays so the receipt's
              // command_result shape is uniform across accepted/rejected results.
              executed_argv: [],
              target_paths: [],
              policy_reasons: (descriptor.shape_reasons || []).map(r => `descriptor shape invalid: ${r}`),
              exit_status: null,
              output_ref: null,
              output_hash: null,
              duration_ms: 0,
            });
            aggregateExitStatus = null;
            continue;
          }

          // Authoritative policy gate (fail-closed).
          const policy = enforceDescriptorPolicy(descriptor);
          if (!policy.ok) {
            commandResults.push({
              command: cmdId,
              step_id: meta.step_id || cmdId,
              sequence: meta.sequence ?? commandResults.length,
              semantic_id: descriptor.semantic_id || null,
              command_source: "ci_workflow_descriptor",
              status: "rejected",
              // Task 8D blocker fix: carry the full audit fields. The
              // descriptor was policy-rejected (not executed), but its
              // intended argv/target_paths are part of the audit trail —
              // they show exactly what was refused and why. exit_status is
              // null because the command never ran.
              executed_argv: descriptor.argv || [],
              target_paths: descriptor.target_paths || [],
              policy_reasons: policy.reasons,
              exit_status: null,
              output_ref: null,
              output_hash: null,
              duration_ms: 0,
            });
            aggregateExitStatus = null;
            continue;
          }

          // Execute the descriptor argv directly (shell=false via spawn argv).
          const argv = descriptor.argv;
          const argvFull = buildRunArgv(runtime, config.validator_image_ref, argv, limits, workspace);

          const start = Date.now();
          const r = runCmd(argvFull, { cwd: workspace, timeoutMs: limits.wall_clock_ms });
          const duration_ms = Date.now() - start;

          const combined = (r.stdout || "") + "\n" + (r.stderr || "");
          const outputHash = hashOutput(combined);

          commandResults.push({
            command: cmdId,
            step_id: meta.step_id || cmdId,
            sequence: meta.sequence ?? commandResults.length,
            semantic_id: descriptor.semantic_id || null,
            command_source: "ci_workflow_descriptor",
            executed_argv: argv,
            target_paths: descriptor.target_paths || [],
            exit_status: r.code,
            started: r.started !== false,
            completed: r.completed === true,
            timed_out: r.timed_out === true,
            output_ref: `output:${outputHash}`,
            output_hash: outputHash,
            duration_ms,
          });
          if (r.code === null) aggregateExitStatus = null;
          else if (aggregateExitStatus === 0 && r.code !== 0) aggregateExitStatus = r.code;
          continue;
        }

        // ── Legacy template path ───────────────────────────────────────────
        let argv;
        try {
          argv = resolveCommandTemplate(cmdId);
        } catch {
          // Non-allowlisted → null exit_status → inconclusive aggregate.
          commandResults.push({ command: cmdId, step_id: meta.step_id || cmdId, sequence: meta.sequence ?? commandResults.length, exit_status: null, output_ref: null, output_hash: null, duration_ms: 0 });
          aggregateExitStatus = null;
          continue;
        }

        // P1 #2 fix: pass the real workspace path, not a placeholder.
        const argvFull = buildRunArgv(runtime, config.validator_image_ref, argv, limits, workspace);

        const start = Date.now();
        const r = runCmd(argvFull, { cwd: workspace, timeoutMs: limits.wall_clock_ms });
        const duration_ms = Date.now() - start;

        const combined = (r.stdout || "") + "\n" + (r.stderr || "");
        const outputHash = hashOutput(combined);

        commandResults.push({
          command: cmdId,
          step_id: meta.step_id || cmdId,
          sequence: meta.sequence ?? commandResults.length,
          command_source: "legacy_template",
          executed_argv: argv,
          target_paths: [],
          exit_status: r.code,
          started: r.started !== false,
          completed: r.completed === true,
          timed_out: r.timed_out === true,
          output_ref: `output:${outputHash}`,
          output_hash: outputHash,
          duration_ms,
        });
        if (r.code === null) aggregateExitStatus = null;
        else if (aggregateExitStatus === 0 && r.code !== 0) aggregateExitStatus = r.code;
      }

      // ── Step 4: derive overall + build report ────────────────────────────
      // Task 8D: a policy-rejected descriptor is a DEFINITE failure (overall
      // cannot be "pass"), distinct from execution_incomplete (inconclusive).
      let overall, inconclusiveReason;
      const hasRejected = commandResults.some(cr => cr.status === "rejected");
      const hasIncomplete = commandResults.some(cr => cr.exit_status === null && cr.status !== "rejected");
      if (hasRejected) {
        overall = "fail";
        inconclusiveReason = null;
      } else if (hasIncomplete) {
        overall = "inconclusive";
        inconclusiveReason = "execution_incomplete";
      } else if (aggregateExitStatus === 0) {
        overall = "pass";
      } else {
        overall = "fail";
      }

      if (overall === "inconclusive") {
        return inconclusive(inconclusiveReason, "one or more commands did not complete", config, { command_results: commandResults });
      }

      const report = {
        report_schema_version: 1,
        executor_service_id: config.executor_service_id,
        executor_service_version: config.executor_service_version,
        executor_service_instance_id: config.executor_service_instance_id || "unknown",
        deployment_mode: config.deployment_mode,
        container_runtime: runtime,
        runtime_version: null, // populated by the route from probeRuntime() in step 5-6
        validator_image_ref: config.validator_image_ref,
        validator_image_digest: config.validator_image_digest,
        inspected_image_digest: inspection.digest,
        inspection_hash: inspection.hash,
        network_disabled: true,
        non_root: true,
        read_only_rootfs: true,
        resource_limits: { memory_mb: limits.memory_mb, pids_limit: limits.pids_limit },
        command_results: commandResults,
        // Plan-execution conformance: structured step evidence for app-side
        // conformance derivation. This is a normalized projection of
        // command_results — the app verifies they match. Backends must capture
        // the actual argv passed to the process API, not reconstruct by
        // splitting command strings.
        executed_steps: commandResults.map((cr, i) => ({
          step_id: cr.step_id || cr.command,
          sequence: cr.sequence ?? i,
          command_source: cr.command_source || null,
          executed_argv: cr.executed_argv || null,
          target_paths: cr.target_paths || null,
          exit_status: cr.exit_status,
          status: cr.status || null,
          started: cr.started !== false,
          completed: cr.completed === true,
          timed_out: cr.timed_out === true,
        })),
        aggregate_exit_status: aggregateExitStatus,
        overall,
      };

      // Compute the content-addressed hash + ref.
      report.executor_report_hash = computeExecutorReportHash(report);
      report.executor_report_ref = buildExecutorReportRef(report.executor_report_hash);

      return report;
    } finally {
      // P2 fix: always clean up the materialized workspace tempdir, regardless
      // of pass/fail/inconclusive/error. Never leak patched source files.
      if (workspace) {
        try { await rm(workspace, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  } finally {
    // Always tear down test seams so module state doesn't leak between calls.
    if (cmdRunner) _setCmdRunnerForTests(null);
    if (imageInspector) _setImageInspectorForTests(null);
  }
}

function inconclusive(reason, detail, config, extra = {}) {
  return {
    overall: "inconclusive",
    inconclusive_reason: reason,
    inconclusive_detail: detail,
    executor_service_id: config.executor_service_id,
    executor_service_version: config.executor_service_version,
    ...extra,
  };
}
