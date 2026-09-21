// src/services/reviewTokenAccounting.js
// PC-01 v2.1: exact token accounting for the primary review request.
//
// The production route (Z.AI Anthropic-compatible endpoint at
// ANTHROPIC_BASE_URL) exposes POST /v1/messages/count_tokens, proven EXACT
// against billed input_tokens at small, realistic, and near-envelope scale
// (preflight 2026-09-21: 17 = 17; 4,068 = 4,068; exact again at 958,682).
// It is the ONLY admission mechanism. There is deliberately no
// character-based fallback: GitWire must never guess its way into an
// oversized model request.
//
// Frozen input ceiling (PC-01 v2.1 DECISION gate, 2026-09-21):
//     1,000,000-token operating context contract
//   -    32,768-token output reserve (max_tokens stays 32,768)
//   -     9,216-token safety reserve (count/send drift; keeps the worst
//            constructible input below the empirically accepted 958,682)
//   =   958,016 input tokens for the COMPLETE primary review request
// (measured contract: 958,682 input accepted; 1,273,523 rejected pre-execution
// with "prompt is too long"; max output 131,072).

import Anthropic from "@anthropic-ai/sdk";
import https from "node:https";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
  timeout: 600000,
  // RT-01: pin to IPv4. The provider resolver returns mixed A/AAAA records
  // and the app container has no IPv6 route; the SDK's default address
  // selection persistently fails fresh connections while family-4 succeeds.
  httpAgent: new https.Agent({ keepAlive: true, family: 4 }),
});

const OPERATING_CONTEXT_TOKENS = 1000000;
const OUTPUT_RESERVE_TOKENS   = 32768;
const SAFETY_RESERVE_TOKENS   = 9216;

/**
 * Hard input ceiling for the complete primary review request (system prompt
 * plus user message). Derived once, frozen: evidence capacity per review is
 * this constant minus that review's measured non-evidence tokens.
 */
export const MAX_PRIMARY_INPUT_TOKENS =
  OPERATING_CONTEXT_TOKENS - OUTPUT_RESERVE_TOKENS - SAFETY_RESERVE_TOKENS; // 958016

/** The seven frozen provider-rejection classes (PC-01 v2.1 recommendation 9). */
export const REJECTION_CLASSES = [
  "context_limit", "timeout", "rate_limit", "quota",
  "auth_entitlement", "transport", "other",
];

/**
 * Classify a provider/transport failure into the seven-way taxonomy.
 *
 * Mapping (deterministic, first match wins):
 *   context_limit   400 with gateway code 1261 ("prompt is too long") or
 *                   code 1210 (max_tokens outside the model's legal range) —
 *                   the two pre-execution contract validations measured in
 *                   the 2026-09-21 preflight.
 *   quota           429 whose message names credits/quota/plan limits
 *                   (Coding-Plan window exhaustion).
 *   rate_limit      any other 429.
 *   auth_entitlement 401/403.
 *   timeout         SDK APIConnectionTimeoutError, ETIMEDOUT/ECONNABORTED,
 *                   HTTP 408, or a message naming a timeout.
 *   transport       SDK APIConnectionError, connection-level socket/DNS
 *                   errors, and 5xx/529 server states.
 *   other           everything else.
 *
 * @param {Error} err
 * @returns {string} one of REJECTION_CLASSES
 */
export function classifyProviderRejection(err) {
  if (!err) return "other";
  const status = typeof err.status === "number" ? err.status : null;
  const msg = String(err.message || "");
  const gwCode = err?.error?.error?.code;

  if (status === 400 && (gwCode === 1261 || gwCode === 1210 || /prompt is too long/i.test(msg))) {
    return "context_limit";
  }
  if (status === 429) {
    return /credit|quota|insufficient|balance|plan/i.test(msg) ? "quota" : "rate_limit";
  }
  if (status === 401 || status === 403) return "auth_entitlement";
  if (
    err.name === "APIConnectionTimeoutError" ||
    err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" ||
    status === 408 || /timeout|timed out/i.test(msg)
  ) {
    return "timeout";
  }
  if (
    err.name === "APIConnectionError" ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH"].includes(err.code) ||
    (status !== null && (status === 529 || status >= 500))
  ) {
    return "transport";
  }
  return "other";
}

