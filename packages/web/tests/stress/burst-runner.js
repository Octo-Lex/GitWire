// packages/web/tests/stress/burst-runner.js
//
// Factual burst accounting for GitWire stress tests and benchmark.
//
// Replaces the old boundedBurst semantics where a fulfilled Promise counted
// as "success" regardless of HTTP status. Each operation produces a structured
// outcome separating transport completion from HTTP status from body parsing
// from semantic assertion (the last deferred to PR2b).
//
// The runner is runtime-neutral: it schedules operation descriptors and
// produces aggregates. HTTP-specific classification (transport errors, body
// states) lives in httpOperation(), which wraps fetch and produces a
// ClassifiedOutcome. The runner never imports fetch.

// ─── Named error codes ─────────────────────────────────────────────────────

const EMPTY_WORKLOAD = "EMPTY_WORKLOAD";
const EMPTY_SAMPLE = "EMPTY_SAMPLE";
const INVALID_ELAPSED_TIME = "INVALID_ELAPSED_TIME";
const BURST_OPERATION_REJECTED = "BURST_OPERATION_REJECTED";
const INVALID_OUTCOME = "INVALID_OUTCOME";

// ─── Transport-error taxonomy ──────────────────────────────────────────────

const TRANSPORT_CATEGORIES = new Set([
  "dns", "connection_refused", "connection_reset", "timeout",
  "abort", "tls", "protocol", "other",
]);

const CODE_TO_CATEGORY = {
  ENOTFOUND: "dns",
  EAI_AGAIN: "dns",
  ECONNREFUSED: "connection_refused",
  ECONNRESET: "connection_reset",
  EPIPE: "connection_reset",
  UND_ERR_SOCKET: "connection_reset",
  ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout",
  UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
  // TLS errors
  CERT_HAS_EXPIRED: "tls",
  CERT_NOT_YET_VALID: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  ERR_TLS_INVALID_PROTOCOL_METHOD: "tls",
  ERR_SSL_INTERNAL_ERROR: "tls",
  // Protocol / HTTP parser errors
  HPE_INVALID_CONSTANT: "protocol",
  HPE_INVALID_VERSION: "protocol",
  HPE_INVALID_STATUS: "protocol",
  HPE_INVALID_HEADER_TOKEN: "protocol",
  HPE_INVALID_CONTENT_LENGTH: "protocol",
  UND_ERR_INVALID_REDIRECT: "protocol",
  UND_ERR_REQUEST_TIMEOUT: "protocol",
};

/**
 * Classify a transport error into the frozen taxonomy. Inspects:
 *   1. the error itself (code, name)
 *   2. its cause chain (bounded ~5 hops to prevent cycles)
 *   3. known Undici codes
 *   4. name-based abort detection
 *
 * Normalized message is sanitized: no secrets, credential URLs, or full
 * payloads. Only the category, original name/code, and a safe message.
 *
 * @param {Error} err
 * @returns {{ category: string, name: string | null, code: string | null, message: string }}
 */
export function classifyTransportError(err) {
  if (!err || typeof err !== "object") {
    return { category: "other", name: null, code: null, message: "unknown error" };
  }
  const name = err.name || null;
  const code = err.code || null;

  // Walk the cause chain (bounded) collecting the first recognized code.
  let foundCode = code;
  let foundName = name;
  let hop = 0;
  let cursor = err;
  while (cursor && hop < 5) {
    const c = cursor.code || (cursor.cause && cursor.cause.code);
    if (c && CODE_TO_CATEGORY[c]) { foundCode = c; break; }
    // Name-based abort detection (may appear on cause, not top-level).
    if (cursor.name === "AbortError") { foundName = "AbortError"; break; }
    // Code-based abort detection (ABORT_ERR may appear on cause).
    if (cursor.code === "ABORT_ERR" || (cursor.cause && cursor.cause.code === "ABORT_ERR")) {
      foundCode = "ABORT_ERR"; break;
    }
    cursor = cursor.cause;
    hop++;
  }

  // Abort detection (name-based or code-based, including nested).
  if (foundName === "AbortError" || code === "ABORT_ERR" || foundCode === "ABORT_ERR") {
    return { category: "abort", name, code, message: sanitizeMessage(err.message) };
  }

  const category = (foundCode && CODE_TO_CATEGORY[foundCode]) || "other";
  return { category, name, code: foundCode || code, message: sanitizeMessage(err.message) };
}

