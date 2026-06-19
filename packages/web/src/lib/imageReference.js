// src/lib/imageReference.js
// Immutable OCI image reference parser and validator.
//
// Parses and validates image references into their component parts.
// Only digest-pinned references are accepted — tags and labels are rejected.
//
// A valid immutable image reference has the shape:
//   registry/repo/image@sha256:<64 hex chars>
//   localhost:5000/gitwire-validator@sha256:abc123...
//   docker.io/library/gitwire-validator@sha256:abc123...
//
// The following are REJECTED:
//   gitwire-validator:latest     (tag, not digest)
//   gitwire-validator:v1         (tag, not digest)
//   sha256:gitwire-validator-v1  (governance label, not a real digest)
//   registry/image:tag           (tag, not digest)
//   registry/image               (no digest)

import crypto from "crypto";

/**
 * Regex for a valid SHA-256 digest (64 hex chars).
 */
const DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Regex for a valid image reference with digest.
 *
 * Captures:
 *   group 1: host[:port]/repo(s)/image  (the repository path)
 *   group 2: sha256:<hex64>              (the digest)
 *
 * The repository path must contain at least one path component (the image name).
 * It MAY contain a registry host with optional port, and intermediate repos.
 */
const IMAGE_REF_REGEX = /^(.+@)?(sha256:[0-9a-f]{64})$/;

/**
 * Parse an image reference string into { registry_path, image_name, image_digest, image_ref }.
 *
 * Accepts two forms:
 *   1. "registry/repo/image@sha256:..."  → full reference with registry path
 *   2. "sha256:..."                       → bare digest (registry path inferred separately)
 *
 * For form 2, only the digest is returned — the caller must provide the
 * full immutable reference via a separate configuration.
 *
 * @param {string} ref - image reference string
 * @returns {{ registry_path: string|null, image_digest: string, image_ref: string, image_name: string|null }}
 * @throws {Error} if the reference is not digest-pinned
 */
export function parseImageReference(ref) {
  if (!ref || typeof ref !== "string") {
    throw new Error("Image reference must be a non-empty string");
  }

  // Form 2: bare digest
  if (DIGEST_REGEX.test(ref)) {
    return {
      registry_path: null,
      image_name: null,
      image_digest: ref,
      image_ref: ref,
    };
  }

  // Form 1: full reference with registry path + @sha256:...
  const match = ref.match(IMAGE_REF_REGEX);
  if (!match) {
    throw new Error(
      `Image reference '${ref}' is not digest-pinned — must be registry/repo/image@sha256:<64 hex chars>`
    );
  }

  // match[1] is "registry/repo/image@" or undefined
  // match[2] is "sha256:<hex64>"
  const registryPath = match[1] ? match[1].replace(/@$/, "") : null;
  const imageDigest = match[2];

  // Extract the image name (last path component)
  let imageName = null;
  if (registryPath) {
    const parts = registryPath.split("/");
    imageName = parts[parts.length - 1];
  }

  return {
    registry_path: registryPath,
    image_name: imageName,
    image_digest: imageDigest,
    image_ref: ref,
  };
}

/**
 * Validate that an image reference is digest-pinned.
 * Rejects tags, labels, and bare repository names.
 *
 * @param {string} ref
 * @throws {Error} if the reference is not digest-pinned
 */
export function validateDigestPinned(ref) {
  parseImageReference(ref); // throws on invalid
}

/**
 * Check if an image reference is digest-pinned.
 *
 * @param {string} ref
 * @returns {boolean}
 */
export function isDigestPinned(ref) {
  try {
    parseImageReference(ref);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Extract just the digest from a reference string.
 * Returns "sha256:<hex64>" or throws.
 *
 * @param {string} ref
 * @returns {string}
 */
export function extractDigest(ref) {
  const parsed = parseImageReference(ref);
  return parsed.image_digest;
}

/**
 * Compute the image digest of a content buffer.
 * This is used to create synthetic digest references for testing.
 *
 * @param {string|Buffer} content
 * @returns {string} sha256:<hex64>
 */
export function computeImageDigest(content) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build a full immutable image reference from a registry path and digest.
 *
 * @param {string} registryPath - e.g., "docker.io/gitwire/validator"
 * @param {string} digest - e.g., "sha256:abc123..."
 * @returns {string} "registryPath@sha256:abc123..."
 */
export function buildImageRef(registryPath, digest) {
  validateDigestPinned(digest);
  return `${registryPath}@${digest}`;
}

/**
 * Compare two image digests for equality.
 * Both must be valid sha256:<hex64> strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 * @throws {Error} if either is not a valid digest
 */
export function digestsMatch(a, b) {
  if (!DIGEST_REGEX.test(a)) {
    throw new Error(`Invalid digest: ${a}`);
  }
  if (!DIGEST_REGEX.test(b)) {
    throw new Error(`Invalid digest: ${b}`);
  }
  return a === b;
}
