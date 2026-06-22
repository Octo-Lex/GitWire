// src/lib/executorServiceClient.js
// HTTP client for the executor service (v0.23.0 Task 3).
//
// Wraps GET /health against the executor service. POST /v1/validate is
// Task 5 — intentionally NOT here. The client returns a shaped object on
// every code path (never throws) so callers can treat it as a probe.
//
// A test-injectable fetch seam (_setFetchForTests) lets unit tests stub the
// network. Production code leaves it null → uses the global fetch.

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
    // The service's body already carries `ready` (its own readiness view).
    // For the app-side probe contract we ALSO expose `reachable` as the
    // transport-level signal: the service answered, so the network path
    // works. Callers layer their own readiness logic on top (e.g.Validator
    // image identity) — `reachable` just says "the service is reachable
    // from the app right now."
    return { ...body, reachable: true };
  } catch (err) {
    // AbortError, network errors, JSON parse errors — all become reachable:false.
    // Never propagate; the probe contract requires a shaped return.
    return {
      reachable: false,
      detail: err?.name === "AbortError" ? "timeout" : (err?.message || "fetch failed"),
    };
  }
}
