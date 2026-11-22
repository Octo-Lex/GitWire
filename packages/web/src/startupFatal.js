// src/startupFatal.js
// Fatal-startup reporting that depends on NOTHING from the runtime.
//
// The runtime logger is initialized INSIDE main() (index.js), so an early
// rejection (db/redis init, config, port bind) reaches the fatal handler
// before any logger exists. index.js's previous catch referenced that
// inner `logger`, replacing the original startup error with a
// ReferenceError and masking the root cause — observed live in the
// 2026-11-21 incident, where the real trigger (Redis AOF MISCONF under a
// full disk) was hidden behind "logger is not defined" in a crash loop.
//
// Robustness contract (each clause born of a review finding):
// - writeSync(2, …) — SYNCHRONOUS stderr write; console.error to a pipe
//   is asynchronous and process.exit() can truncate it, losing the fatal
//   line exactly when it matters most.
// - serialization is total: circular structures, BigInt, symbols, and
//   anything else JSON.stringify cannot express degrade to a
//   deterministic string — the handler can NEVER throw and re-mask the
//   original failure.
// - one canonical error shape: {kind, message, stack?} with a
//   `raw` fallback for non-Error rejections.

import { writeSync } from "node:fs";

function serializeRejection(err) {
  if (err instanceof Error) {
    return { kind: err.name, message: err.message, stack: err.stack };
  }
  if (typeof err === "string") return { kind: "string", message: err };
  try {
    return { kind: "object", raw: JSON.stringify(err) };
  } catch {
    // Circular / BigInt / symbol-bearing values: degrade, never throw.
    return { kind: "unserializable", message: String(err) };
  }
}

/**
 * Report a fatal startup error and exit(1). Never throws and never
 * depends on runtime state.
 * @param {Error|string|unknown} err
 */
export function reportFatalStartupError(err) {
  let line;
  try {
    line = JSON.stringify({
      level: "fatal",
      msg: "Fatal startup error",
      err: serializeRejection(err),
    });
  } catch {
    line = JSON.stringify({
      level: "fatal",
      msg: "Fatal startup error",
      err: { kind: "unserializable", message: String(err) },
    });
  }
  try {
    writeSync(2, line + "\n");
  } catch {
    // stderr itself unwritable (closed pipe): nothing further to do; the
    // exit code still communicates the failure.
  }
  process.exit(1);
}
