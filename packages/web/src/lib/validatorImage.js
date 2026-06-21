// src/lib/validatorImage.js
// Validator image identity resolution (Gap 1 Phase 2).
//
// The production validator image must have IMMUTABLE identity. This module
// resolves that identity from configuration and reports whether it is
// complete enough to authorize pass-capable validator execution.
//
// Required identity fields (per docs/architecture/validator-execution-model.md):
//   validator_image_ref     — full registry/repo/image@sha256:<hex64>
//   validator_image_digest  — sha256:<hex64>, must match the ref's digest
//
// Design notes:
// - Reads process.env directly (lazy, import-safe). The Zod config layer
//   (config/index.js) ALSO validates these keys at boot; this module is the
//   runtime read site used by the sandbox runner + receipt builder.
// - A ref whose embedded digest does not match the standalone
//   GITWIRE_VALIDATOR_IMAGE_DIGEST is treated as identity-incomplete.
//   Two different digests for "the same" image is a config error, not pass proof.
// - The test-fixture ref (used by dockerExecutorBackend in non-production) is
//   NOT a complete production identity and is never identity-complete here
//   unless GITWIRE_ALLOW_TEST_FIXTURE=1.

import { parseImageReference } from "./imageReference.js";

// Required identity fields. Exported so tests + receipts can reference the
// single source of truth for what "immutable identity" means.
export const VALIDATOR_IMAGE_REQUIRED_FIELDS = Object.freeze(["ref", "digest"]);

/**
 * Resolve the configured validator image identity.
 *
 * @returns {{
 *   configured: boolean,
 *   ref: string|null,
 *   digest: string|null,
 *   identity_complete: boolean,
 *   missing: string[],
 * }}
 */
export function resolveValidatorImage() {
  const ref = process.env.GITWIRE_VALIDATOR_IMAGE_REF || null;
  const envDigest = process.env.GITWIRE_VALIDATOR_IMAGE_DIGEST || null;

  const missing = [];
  if (!ref) missing.push("ref");
  if (!envDigest) missing.push("digest");

  const configured = Boolean(ref);

  // Cross-check: if a ref is set, its embedded digest must equal the
  // standalone GITWIRE_VALIDATOR_IMAGE_DIGEST. A mismatch is a config error
  // and means identity is not proven.
  let refDigest = null;
  if (ref) {
    try {
      refDigest = parseImageReference(ref).image_digest;
    } catch {
      // ref is not parseable as digest-pinned — record as missing field
      missing.push("ref_digest_pinned");
      refDigest = null;
    }
  }

  let digestMatch = true;
  if (refDigest && envDigest && refDigest !== envDigest) {
    digestMatch = false;
    missing.push("digest_match");
  }

  const identity_complete =
    configured &&
    Boolean(envDigest) &&
    Boolean(refDigest) &&
    digestMatch;

  return {
    configured,
    ref,
    digest: envDigest,
    identity_complete,
    missing,
  };
}

/**
 * Convenience predicate.
 * @param {ReturnType<resolveValidatorImage>} [resolved]
 * @returns {boolean}
 */
export function isValidatorIdentityComplete(resolved) {
  return Boolean((resolved || resolveValidatorImage()).identity_complete);
}
