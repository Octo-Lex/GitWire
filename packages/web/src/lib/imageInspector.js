// src/lib/imageInspector.js
// Runtime image identity verification for container execution.
//
// After (or before) executing validation commands in a container, the
// executor must verify that the runtime used the exact pinned image.
// This module queries `docker inspect` / `podman inspect` to extract
// the resolved image digest and compares it to the configured digest.
//
// If the runtime cannot resolve the image digest, or the digest does
// not match the pinned value, the execution is rejected (fail-closed).
//
// This is the "do not trust only the configured string" principle.

import { spawn } from "child_process";
import crypto from "crypto";
import { logger } from "./logger.js";
import { digestsMatch } from "./imageReference.js";

/**
 * Inspect a container's image identity via `docker inspect` or `podman inspect`.
 *
 * Queries the runtime for the container's image digest. Returns:
 *   { runtime, image_id, image_digest, repo_digests }
 *
 * @param {string} runtime - "docker" or "podman"
 * @param {string} containerId - container ID or name
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<object|null>} inspection result, or null on failure
 */
export async function inspectContainerImage(runtime, containerId, timeoutMs = 10000) {
  try {
    const output = await runCommand(runtime, [
      "inspect",
      "--format",
      "{{json .Image}}",  // image ID (sha256:...)
      containerId,
    ], timeoutMs);

    if (!output) return null;

    // .Image is the image ID (config digest), e.g., "sha256:abc123..."
    // We also need the repo digests from the image itself
    const imageDigestOutput = await runCommand(runtime, [
      "inspect",
      "--format",
      "{{json .RepoDigests}}",
      containerId,
    ], timeoutMs);

    let repoDigests = [];
    if (imageDigestOutput) {
      try {
        repoDigests = JSON.parse(imageDigestOutput);
      } catch (_e) {
        // Not JSON, try raw parse
        repoDigests = [];
      }
    }

    // Extract the manifest digest from repo digests
    // RepoDigests look like: ["docker.io/gitwire/validator@sha256:abc123..."]
    let imageDigest = null;
    if (Array.isArray(repoDigests) && repoDigests.length > 0) {
      for (const rd of repoDigests) {
        const match = rd.match(/(sha256:[0-9a-f]{64})/);
        if (match) {
          imageDigest = match[1];
          break;
        }
      }
    }

    // Fall back to image ID if no repo digest found
    const imageId = output.trim().replace(/"/g, "");

    return {
      runtime,
      container_id: containerId,
      image_id: imageId,
      image_digest: imageDigest || imageId,
      repo_digests: repoDigests || [],
    };
  } catch (err) {
    logger.error({ err: err.message, runtime, containerId }, "Container image inspection failed");
    return null;
  }
}

/**
 * Inspect an image's identity directly (without a running container).
 *
 * @param {string} runtime - "docker" or "podman"
 * @param {string} imageRef - image reference or ID
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<object|null>}
 */
export async function inspectImage(runtime, imageRef, timeoutMs = 10000) {
  try {
    const output = await runCommand(runtime, [
      "inspect",
      "--format",
      "{{json .}}",
      imageRef,
    ], timeoutMs);

    if (!output) return null;

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (_e) {
      return null;
    }

    // Extract repo digests
    const repoDigests = parsed.RepoDigests || parsed.repoDigests || [];
    let imageDigest = null;
    if (Array.isArray(repoDigests) && repoDigests.length > 0) {
      for (const rd of repoDigests) {
        const match = rd.match(/(sha256:[0-9a-f]{64})/);
        if (match) {
          imageDigest = match[1];
          break;
        }
      }
    }

    return {
      runtime,
      image_ref: imageRef,
      image_id: parsed.Id || parsed.id || null,
      image_digest: imageDigest,
      repo_digests: repoDigests,
    };
  } catch (err) {
    logger.error({ err: err.message, runtime, imageRef }, "Image inspection failed");
    return null;
  }
}

/**
 * Verify that a runtime-resolved image digest matches the pinned digest.
 * Fails closed if the inspection fails or the digests don't match.
 *
 * @param {object} inspection - result from inspectContainerImage or inspectImage
 * @param {string} pinnedDigest - expected sha256:<hex64>
 * @throws {Error} if inspection is null or digest doesn't match
 */
export function verifyImageIdentity(inspection, pinnedDigest) {
  if (!inspection) {
    throw new Error(
      "Image identity verification failed: inspection returned no result — cannot verify container used the pinned image"
    );
  }

  if (!inspection.image_digest) {
    throw new Error(
      "Image identity verification failed: inspection did not resolve an image digest — fail-closed"
    );
  }

  if (!digestsMatch(inspection.image_digest, pinnedDigest)) {
    throw new Error(
      `Image identity mismatch: inspected digest '${inspection.image_digest}' does not match pinned '${pinnedDigest}'`
    );
  }
}

/**
 * Run a command and capture stdout. Returns null on failure.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
      detached: false,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch (_e) {}
        resolve(null);
      }
    }, timeoutMs);

    child.stdout?.on("data", (data) => { stdout += data.toString("utf-8"); });
    child.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(stdout.trim());
      }
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

/**
 * Compute a canonical content-addressed hash over a normalized inspection
 * object. This is used to persist a durable audit-grade proof that the
 * runtime resolved the exact pinned image.
 *
 * The canonical form normalizes the inspection to its binding fields only:
 *   { runtime, image_id, image_digest, repo_digests }
 *
 * @param {object} inspection - result from inspectContainerImage or inspectImage
 * @returns {string} sha256:<hex64>
 */
export function computeInspectionHash(inspection) {
  if (!inspection) {
    throw new Error("computeInspectionHash: inspection is required");
  }

  const canonical = JSON.stringify({
    runtime: inspection.runtime || null,
    image_id: inspection.image_id || null,
    image_digest: inspection.image_digest || null,
    repo_digests: Array.isArray(inspection.repo_digests)
      ? [...inspection.repo_digests].sort()
      : [],
  });

  return "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex");
}
