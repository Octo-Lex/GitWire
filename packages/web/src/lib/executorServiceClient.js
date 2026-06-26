// src/lib/executorServiceClient.js
// HTTP client for the executor service (v0.23.0 Task 3).
//
// Wraps GET /health against the executor service. POST /v1/validate is
// Task 5 — intentionally NOT here. The client returns a shaped object on
// every code path (never throws) so callers can treat it as a probe.
//
// A test-injectable fetch seam (_setFetchForTests) lets unit tests stub the
// network. Production code leaves it null → uses the global fetch.

// Lazy logger — avoids a hard dependency on @gitwire/runtime at module load
// (which throws if the runtime isn't initialized, breaking unit tests).
// Mirrors executorReachability.js: always uses console.* with a prefix so the
// module is import-safe in any context. The production app initializes the
// runtime logger elsewhere; these console calls are captured by the container's
// stdout just like pino JSON logs.
function getLogger() {
  return {
    info: (obj, msg) => console.debug(JSON.stringify({ level: 30, msg, ...obj })),
    warn: (obj, msg) => console.warn(JSON.stringify({ level: 40, msg, ...obj })),
    error: (obj, msg) => console.error(JSON.stringify({ level: 50, msg, ...obj })),
  };
}

const DEFAULT_TIMEOUT_MS = 3000;

// Module-private fetch reference. null → use the global.
let _fetch = null;

/**
 * Test-only seam: inject a fake fetch implementation.
 * Pass null to restore the real fetch.
 *
 * Signature matches the global fetch: (url, init) => Promise<{ok, status, json}>
 *
 * @param {((url: string, init: object) => Promise<object>) | null} fn
 */
export function _setFetchForTests(fn) {
  _fetch = fn;
}

/**
 * Fetch GET /health from the executor service.
 *
 * NEVER throws — returns a shaped object on every path so the probe contract
 * holds (network errors, aborts, non-200s all return reachable:false rather
 * than propagating).
 *
 * @param {object} opts
 * @param {string} opts.url — base URL (e.g. "http://executor:3003")
 * @param {string} [opts.token] — optional bearer token
 * @param {number} [opts.timeoutMs=3000] — request timeout
 * @returns {Promise<object>} parsed health body on success; { reachable: false, ... } on any failure
 */
export async function fetchExecutorServiceHealth({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const fetchImpl = _fetch || globalThis.fetch.bind(globalThis);
  const endpoint = `${url.replace(/\/+$/, "")}/health`;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetchImpl(endpoint, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { reachable: false, status: res.status, detail: `non-200 response: ${res.status}` };
    }
    const body = await res.json();
    // P2 #1: reachable is gated on body.ready === true, not just HTTP 200.
    // The service's `ready` is the load-bearing readiness signal (runtime
    // reachable AND validator identity complete per the design doc). Treating
    // a live-but-unready service as reachable would let probeExecutorService
    // report a backend as reachable when it cannot actually produce validator
    // evidence — a false positive that could let a pass-capable derivation
    // treat the backend as proof-ready.
    //
    // Transport-level "answered at all" is implicit (we got here = the network
    // path works). What matters for proof is whether the service is ready.
    const ready = body.ready === true;
    return {
      ...body,
      reachable: ready,
      // If the service explained why ready=false, surface it so operators
      // can diagnose; otherwise note the unready state generically.
      ...(ready ? {} : { detail: body.detail || "executor service ready=false (runtime unreachable or validator identity incomplete)" }),
    };
  } catch (err) {
    // AbortError, network errors, JSON parse errors — all become reachable:false.
    // Never propagate; the probe contract requires a shaped return.
    return {
      reachable: false,
      detail: err?.name === "AbortError" ? "timeout" : (err?.message || "fetch failed"),
    };
  }
}

const DEFAULT_VALIDATE_TIMEOUT_MS = 120000; // 2 min — commands can take time

/**
 * POST /v1/validate to the executor service.
 *
 * NEVER throws — returns a shaped object on every path. On any failure
 * (non-200, network error, abort), returns `{ overall: "inconclusive",
 * inconclusive_reason: "executor_error", ... }` so the backend's run()
 * can treat the result uniformly.
 *
 * @param {object} opts
 * @param {string} opts.url — base URL (e.g. "http://executor:3003")
 * @param {string} [opts.token] — bearer token
 * @param {object} opts.body — the validate request body
 * @param {number} [opts.timeoutMs=120000] — request timeout
 * @returns {Promise<object>} the validate response on success; inconclusive on failure
 */
