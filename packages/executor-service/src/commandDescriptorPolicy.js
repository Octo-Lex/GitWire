// packages/executor-service/src/commandDescriptorPolicy.js
//
// Authoritative command-descriptor security policy (Task 8D).
//
// This is the SINGLE security boundary for repo-aware command descriptors.
// The web side (@gitwire/core) validates only SHAPE; this module enforces the
// allowlist, metacharacter, and path-traversal rules that make a descriptor
// safe to execute. Fail-closed: any policy violation rejects the descriptor
// and produces a visible rejected command_result (never a silent fallback).
//
// Rules (v1 — deliberately narrow):
//   - requires_shell MUST be false  (descriptor execution is argv-only)
//   - network MUST be "disabled"
//   - argv[0] in {npx, node, tsc}   (npm run is NOT a descriptor path)
//   - npx requires --no-install immediately after argv[0]
//   - no shell metacharacters in any argv element
//   - target_paths: non-empty, all relative, no "..", no globs, no absolute
//   - argv length bounded
//
// SHAPE INVARIANCE NOTE:
// The executor-service is a deliberately standalone, zero-npm-dependency image
// (Dockerfile build context is packages/executor-service/ only). It cannot
// import @gitwire/core at runtime. validateDescriptorShape() is therefore
// inlined here as validateShapeLocal(), DUPLICATING the shape check that also
// lives in @gitwire/core. The two MUST stay behaviorally identical; the parity
// test in tests/commandDescriptorPolicy.test.js ("core parity") pins this by
// importing @gitwire/core at TEST time only (the monorepo's shared
// node_modules/@gitwire/core workspace symlink is available under jest, but NOT
// inside the production image). If you change one, change both + the parity
// test.

const ALLOWED_BINARIES = new Set(["npx", "node", "tsc"]);

// Required non-empty string fields on every descriptor.
const REQUIRED_STRING_FIELDS = ["command_id", "semantic_id", "source"];

/**
 * Local copy of @gitwire/core's validateDescriptorShape.
 * MUST stay byte-for-byte behaviorally identical to packages/core/src/commandDescriptor.js.
 * See the SHAPE INVARIANCE NOTE above; the parity test enforces this.
 *
 * @param {object} d - candidate descriptor
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validateShapeLocal(d) {
  const reasons = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, reasons: ["descriptor must be a plain object"] };
  }
  for (const f of REQUIRED_STRING_FIELDS) {
    if (typeof d[f] !== "string" || d[f].length === 0) {
      reasons.push(`${f} must be a non-empty string`);
    }
  }
  // argv must be a non-empty array of strings.
  if (!Array.isArray(d.argv) || d.argv.length === 0 ||
      !d.argv.every(a => typeof a === "string" && a.length > 0)) {
    reasons.push("argv must be a non-empty string array");
  }
  // target_paths must be a non-empty array of strings (files-only is a
  // security-policy concern enforced below; here we only check it is a string
  // array).
  if (!Array.isArray(d.target_paths) || d.target_paths.length === 0 ||
      !d.target_paths.every(p => typeof p === "string" && p.length > 0)) {
    reasons.push("target_paths must be a non-empty string array");
  }
  return { ok: reasons.length === 0, reasons };
}

const MAX_ARGV_LENGTH = 64;

// Shell metacharacters forbidden in argv elements. Note: argv is passed
// WITHOUT a shell (spawn argv form), so these can't actually inject — but we
// reject them anyway as defense-in-depth against any future shell path.
const SHELL_METACHARS = /[;&|`$(){}<>\n\r\t\\]/;

/**
 * Enforce the authoritative security policy on a command descriptor.
 *
 * @param {object} descriptor
 * @returns {{ ok: boolean, reasons: string[] }}
 *   ok=true → safe to execute. ok=false → reject fail-closed; the caller
 *   records a rejected command_result carrying `reasons`.
 */
export function enforceDescriptorPolicy(descriptor) {
  // First the shared shape check. A shape-invalid descriptor is also
  // policy-invalid, but the reasons are reported distinctly.
  const shape = validateShapeLocal(descriptor);
  if (!shape.ok) {
    return {
      ok: false,
      reasons: shape.reasons.map(r => `descriptor shape invalid: ${r}`),
    };
  }

  const reasons = [];

  // requires_shell must be false.
  if (descriptor.requires_shell !== false) {
    reasons.push("requires_shell must be false (argv-only execution)");
  }

  // network must be disabled.
  if (descriptor.network !== "disabled") {
    reasons.push("network must be 'disabled'");
  }

  const argv = descriptor.argv;

  // argv length bound.
  if (argv.length > MAX_ARGV_LENGTH) {
    reasons.push(`argv exceeds max length (${MAX_ARGV_LENGTH})`);
  }

  // Binary allowlist.
  const binary = argv[0];
  if (!ALLOWED_BINARIES.has(binary)) {
    reasons.push(`binary '${binary}' is not allowlisted (allowed: npx, node, tsc)`);
  }

  // No shell metacharacters in any argv element.
  for (const a of argv) {
    if (SHELL_METACHARS.test(a)) {
      reasons.push(`argv element contains shell metacharacters: ${JSON.stringify(a)}`);
      break;
    }
  }

  // npx requires --no-install immediately after.
  if (binary === "npx") {
    if (argv[1] !== "--no-install") {
      reasons.push("npx requires --no-install immediately after the binary");
    }
  }

  // target_paths: explicit relative files only.
  const targetPaths = descriptor.target_paths;
  if (!Array.isArray(targetPaths) || targetPaths.length === 0) {
    reasons.push("target_paths must be a non-empty array");
  } else {
    for (const p of targetPaths) {
      if (typeof p !== "string" || p.length === 0) {
        reasons.push(`target_path must be a non-empty string: ${JSON.stringify(p)}`);
        continue;
      }
      if (p === "." || p === "..") {
        reasons.push(`target_path must be an explicit file, not '${p}'`);
      }
      if (p.includes("*") || p.includes("?")) {
        reasons.push(`target_path must not contain glob characters: ${p}`);
      }
      if (p.startsWith("/")) {
        reasons.push(`target_path must be relative, not absolute: ${p}`);
      }
      if (p.includes("..")) {
        reasons.push(`target_path must not contain traversal (..): ${p}`);
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
