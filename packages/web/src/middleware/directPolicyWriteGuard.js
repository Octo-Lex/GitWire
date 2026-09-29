// W2-03: compatibility API guard for retired direct live-policy writes.
// Read-only config, history, validation, simulation, diff, and recommendation
// endpoints continue through the compatibility router.

const DIRECT_POLICY_WRITE_BLOCKED = {
  error: "direct_policy_write_disabled",
  message: "Live policy changes must use the governed rollout workflow.",
};

export function directPolicyWriteGuard(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  const directMutation = method === "PUT" || method === "PATCH" || method === "DELETE";
  let path = String(req.path || req.url || "");

  if (directMutation || method === "POST") {
    // Express routing is case-insensitive and decodes path parameters, so the
    // guard must decode and compare case-insensitively — otherwise
    // POST /:owner/:repo/RESTORE/:id or percent-encoded variants reach the
    // restore route past this check. Malformed percent-encoding on a mutating
    // method fails closed rather than bypass the restore check. Migration 047
    // remains the storage backstop either way.
    try {
      path = decodeURIComponent(path);
    } catch {
      return res.status(409).json(DIRECT_POLICY_WRITE_BLOCKED);
    }
  }

  const historyRestore = method === "POST" && /\/restore\/[^/?]+\/?(?:\?.*)?$/i.test(path);

  if (!directMutation && !historyRestore) return next();

  return res.status(409).json(DIRECT_POLICY_WRITE_BLOCKED);
}