/**
 * Strip credentials, URLs, tokens, and authorization headers from an error
 * message. Applied globally — to transport errors, body errors, AND fatal
 * operation-rejection causes. Redacts:
 *   - URLs with credentials (http(s)://user:pass@host)
 *   - Bearer tokens (Authorization: Bearer ...)
 *   - Token-like query parameters (?token=..., &api_key=..., etc.)
 *   - Long base64/hex blobs that might be tokens
 */
function sanitizeMessage(msg) {
  if (typeof msg !== "string") return "transport error";
  let s = msg;
  // Remove URLs with credentials or paths.
  s = s.replace(/https?:\/\/[^\s"']+/g, "<url>");
  // Remove Authorization header values (Bearer <token>, Basic <base64>, etc.).
  s = s.replace(/[Aa]uthorization:\s*\S+\s+\S+/g, "<auth-header>");
  s = s.replace(/[Bb]earer\s+[A-Za-z0-9._-]+/g, "<bearer-token>");
  // Remove token-like query parameters.
  s = s.replace(/[?&](token|api_key|apikey|access_token|secret|password)=[^&\s"']+/g, "<redacted-param>");
  // Truncate long strings that might contain tokens or payloads.
  if (s.length > 200) s = s.slice(0, 200) + "...";
  return s;
}

// ─── Body-mode JSON detection ──────────────────────────────────────────────

/**
 * Determine whether a content-type string indicates JSON, per the frozen
 * `auto` rules:
 *   application/json                       → json
 *   application/json; charset=utf-8        → json  (params stripped)
 *   application/problem+json               → json  (any application/*+json)
 *   application/vnd.api+json               → json
 *   text/json                              → text  (NOT json unless added)
 *   text/html                              → text
 *   missing/null/empty                     → text
 *
 * Case-insensitive.
 * @param {string | null} contentType
 * @returns {"json" | "text"}
 */
export function detectJsonContentType(contentType) {
  if (!contentType) return "text";
  // Strip parameters (e.g. "; charset=utf-8"), lowercase.
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "application/json") return "json";
  // application/*+json (e.g. application/problem+json, application/vnd.api+json)
  if (/^application\/[a-z0-9.+-]*\+json$/.test(base)) return "json";
  return "text";
}

// ─── httpOperation ─────────────────────────────────────────────────────────

/**
 * Execute an HTTP operation and classify its outcome. The `execute` callback
 * performs the actual fetch and returns a Response; only it is inside the
 * transport-error catch. Body read/parse failures are classified distinctly
 * from transport failures so the HTTP status is preserved.
 *
 * @param {Object} opts
 * @param {string} opts.method
 * @param {"none"|"text"|"json"|"auto"} [opts.bodyMode="auto"]
 * @param {() => Promise<Response>} opts.execute
 * @returns {Promise<ClassifiedOutcome>}
 */
export async function httpOperation({ method, bodyMode = "auto", execute }) {
  let response;
  try {
    response = await execute();
  } catch (err) {
    const c = classifyTransportError(err);
    return {
      transport: "failed",
      status: null,
      body: { state: "not_read", value: null, error: null },
      error: c,
    };
  }

  const status = response.status;

  // Body handling. bodyMode controls whether/how the body is consumed.
  if (bodyMode === "none") {
    return {
      transport: "completed",
      status,
      body: { state: "not_read", value: null, error: null },
      error: null,
    };
  }

  // Read the body text. This can fail after headers arrived.
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return {
      transport: "completed",
      status,
      body: {
        state: "read_failed",
        value: null,
        error: { category: "body_read", message: sanitizeMessage(err.message) },
      },
      error: null,
    };
  }

  // Empty body → empty regardless of content type.
  if (text === "") {
    return {
      transport: "completed",
      status,
      body: { state: "empty", value: null, error: null },
      error: null,
    };
  }

  // Decide parse strategy.
  const contentType = response.headers ? response.headers.get("content-type") : null;
  const kind = bodyMode === "auto"
    ? detectJsonContentType(contentType)
    : bodyMode;

  if (kind === "json") {
    try {
      const value = JSON.parse(text);
      return {
        transport: "completed",
        status,
        body: { state: "parsed", value, error: null },
        error: null,
      };
    } catch (err) {
      return {
        transport: "completed",
        status,
        body: {
          state: "parse_failed",
          value: null,
          error: { category: "body_parse", message: sanitizeMessage(err.message) },
        },
        error: null,
      };
    }
  }

  // text mode
  return {
    transport: "completed",
    status,
    body: { state: "parsed", value: text, error: null },
    error: null,
  };
}

// ─── Outcome validators ────────────────────────────────────────────────────

const BODY_STATES = new Set(["not_read", "parsed", "empty", "parse_failed", "read_failed"]);
const BODY_ERROR_CATEGORIES = new Set(["body_parse", "body_read"]);

/**
 * Validate a ClassifiedOutcome fails-closed on contradictory states.
 * @param {ClassifiedOutcome} o
 * @throws {Error} with code INVALID_OUTCOME on any contradiction
 */
export function validateOutcome(o) {
  if (!o || typeof o !== "object") {
    throw Object.assign(new Error("outcome is not an object"), { code: INVALID_OUTCOME });
  }
  const { transport, status, body, error } = o;

  if (transport === "completed") {
    if (status === null || status === undefined) {
      throw Object.assign(new Error("transport=completed requires non-null status"), { code: INVALID_OUTCOME });
    }
    if (error !== null && error !== undefined) {
      throw Object.assign(new Error("transport=completed must not have a transport error"), { code: INVALID_OUTCOME });
    }
  } else if (transport === "failed") {
    if (status !== null && status !== undefined) {
      throw Object.assign(new Error("transport=failed must have null status"), { code: INVALID_OUTCOME });
    }
    if (!body || body.state !== "not_read") {
      throw Object.assign(new Error("transport=failed requires body.state=not_read"), { code: INVALID_OUTCOME });
    }
  } else {
    throw Object.assign(new Error(`unknown transport '${transport}'`), { code: INVALID_OUTCOME });
  }

  // Body shape.
  if (!body || !BODY_STATES.has(body.state)) {
    throw Object.assign(new Error(`unknown body state '${body && body.state}'`), { code: INVALID_OUTCOME });
  }
  if (body.error && !BODY_ERROR_CATEGORIES.has(body.error.category)) {
    throw Object.assign(new Error(`unknown body error category '${body.error.category}'`), { code: INVALID_OUTCOME });
  }

  // Transport error category.
  if (error && !TRANSPORT_CATEGORIES.has(error.category)) {
    throw Object.assign(new Error(`unknown transport error category '${error.category}'`), { code: INVALID_OUTCOME });
  }
}

// ─── Statistics ────────────────────────────────────────────────────────────

/**
 * Compute percentile statistics over a non-empty sample. Throws EMPTY_SAMPLE
 * on empty input (the caller — runBurst — converts that to the null-valued
 * latency structure when transportCompleted === 0).
 * @param {number[]} durationsMs
 * @returns {{count, minMs, p50Ms, p95Ms, p99Ms, maxMs}}
 */
export function computeLatencyStats(durationsMs) {
  if (!Array.isArray(durationsMs) || durationsMs.length === 0) {
    throw Object.assign(new Error("empty sample"), { code: EMPTY_SAMPLE });
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const pct = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: pct(50),
    p95Ms: pct(95),
    p99Ms: pct(99),
    maxMs: sorted[sorted.length - 1],
  };
}

// ─── The scheduler ─────────────────────────────────────────────────────────

/**
 * Run a burst of operations under a concurrency limit and pacing mode.
 *
 * Operation descriptors carry their own identity (kind, method) which the
 * runner attaches to results by input position — never inferred from
 * completion order. Outcomes are validated; contradictory states fail closed.
 *
 * Escaped rejections (not from inside httpOperation) are fatal: scheduling
 * stops, active work drains, and BURST_OPERATION_REJECTED is thrown with
 * safe attribution. A partial aggregate is never returned.
 *
 * @param {Array<{kind?:string|null, method?:string|null, run:()=>Promise<ClassifiedOutcome>}>} operations
 * @param {Object} opts
 * @param {number} opts.concurrency
 * @param {{mode:"none"|"legacy_batches", delayMs?:number}} opts.pacing
 * @param {() => number} [opts.now] defaults to performance.now()
 * @param {(ms:number)=>Promise<void>} [opts.sleep] defaults to real setTimeout
 * @returns {Promise<Aggregate>}
 */
export async function runBurst(operations, opts) {
  if (!Array.isArray(operations)) {
    throw new Error("runBurst: operations must be an array");
  }
  if (operations.length === 0) {
    throw Object.assign(new Error("empty workload"), { code: EMPTY_WORKLOAD });
  }
  const concurrency = opts.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runBurst: concurrency must be a positive integer, got ${concurrency}`);
  }
  const pacing = opts.pacing || { mode: "none", delayMs: 0 };
  if (!["none", "legacy_batches"].includes(pacing.mode)) {
    throw new Error(`runBurst: unknown pacing mode '${pacing.mode}'`);
  }
  const now = typeof opts.now === "function" ? opts.now : (() => {
    const { performance } = globalThis;
    return () => performance.now();
  })();
  const sleep = typeof opts.sleep === "function"
    ? opts.sleep
    : (ms) => new Promise((r) => setTimeout(r, ms));

  // Normalize descriptors. Bare functions are accepted but narrow (amendment 10):
  // a fulfilled bare task must return a valid ClassifiedOutcome, else validation
  // fails. Any bare-task rejection escapes and becomes BURST_OPERATION_REJECTED.
  const descriptors = operations.map((op, i) => {
    if (typeof op === "function") {
      return { id: i, kind: null, method: null, run: op };
    }
    return { id: i, kind: op.kind ?? null, method: op.method ?? null, run: op.run };
  });

  // Preallocate the results array by id so attribution is structural.
  const results = new Array(descriptors.length);
  let maxInFlightObserved = 0;
  let firstStartAssigned = false;
  const startWall = now();

  // Fatal-rejection state: once an escaped rejection occurs, stop scheduling
  // new work, let active work drain, then throw.
  let fatalRejection = null;

  /**
   * Execute one descriptor, timing it and validating the outcome. This
   * function is NON-REJECTING — it never throws to the scheduler. Both
   * escaped operation rejections AND invalid outcomes (validateOutcome
   * failures) are recorded as fatal errors via `fatalRejection` (first one
   * preserved), and the function returns normally so the scheduler's
   * .then() handler always fires, removes the descriptor from `active`,
   * and can drain properly.
   */
  async function executeOne(desc) {
    const opStart = now();
    let classified;
    try {
      classified = await desc.run();
    } catch (err) {
      // Escaped rejection — harness/policy/programming defect. Fatal.
      // Preserve the FIRST fatal error (subsequent ones don't overwrite).
      if (!fatalRejection) {
        fatalRejection = Object.assign(new Error(`operation ${desc.id} rejected`), {
          code: BURST_OPERATION_REJECTED,
          operation: { id: desc.id, kind: desc.kind, method: desc.method },
          cause: sanitizeMessage(err && err.message ? err.message : String(err)),
        });
      }
      return;
    }
    // Validate the classified outcome (constraint 2). This is inside the
    // non-rejecting boundary: an invalid outcome is also a fatal error,
    // not an unhandled rejection that hangs the scheduler.
    try {
      validateOutcome(classified);
    } catch (err) {
      if (!fatalRejection) {
        fatalRejection = Object.assign(new Error(`operation ${desc.id} produced invalid outcome`), {
          code: BURST_OPERATION_REJECTED,
          operation: { id: desc.id, kind: desc.kind, method: desc.method },
          cause: sanitizeMessage(err && err.message ? err.message : String(err)),
        });
      }
      return;
    }
    const durationMs = now() - opStart;
    results[desc.id] = {
      id: desc.id,
      kind: desc.kind,
      method: desc.method,
      durationMs,
      ...classified,
    };
  }

  if (pacing.mode === "legacy_batches") {
    // Cohort model: start up to concurrency, wait for all to settle, delay, next.
    for (let i = 0; i < descriptors.length; i += concurrency) {
      if (fatalRejection) break;
      const cohort = descriptors.slice(i, i + concurrency);
      const inFlight = cohort.length;
      if (inFlight > maxInFlightObserved) maxInFlightObserved = inFlight;
      await Promise.all(cohort.map(executeOne));
      if (fatalRejection) break;
      const isLast = i + concurrency >= descriptors.length;
      if (!isLast && pacing.delayMs > 0) {
        await sleep(pacing.delayMs);
      }
    }
  } else {
    // Semaphore model: maintain at most `concurrency` in flight; refill on
    // completion. Disable refill immediately on fatal rejection.
    let nextIndex = 0;
    const active = new Set();
    await new Promise((resolve) => {
      const scheduleNext = () => {
        // Stop scheduling if a fatal rejection has occurred.
        while (
          !fatalRejection &&
          nextIndex < descriptors.length &&
          active.size < concurrency
        ) {
          const desc = descriptors[nextIndex++];
          active.add(desc.id);
          if (active.size > maxInFlightObserved) maxInFlightObserved = active.size;
          executeOne(desc).then(() => {
            active.delete(desc.id);
            if (fatalRejection && active.size === 0) {
              resolve();
              return;
            }
            if (nextIndex < descriptors.length) {
              scheduleNext();
            } else if (active.size === 0) {
              resolve();
            }
          });
        }
        // If everything already scheduled and drained, resolve.
        if (nextIndex >= descriptors.length && active.size === 0) {
          resolve();
        }
      };
      scheduleNext();
    });
  }

  // Fatal rejection: drain is complete (all active settled). Throw.
  if (fatalRejection) {
    throw fatalRejection;
  }

  const elapsedMs = now() - startWall;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw Object.assign(new Error(`non-positive elapsed time: ${elapsedMs}`), {
      code: INVALID_ELAPSED_TIME,
    });
  }

  return buildAggregate({
    results,
    attempted: descriptors.length,
    elapsedMs,
    requestedConcurrency: concurrency,
    maxInFlightObserved,
    pacing,
  });
}

// ─── Aggregate builder ─────────────────────────────────────────────────────

function buildAggregate({ results, attempted, elapsedMs, requestedConcurrency, maxInFlightObserved, pacing }) {
  let transportCompleted = 0;
  let transportFailed = 0;
  const statusCounts = {};
  let bodyParsed = 0, bodyEmpty = 0, bodyParseFailed = 0, bodyNotRead = 0, bodyReadFailed = 0;
  const durations = [];

  for (const r of results) {
    if (r.transport === "completed") {
      transportCompleted++;
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      durations.push(r.durationMs);
      switch (r.body.state) {
        case "parsed": bodyParsed++; break;
        case "empty": bodyEmpty++; break;
        case "parse_failed": bodyParseFailed++; break;
        case "read_failed": bodyReadFailed++; break;
        case "not_read": bodyNotRead++; break;
      }
    } else {
      transportFailed++;
    }
  }

  // Latency: transport-completed population. Null-valued when count=0.
  let latency;
  if (durations.length === 0) {
    latency = {
      population: "transport_completed",
      count: 0,
      minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null,
    };
  } else {
    const s = computeLatencyStats(durations);
    latency = { population: "transport_completed", ...s };
  }

  const rps = attempted / (elapsedMs / 1000);

  return {
    attempted,
    transportCompleted,
    transportFailed,
    statusCounts,
    bodyParsed, bodyEmpty, bodyParseFailed, bodyNotRead, bodyReadFailed,
    requestedConcurrency,
    maxInFlightObserved,
    pacing: { mode: pacing.mode, delayMs: pacing.delayMs || 0 },
    elapsedMs,
    rps,
    latency,
    results,
  };
}

// ─── Exports for testing ───────────────────────────────────────────────────

export const TESTING_ONLY = {
  EMPTY_WORKLOAD,
  EMPTY_SAMPLE,
  INVALID_ELAPSED_TIME,
  BURST_OPERATION_REJECTED,
  INVALID_OUTCOME,
  TRANSPORT_CATEGORIES,
  sanitizeMessage,
  validateOutcome,
};
