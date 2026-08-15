// RepositoryTools v2 public surface (RI-9 amendment, Phase 2/3).
//
// Four read-only primitives bound to one immutable repository session:
//   read / grep / find / ls
// The provider/model never appears here: this contract is transport- and
// agent-agnostic, so the current GitWire orchestration and a future Pi
// harness call the exact same instrument.
//
// ENVELOPE BOUNDARY INVARIANT: every invocation through createRepositoryTools()
// resolves to a contract envelope — success | partial | error. Malformed or
// out-of-range arguments (normal stochastic-agent behavior) become
// E_INVALID_INPUT error envelopes; unexpected backend exceptions become
// E_BACKEND_FAILED error envelopes; nothing rejects. Every outcome,
// including these errors, is recorded in the session audit trace (a closed
// session cannot record — its trace is final by then).

import { read } from "./read.js";
import { grep } from "./grep.js";
import { find } from "./find.js";
import { ls } from "./ls.js";
import { makeResult, ERROR_CODES } from "./contract.js";

/** Map a caught exception to a canonical contract error code. */
function canonicalErrorCode(err) {
  if (err && typeof err.code === "string") {
    if (err.code === "E_INVALID_INPUT") return ERROR_CODES.INVALID_INPUT;
    if (err.code === "E_SESSION_CLOSED") return ERROR_CODES.SESSION_CLOSED;
  }
  return ERROR_CODES.BACKEND_FAILED;
}

/** JSON-safe parameter summary for the audit trace (drops signals, keeps scope). */
function summarizeParams(params) {
  if (!params || typeof params !== "object") return {};
  const summary = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "signal") {
      summary.signal = value?.aborted === true ? "aborted" : "active";
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
      if (value !== undefined) summary[key] = value;
    } else {
      summary[key] = "(non-serializable)";
    }
  }
  return summary;
}

/**
 * Bind the four repository primitives to a prepared session. Every
 * invocation resolves to a frozen contract envelope and is recorded into
 * the session's audit trace (operation, parameters, status, completeness,
 * budget use) — the reconstructable record of everything the reviewer
 * could and did see, including failed invocations.
 */
export function createRepositoryTools(session) {
  const guarded = (operation, fn) => async (params) => {
    const startedAt = performance.now();
    let result;
    try {
      result = await fn(session, params);
    } catch (err) {
      result = makeResult({
        operation,
        session,
        status: "error",
        startedAt,
        error: {
          code: canonicalErrorCode(err),
          message: err && err.message ? err.message : String(err),
        },
      });
    }
    // A closed session cannot record further operations; its trace is
    // already final. Everything else — success, partial, and error
    // envelopes alike — is audited here.
    if (!session._closed) {
      session.recordOperation({
        operation,
        params: summarizeParams(params),
        status: result.status,
        complete: result.complete,
        partialReasons: [...result.partialReasons],
        durationMs: result.durationMs,
        returnedBytes: result.returnedBytes,
        ...(result.returnedItems !== undefined ? { returnedItems: result.returnedItems } : {}),
        ...(result.error ? { errorCode: result.error.code } : {}),
      });
    }
    return result;
  };

  return {
    read: guarded("read", read),
    grep: guarded("grep", grep),
    find: guarded("find", find),
    ls: guarded("ls", ls),
  };
}

// Unwrapped internals — usable directly, but the always-envelope guarantee
// holds only at the createRepositoryTools() boundary.
export { read, grep, find, ls };
