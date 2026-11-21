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
// console.error to stderr is deliberate: it exists in every state the
// process can be in.

/**
 * Serialize and report a fatal startup error, then exit(1).
 * Never throws and never depends on runtime state.
 *
 * @param {Error|string|unknown} err
 */
export function reportFatalStartupError(err) {
  const serialized = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : (typeof err === "string" ? err : JSON.stringify(err));
  console.error(JSON.stringify({
    level: "fatal",
    msg: "Fatal startup error",
    err: serialized,
  }));
  process.exit(1);
}
