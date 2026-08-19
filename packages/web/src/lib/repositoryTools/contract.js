// RepositoryTools v2 result contract (RI-9 amendment, Phase 2).
//
// The model-facing public surface is exactly four read-only primitives:
// read / grep / find / ls. Every operation returns ONE envelope whose
// completeness semantics are frozen here as code, not prompt advice:
//
//   matches = [] && complete = true   → authoritative absence in scope
//   matches = [] && complete = false  → unknown / partial — NEVER absence
//   error                            ≠ absence (a tool error is never a
//                                      successful textual "No matches found")
//
// Status carries execution + totality together:
//   "success" ⇔ complete === true
//   "partial" ⇔ complete === false with ≥1 partialReason (backend ran, but
//               the evidence is not exhaustive)
//   "error"   ⇔ complete === false with an error code (backend failed)

export const TOOL_OPERATIONS = Object.freeze(["read", "grep", "find", "ls"]);

// Stable identity of this contract for execution-profile telemetry (RI-9
// Phase 10). Version tracks the frozen semantics above: "2" is the
// RepositoryTools v2 contract (typed completeness, negative-evidence
// invariant). Descriptive metadata only — never consulted by review policy.
export const TOOL_CONTRACT_NAME = Object.freeze("gitwire-repository-tools");
export const TOOL_CONTRACT_VERSION = Object.freeze("2");

export const RESULT_STATUSES = Object.freeze(["success", "partial", "error"]);

// Extensible beyond the amendment's minimum set: unfaithful_scope marks a
// scope whose snapshot content is not faithfully recoverable, so absence
// inside that scope cannot be claimed.
export const PARTIAL_REASONS = Object.freeze([
  "result_limit",
  "output_bytes",
  "output_lines",
  "timeout",
  "cancelled",
  "unfaithful_scope",
]);

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "E_INVALID_INPUT",
  SESSION_CLOSED: "E_SESSION_CLOSED",
  PATH_ESCAPE: "E_PATH_ESCAPE",
  PATH_NOT_FOUND: "E_PATH_NOT_FOUND",
  PATH_IS_DIRECTORY: "E_PATH_IS_DIRECTORY",
  PATH_IS_FILE: "E_PATH_IS_FILE",
  UNFAITHFUL_BLOB: "E_UNFAITHFUL_BLOB",
  PATTERN_INVALID: "E_PATTERN_INVALID",
  SCOPE_INVALID: "E_SCOPE_INVALID",
  BACKEND_FAILED: "E_BACKEND_FAILED",
  PARSE_FAILED: "E_PARSE_FAILED",
});

/** Canonical collection field per enumerable operation. */
const COLLECTION_FIELD = Object.freeze({
  grep: "matches",
  find: "paths",
  ls: "entries",
});

/** UTF-8 byte length of a string (the delivery accounting unit). */
export function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export class ContractViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractViolation";
  }
}

/**
 * Build a frozen tool-result envelope.
 *
 * @param {object} input
 * @param {"read"|"grep"|"find"|"ls"} input.operation
 * @param {object} input.session the repository session (identity source)
 * @param {"success"|"partial"|"error"} input.status
 * @param {number} input.startedAt performance.now() at operation start
 * @param {*} [input.data] payload (must be undefined for errors)
 * @param {string[]} [input.partialReasons] required for "partial"
 * @param {{code: string, message: string}} [input.error] required for "error"
 * @param {number} [input.returnedBytes] UTF-8 bytes of delivered payload
 * @param {number} [input.returnedItems] delivered item count
 * @returns {object} frozen envelope
 */
export function makeResult(input) {
  const {
    operation,
    session,
    status,
    startedAt,
    data,
    partialReasons = [],
    error,
    returnedBytes = 0,
    returnedItems,
  } = input;

  const result = {
    status,
    complete: status === "success",
    repositorySessionId: session.id,
    headSha: session.headSha,
    snapshotRef: session.snapshotRefs?.head ?? null,
    operation,
    durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    data,
    returnedBytes,
    ...(returnedItems !== undefined ? { returnedItems } : {}),
    partialReasons: Object.freeze([...partialReasons]),
    ...(error ? { error } : {}),
  };
  assertResultInvariants(result);
  return Object.freeze(result);
}

/**
 * Mechanical invariant check for a tool-result envelope. Throws
 * ContractViolation on any shape that could misrepresent evidence.
 */
export function assertResultInvariants(result) {
  if (!TOOL_OPERATIONS.includes(result.operation)) {
    throw new ContractViolation(`unknown operation: ${result.operation}`);
  }
  if (!RESULT_STATUSES.includes(result.status)) {
    throw new ContractViolation(`unknown status: ${result.status}`);
  }
  for (const reason of result.partialReasons ?? []) {
    if (!PARTIAL_REASONS.includes(reason)) {
      throw new ContractViolation(`unknown partialReason: ${reason}`);
    }
  }
  if (result.status === "success" && result.complete !== true) {
    throw new ContractViolation("success result must be complete");
  }
  if (result.status === "success" && result.partialReasons.length !== 0) {
    throw new ContractViolation("success result cannot carry partialReasons");
  }
  if (result.status === "partial" && result.complete !== false) {
    throw new ContractViolation("partial result must not be complete");
  }
  if (result.status === "partial" && result.partialReasons.length === 0) {
    throw new ContractViolation("partial result requires ≥1 partialReason");
  }
  if (result.status === "error") {
    if (result.complete !== false) throw new ContractViolation("error result must not be complete");
    if (result.data !== undefined) throw new ContractViolation("error result must not carry data");
    if (!result.error || typeof result.error.code !== "string") {
      throw new ContractViolation("error result requires error.code");
    }
  } else if (result.error !== undefined) {
    throw new ContractViolation("non-error result must not carry error");
  }
  return true;
}

/**
 * The negative-evidence invariant: an enumerable operation whose collection
 * is empty AND whose execution was complete asserts AUTHORITATIVE ABSENCE
 * in the declared scope. Anything else (partial, error) asserts nothing.
 *
 * `read` has no absence semantics — it returns false by definition.
 */
export function isAuthoritativeAbsence(result) {
  const field = COLLECTION_FIELD[result.operation];
  if (!field) return false;
  return (
    result.status === "success" &&
    result.complete === true &&
    Array.isArray(result.data?.[field]) &&
    result.data[field].length === 0
  );
}

/**
 * Stable, receipt-facing completeness description. This string must survive
 * tool → transcript → ReviewEvidence → receipt unchanged, so downstream
 * layers can never silently reinterpret a partial result as exhaustive.
 */
export function describeCompleteness(result) {
  if (result.status === "error") return `error:${result.error.code}`;
  if (result.status === "partial") return `partial:${result.partialReasons.slice().sort().join("+")}`;
  return "complete";
}