/**
 * True when the provider rejected the request as exceeding the MODEL's
 * context limit — gateway code 1261 / "prompt is too long" (preflight
 * 2026-09-21: a count of 1,273,523 tokens was rejected pre-execution while
 * 958,682 was accepted). This is a definitive over-limit answer, not an
 * error: it means "definitely larger than the admission ceiling".
 * Gateway code 1210 (illegal max_tokens) is deliberately NOT included — it
 * concerns the output parameter, which count requests never send.
 */
export function isPromptTooLongRejection(err) {
  if (!err) return false;
  const status = typeof err.status === "number" ? err.status : null;
  if (status !== 400) return false;
  return err?.error?.error?.code === 1261 || /prompt is too long/i.test(String(err.message || ""));
}

/**
 * Count the EXACT input tokens of a prospective primary review request via
 * the provider's count_tokens endpoint, using the same model string the
 * send will use. No local fallback exists by design.
 *
 * Deadline contract (PC-01 v2.1 final amendment): when `deadline` (an
 * absolute epoch-ms timestamp) is provided, every count is bounded by the
 * REMAINING time to that deadline — the per-request provider timeout equals
 * the remaining slice, which only shrinks across sequential calls, so a
 * chain of counts can never reset the budget per call. A count attempted at
 * or past the deadline fails as a timeout-classed E_TOKEN_COUNT_FAILED
 * before any provider request is made.
 *
 * @param {object} opts
 * @param {string} opts.model      - exact model the send will use
 * @param {string} [opts.system]   - system prompt (counted: preflight-verified)
 * @param {string} opts.userPrompt - complete user message content
 * @param {number} [opts.deadline] - absolute epoch-ms deadline for provider work
 * @returns {Promise<number>} the exact input token count, or **Infinity**
 *   when the provider's counter itself rejects the prompt as over the
 *   model's context limit — a definitive "larger than the admission
 *   ceiling" answer that callers must route into deterministic allocation,
 *   never into a failure.
 * @throws Error with gitwireErrorCode E_TOKEN_COUNT_FAILED for every other
 *   failure (transport, timeout, rate limit, quota, auth, malformed, or a
 *   passed deadline). The caller must fail visibly and never proceed to
 *   inference on an estimate.
 */
export async function countInputTokens({ model, system, userPrompt, deadline }) {
  const started = Date.now();
  const requestOptions = {};
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const expired = new Error("Token count aborted: review deadline expired before this count could run");
      expired.gitwireErrorCode = "E_TOKEN_COUNT_FAILED";
      expired.gitwireRejectionClass = "timeout";
      logger.error({ model, deadline }, "Token count refused — review deadline already expired");
      throw expired;
    }
    requestOptions.timeout = remaining;
  }
  try {
    const res = await anthropic.messages.countTokens(
      {
        model,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: userPrompt }],
      },
      requestOptions
    );
    const tokens = res?.input_tokens;
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error("count_tokens returned a non-numeric count: " + JSON.stringify(res));
    }
    logger.debug({ model, tokens, ms: Date.now() - started }, "Token count ok");
    return tokens;
  } catch (err) {
    // The counter rejecting the prompt as over the model context is a valid
    // answer: the request is definitely over the admission ceiling. Return
    // it as Infinity so allocation degrades truthfully (PC-01 v2.1
    // amendment: oversized PRs must reach allocation, not fail the review).
    if (isPromptTooLongRejection(err)) {
      logger.info(
        { model, ms: Date.now() - started },
        "Token count over model context limit — treating as over the admission ceiling"
      );
      return Infinity;
    }
    const rejectionClass = classifyProviderRejection(err);
    const wrapped = new Error("Token count failed (" + rejectionClass + "): " + err.message);
    wrapped.gitwireErrorCode = "E_TOKEN_COUNT_FAILED";
    wrapped.gitwireRejectionClass = rejectionClass;
    logger.error(
      { err: err.message, rejectionClass, ms: Date.now() - started },
      "Token count failed — refusing to admit evidence by estimate"
    );
    throw wrapped;
  }
}
