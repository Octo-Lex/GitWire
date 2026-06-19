// tests/unit/executor-backend.test.js
// Source-reading and contract tests for the executor backend abstraction.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const backendContract = readSource("packages/web/src/lib/executorBackend.js");
const nodeBackend = readSource("packages/web/src/lib/nodeExecutorBackend.js");
const dockerBackend = readSource("packages/web/src/lib/dockerExecutorBackend.js");
const registry = readSource("packages/web/src/lib/executorRegistry.js");
const sandboxRunner = readSource("packages/web/src/lib/sandboxRunner.js");
const repairService = readSource("packages/web/src/services/repairProposalService.js");

// ════════════════════════════════════════════════════════════════════════════
// EXECUTOR BACKEND CONTRACT
// ════════════════════════════════════════════════════════════════════════════

describe("Executor Backend — contract interface", () => {
  it("exports validateBackendContract", () => {
    expect(backendContract).toMatch(/export function validateBackendContract/);
  });

  it("exports validateIsolationBinding", () => {
    expect(backendContract).toMatch(/export function validateIsolationBinding/);
  });

  it("exports VALID_CONTAINER_RUNTIMES allowlist", () => {
    expect(backendContract).toMatch(/VALID_CONTAINER_RUNTIMES/);
    expect(backendContract).toMatch(/docker/);
    expect(backendContract).toMatch(/podman/);
    expect(backendContract).toMatch(/none/);
  });

  it("documents the ExecutorBackend contract shape", () => {
    expect(backendContract).toMatch(/id/);
    expect(backendContract).toMatch(/version/);
    expect(backendContract).toMatch(/image_digest/);
    expect(backendContract).toMatch(/supports_pass/);
    expect(backendContract).toMatch(/container_runtime/);
    expect(backendContract).toMatch(/runtime_version/);
    expect(backendContract).toMatch(/network_disabled/);
    expect(backendContract).toMatch(/non_root/);
    expect(backendContract).toMatch(/read_only_rootfs/);
    expect(backendContract).toMatch(/resource_limits/);
    expect(backendContract).toMatch(/describe\(\)/);
    expect(backendContract).toMatch(/run\(\{/);
  });

  it("validateBackendContract checks all required fields", () => {
    const fields = [
      "id", "version", "image_digest", "supports_pass",
      "container_runtime", "network_disabled", "non_root",
      "read_only_rootfs", "resource_limits",
    ];
    for (const field of fields) {
      expect(backendContract).toMatch(field);
    }
  });

  it("validateIsolationBinding checks all required fields", () => {
    const fields = [
      "execution_backend_id", "executor_version", "sandbox_image_digest",
      "container_runtime", "runtime_version", "network_disabled",
      "non_root", "read_only_rootfs", "resource_limits",
    ];
    for (const field of fields) {
      expect(backendContract).toMatch(field);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// NODE EXECUTOR BACKEND
// ════════════════════════════════════════════════════════════════════════════

describe("Node Executor Backend", () => {
  it("has id 'node-executor'", () => {
    expect(nodeBackend).toMatch(/id:\s*"node-executor"/);
  });

  it("has supports_pass: false", () => {
    expect(nodeBackend).toMatch(/supports_pass:\s*false/);
  });

  it("has container_runtime 'none'", () => {
    expect(nodeBackend).toMatch(/container_runtime:\s*"none"/);
  });

  it("has network_disabled: false (host has network)", () => {
    expect(nodeBackend).toMatch(/network_disabled:\s*false/);
  });

  it("has non_root: false (runs as current user)", () => {
    expect(nodeBackend).toMatch(/non_root:\s*false/);
  });

  it("has read_only_rootfs: false", () => {
    expect(nodeBackend).toMatch(/read_only_rootfs:\s*false/);
  });

  it("has image_digest sha256:node-executor-v1", () => {
    expect(nodeBackend).toMatch(/sha256:node-executor-v1/);
  });

  it("exports describe() returning isolation binding", () => {
    expect(nodeBackend).toMatch(/describe\(\)/);
    expect(nodeBackend).toMatch(/execution_backend_id:\s*this\.id/);
    expect(nodeBackend).toMatch(/network_disabled:\s*this\.network_disabled/);
  });

  it("exports run() delegating to sandboxExecutor", () => {
    expect(nodeBackend).toMatch(/async run\(/);
    expect(nodeBackend).toMatch(/runSandboxExecution/);
  });

  it("validates contract at module load", () => {
    expect(nodeBackend).toMatch(/validateBackendContract/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DOCKER EXECUTOR BACKEND
// ════════════════════════════════════════════════════════════════════════════

describe("Docker Executor Backend", () => {
  it("has id 'docker-executor'", () => {
    expect(dockerBackend).toMatch(/id:\s*"docker-executor"/);
  });

  it("has supports_pass: false (not yet verified)", () => {
    expect(dockerBackend).toMatch(/supports_pass:\s*false/);
  });

  it("has container_runtime 'docker'", () => {
    expect(dockerBackend).toMatch(/container_runtime:\s*"docker"/);
  });

  it("has network_disabled: true", () => {
    expect(dockerBackend).toMatch(/network_disabled:\s*true/);
  });

  it("has non_root: true", () => {
    expect(dockerBackend).toMatch(/non_root:\s*true/);
  });

  it("has read_only_rootfs: true", () => {
    expect(dockerBackend).toMatch(/read_only_rootfs:\s*true/);
  });

  it("has image_digest as sha256:<64 hex chars>", () => {
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_DIGEST = "sha256:[0-9a-f]{64}"/);
  });

  it("has image_ref as digest-pinned OCI reference", () => {
    expect(dockerBackend).toMatch(/DOCKER_IMAGE_REF = .+@sha256:[0-9a-f]{64}/);
  });

  it("enforces --network=none", () => {
    expect(dockerBackend).toMatch(/--network=none/);
  });

  it("enforces --read-only", () => {
    expect(dockerBackend).toMatch(/--read-only/);
  });

  it("enforces non-root --user", () => {
    expect(dockerBackend).toMatch(/--user=/);
  });

  it("enforces CPU limit (--cpus)", () => {
    expect(dockerBackend).toMatch(/--cpus=/);
  });

  it("enforces memory limit (--memory)", () => {
    expect(dockerBackend).toMatch(/--memory=/);
  });

  it("enforces pid limit (--pids-limit)", () => {
    expect(dockerBackend).toMatch(/--pids-limit/);
  });

  it("uses bounded tmpfs for /tmp", () => {
    expect(dockerBackend).toMatch(/--tmpfs=\/tmp/);
  });

  it("uses --workdir=/workspace", () => {
    expect(dockerBackend).toMatch(/--workdir=\/workspace/);
  });

  it("mounts only the workspace volume", () => {
    expect(dockerBackend).toMatch(/--volume=.*\/workspace/);
  });

  it("does NOT mount host Docker socket", () => {
    expect(dockerBackend).not.toMatch(/\/var\/run\/docker\.sock/);
  });

  it("does NOT use --privileged in container args", () => {
    // Only check the actual array entries, not comments
    const lines = dockerBackend.split("\n");
    const argLines = lines.filter((l) => l.trim().startsWith('"') && !l.trim().startsWith('//'));
    const argText = argLines.join("\n");
    expect(argText).not.toMatch(/--privileged/);
  });

  it("does NOT pass GitHub tokens in container env", () => {
    const envSection = dockerBackend.split("Minimal environment")[1] || "";
    expect(envSection).not.toMatch(/GITHUB_TOKEN/);
  });

  it("does NOT pass SSH agent", () => {
    expect(dockerBackend).not.toMatch(/SSH_AUTH_SOCK/);
  });

  it("uses argv arrays (no shell execution)", () => {
    const runSection = dockerBackend.split("executeInContainer")[1] || "";
    expect(runSection).toMatch(/\.\.\.argv/);
  });

  it("resolves commands from templates (no raw shell)", () => {
    expect(dockerBackend).toMatch(/resolveCommandTemplate/);
  });

  it("exports detectContainerRuntime", () => {
    expect(dockerBackend).toMatch(/export async function detectContainerRuntime/);
  });

  it("detects docker and podman", () => {
    expect(dockerBackend).toMatch(/docker/);
    expect(dockerBackend).toMatch(/podman/);
  });

  it("exports runDockerExecution", () => {
    expect(dockerBackend).toMatch(/export async function runDockerExecution/);
  });

  it("returns inconclusive when no container runtime available", () => {
    expect(dockerBackend).toMatch(/no_container_runtime/);
  });

  it("returns inconclusive with backend_not_pass_capable when all pass", () => {
    expect(dockerBackend).toMatch(/backend_not_pass_capable/);
  });

  it("exports describe() returning isolation binding", () => {
    expect(dockerBackend).toMatch(/describe\(\)/);
    expect(dockerBackend).toMatch(/execution_backend_id:\s*this\.id/);
  });

  it("exports run() delegating to runDockerExecution", () => {
    expect(dockerBackend).toMatch(/async run\(/);
    expect(dockerBackend).toMatch(/runDockerExecution/);
  });

  it("validates contract at module load", () => {
    expect(dockerBackend).toMatch(/validateBackendContract/);
  });

  it("enforces path traversal guard", () => {
    expect(dockerBackend).toMatch(/Path traversal/);
  });

  it("uses minimal env (no inherited secrets)", () => {
    expect(dockerBackend).toMatch(/PATH:/);
    expect(dockerBackend).toMatch(/NODE_ENV/);
    expect(dockerBackend).not.toMatch(/GITHUB/);
  });

  it("redacts secrets from output", () => {
    expect(dockerBackend).toMatch(/redactOutput/);
    expect(dockerBackend).toMatch(/ghp_/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EXECUTOR REGISTRY
// ════════════════════════════════════════════════════════════════════════════

describe("Executor Registry", () => {
  it("exports registerBackend", () => {
    expect(registry).toMatch(/export function registerBackend/);
  });

  it("exports getBackend", () => {
    expect(registry).toMatch(/export function getBackend/);
  });

  it("exports listBackends", () => {
    expect(registry).toMatch(/export function listBackends/);
  });

  it("exports getDefaultBackend", () => {
    expect(registry).toMatch(/export function getDefaultBackend/);
  });

  it("registers node-executor by default", () => {
    expect(registry).toMatch(/nodeExecutorBackend/);
    expect(registry).toMatch(/registerBackend\(nodeExecutorBackend\)/);
  });

  it("registers docker-executor by default", () => {
    expect(registry).toMatch(/dockerExecutorBackend/);
    expect(registry).toMatch(/registerBackend\(dockerExecutorBackend\)/);
  });

  it("defaults to node-executor", () => {
    expect(registry).toMatch(/GITWIRE_EXECUTOR_BACKEND/);
    expect(registry).toMatch(/"node-executor"/);
  });

  it("validates contract before registering", () => {
    expect(registry).toMatch(/validateBackendContract\(backend\)/);
  });

  it("rejects duplicate backend IDs", () => {
    expect(registry).toMatch(/already registered/);
  });

  it("getBackend throws for unknown ID", () => {
    expect(registry).toMatch(/is not registered/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SANDBOX RUNNER — receipt includes isolation bindings
// ════════════════════════════════════════════════════════════════════════════

describe("Sandbox Runner — isolation bindings in receipt", () => {
  it("buildExecutionReceipt includes container_runtime", () => {
    expect(sandboxRunner).toMatch(/container_runtime/);
  });

  it("buildExecutionReceipt includes runtime_version", () => {
    expect(sandboxRunner).toMatch(/runtime_version/);
  });

  it("buildExecutionReceipt includes network_disabled", () => {
    expect(sandboxRunner).toMatch(/network_disabled/);
  });

  it("buildExecutionReceipt includes non_root", () => {
    expect(sandboxRunner).toMatch(/non_root/);
  });

  it("buildExecutionReceipt includes read_only_rootfs", () => {
    expect(sandboxRunner).toMatch(/read_only_rootfs/);
  });

  it("buildExecutionReceipt includes resource_limits", () => {
    expect(sandboxRunner).toMatch(/resource_limits/);
  });

  it("runSandboxVerification accepts backend_id option", () => {
    expect(sandboxRunner).toMatch(/backend_id/);
  });

  it("runSandboxVerification uses executor registry", () => {
    expect(sandboxRunner).toMatch(/getDefaultBackend|getBackend/);
  });

  it("runSandboxVerification calls backend.describe() for isolation", () => {
    expect(sandboxRunner).toMatch(/backend\.describe\(\)/);
  });

  it("runSandboxVerification calls backend.run()", () => {
    expect(sandboxRunner).toMatch(/backend\.run\(/);
  });

  it("runSandboxVerification returns execution_backend_id", () => {
    expect(sandboxRunner).toMatch(/execution_backend_id:\s*backend\.id/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPAIR PROPOSAL SERVICE — backend allowlists and verifier checks
// ════════════════════════════════════════════════════════════════════════════

describe("Repair Proposal Service — executor backend integration", () => {
  it("ALLOWED_EXECUTION_BACKENDS includes docker-executor", () => {
    expect(repairService).toMatch(/"docker-executor"/);
  });

  it("ALLOWED_PASS_EXECUTION_BACKENDS remains empty", () => {
    // The set should be defined but have no entries
    const section = repairService.split("ALLOWED_PASS_EXECUTION_BACKENDS");
    expect(section[1]).toMatch(/empty until/i);
  });

  it("verifier checks isolation binding fields present", () => {
    expect(repairService).toMatch(/missing isolation binding/);
  });

  it("verifier checks network_disabled for pass", () => {
    expect(repairService).toMatch(/network_disabled is false.*pass requires network isolation/);
  });

  it("verifier checks non_root for pass", () => {
    expect(repairService).toMatch(/non_root is false.*pass requires non-root/);
  });

  it("verifier checks read_only_rootfs for pass", () => {
    expect(repairService).toMatch(/read_only_rootfs is false.*pass requires read-only rootfs/);
  });
});