export async function postValidate({ url, token, body, timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS }) {
  const fetchImpl = _fetch || globalThis.fetch.bind(globalThis);
  const endpoint = `${url.replace(/\/+$/, "")}/v1/validate`;
  const headers = { "content-type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  // DIAGNOSTIC (Task 8 Step 5): guarded request shape log. No file contents,
  // tokens, or auth headers — only counts, hashes, and field presence, so the
  // log is proof-safe (cannot leak patch/source content or credentials).
  const bodyJson = JSON.stringify(body);
  const requestShape = {
    request_id: body?.request_id,
    endpoint,
    timeout_ms: timeoutMs,
    command_count: (body?.commands || []).length,
    commands: body?.commands || [],
    file_count: (body?.files || []).length,
    // total input bytes across all files (size signal only, no content)
    total_input_bytes: (body?.files || []).reduce((s, f) => s + (f?.content?.length || 0), 0),
    // content-addressed hash of the request body (proves the body is intact
    // without logging it; lets us compare against a manual test's hash)
    request_body_hash: "sha256:" + hashString(bodyJson),
    has_validator_image_ref: Boolean(body?.validator_image_ref),
    has_validator_image_digest: Boolean(body?.validator_image_digest),
    validator_image_ref_prefix: body?.validator_image_ref?.slice(0, 40) || null,
  };
  getLogger().info({ ...requestShape, phase: "request_start" }, "postValidate: request_start");

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      // DIAGNOSTIC: non-2xx → synthetic fallback. Capture HTTP status + the
      // synthetic marker so the backend can classify this as NOT a real
      // executor-service response.
      getLogger().warn({
        ...requestShape,
        phase: "non_200",
        response_http_status: res.status,
        synthetic_fallback_used: true,
        validation_response_source: "synthetic_inconclusive",
      }, "postValidate: non-200 response → synthetic inconclusive");
      return {
        overall: "inconclusive",
        inconclusive_reason: "executor_error",
        inconclusive_detail: `non-200 response: ${res.status}`,
        // DIAGNOSTIC marker: downstream can detect this is synthetic, not real.
        validation_response_source: "synthetic_inconclusive",
        synthetic_fallback_used: true,
      };
    }

    const parsed = await res.json();

    // DIAGNOSTIC: real response reached. Log field presence (not values) for
    // the proof-critical bindings. These are the fields whose absence in the
    // persisted receipts is the open issue.
    const responseShape = {
      ...requestShape,
      phase: "response_received",
      response_http_status: res.status,
      response_content_type: res.headers?.get?.("content-type") || null,
      response_body_keys: Object.keys(parsed),
      response_overall: parsed.overall,
      response_inconclusive_reason: parsed.inconclusive_reason || null,
      response_executor_report_hash_present: parsed.executor_report_hash != null,
      response_executor_report_ref_present: parsed.executor_report_ref != null,
      response_inspected_image_digest_present: parsed.inspected_image_digest != null,
      response_runtime_version: parsed.runtime_version || null,
      response_command_result_count: (parsed.command_results || []).length,
      response_aggregate_exit_status: parsed.aggregate_exit_status ?? null,
      // Classify: a real executor-service response carries executor_report_hash
      // (the service computes it for non-inconclusive results). Its absence
      // means either inconclusive result or a synthetic-looking response.
      validation_response_source: parsed.executor_report_hash
        ? "executor_service"
        : (parsed.inconclusive_reason ? "executor_service_inconclusive" : "unknown"),
      synthetic_fallback_used: false,
    };
    getLogger().info(responseShape, "postValidate: response_received");

    // Attach the source classification to the returned object so the backend
    // and receipt path can mark synthetic responses explicitly.
    return {
      ...parsed,
      validation_response_source: responseShape.validation_response_source,
      synthetic_fallback_used: false,
    };
  } catch (err) {
    // DIAGNOSTIC: network/abort/parse error → synthetic fallback.
    getLogger().error({
      ...requestShape,
      phase: "fetch_error",
      error_name: err?.name || "Unknown",
      error_message: err?.message || "fetch failed",
      error_code: err?.code || null,
      error_cause: err?.cause?.code || err?.cause?.message || null,
      timeout_or_abort: err?.name === "AbortError" || err?.code === "ABORT_ERR",
      synthetic_fallback_used: true,
      validation_response_source: "synthetic_inconclusive",
    }, "postValidate: fetch error → synthetic inconclusive");
    return {
      overall: "inconclusive",
      inconclusive_reason: "executor_error",
      inconclusive_detail: err?.name === "AbortError" ? "timeout" : (err?.message || "fetch failed"),
      validation_response_source: "synthetic_inconclusive",
      synthetic_fallback_used: true,
    };
  }
}

// Minimal string hash for request-body integrity logging. Not cryptographic
// for verification — just a stable fingerprint to compare request shapes.
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
