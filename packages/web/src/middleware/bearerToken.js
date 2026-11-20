// src/middleware/bearerToken.js
// Bearer-token extraction shared by apiKeyAuth (auth.js) and the rate limiter
// (rateLimiter.js). Both MUST recognize exactly the same Authorization forms:
// a case-sensitive "Bearer " scheme prefix with a single literal space. A
// looser recognizer on the limiter side re-opens the bucket-rotation bypass
// (rotating non-Bearer headers to mint fresh buckets); a stricter one would
// throttle callers apiKeyAuth accepts. Before this module existed the two
// implementations were unlinked copies kept in sync by comments — the corpus
// contract test in rate-limiter-identity.test.js now pins this one function
// for both callers.

/**
 * Extract the Bearer token from an Authorization header value.
 *
 * Recognition is apiKeyAuth-EXACT: case-sensitive "Bearer " prefix (single
 * literal space), then slice(7).trim(). Returns "" for every other form —
 * wrong case ("bearer x"), tab separator ("Bearer\tx"), bare "Bearer",
 * whitespace-only token, or a missing/non-string header.
 *
 * @param {string | undefined} authHeader
 * @returns {string} the token, or "" when the header is not a well-formed
 *   Bearer credential.
 */
export function extractBearerToken(authHeader) {
  return typeof authHeader === "string" && authHeader.slice(0, 7) === "Bearer "
    ? authHeader.slice(7).trim()
    : "";
}
