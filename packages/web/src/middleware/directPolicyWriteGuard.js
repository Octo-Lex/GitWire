// W2-03: compatibility API guard for retired direct live-policy writes.
// Read-only config, history, validation, simulation, diff, and recommendation
// endpoints continue through the compatibility router.

export function directPolicyWriteGuard(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  const path = String(req.path || req.url || "");
  const directMutation = method === "PUT" || method === "PATCH" || method === "DELETE";
  const historyRestore = method === "POST" && /\/restore\/[^/?]+\/?(?:\?.*)?$/.test(path);

  if (!directMutation && !historyRestore) return next();

  return res.status(409).json({
    error: "direct_policy_write_disabled",
    message: "Live policy changes must use the governed rollout workflow.",
  });
}
