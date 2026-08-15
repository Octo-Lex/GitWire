// RepositoryTools v2 public surface (RI-9 amendment, Phase 2/3).
//
// Four read-only primitives bound to one immutable repository session:
//   read / grep / find / ls
// The provider/model never appears here: this contract is transport- and
// agent-agnostic, so the current GitWire orchestration and a future Pi
// harness call the exact same instrument.

import { read } from "./read.js";
import { grep } from "./grep.js";
import { find } from "./find.js";
import { ls } from "./ls.js";

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
 * operation that produces a result envelope is recorded into the session's
 * audit trace (operation, parameters, status, completeness, budget use) —
 * the reconstructable record of everything the reviewer could and did see.
 */
export function createRepositoryTools(session) {
  const recorded = (operation, fn) => (params) =>
    fn(session, params).then((result) => {
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
      return result;
    });

  return {
    read: recorded("read", read),
    grep: recorded("grep", grep),
    find: recorded("find", find),
    ls: recorded("ls", ls),
  };
}

export { read, grep, find, ls };
