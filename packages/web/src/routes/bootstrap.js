// src/routes/bootstrap.js
//
// First-administrator bootstrap endpoint (Wave 2 / issue #94).
//
// POST /api/bootstrap/first   — create the first administrator.
//
// This is a Wave 2-only endpoint that ENFORCES its own security contract
// immediately (issue #94: "New Wave 2-only endpoints ... may enforce their
// own security contract immediately"). It is NOT observe-only.
//
// Requirements enforced here + in bootstrapService + complete_bootstrap():
//   * available only while bootstrap state is 'enabled';
//   * derived-hash handling (raw secret never enters PG);
//   * atomic administrator creation via complete_bootstrap();
//   * repeated bootstrap rejected (state flips to 'disabled' after success);
//   * NO recovery re-enable route exists in this file or anywhere else.
//
// Anonymous access: this route is intentionally reachable before any admin
// exists — it IS the bootstrap path. It is mounted at /api/bootstrap which
// the authContext middleware treats as anonymous (skipped) OR is reachable
// with req.auth unauthenticated; the bootstrap state check is the gate.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { getBootstrapState, executeFirstBootstrap } from "../services/auth/bootstrapService.js";

const router = Router();

/**
 * GET /api/bootstrap/state — report bootstrap availability (no secrets).
 * Returns { enabled: boolean, bootstrapCount: number }.
 */
router.get("/state", async (_req, res) => {
  try {
    const { state, bootstrapCount } = await getBootstrapState();
    res.json({ enabled: state === "enabled", bootstrapCount });
  } catch (err) {
    logger.error({ err }, "bootstrap state check failed");
    res.status(500).json({ error: "bootstrap state unavailable" });
  }
});

/**
 * POST /api/bootstrap/first — create the first administrator.
 * Body: { adminDisplayName, credentialLookupId, adminSecret, audience?, displayPrefix? }
 *
 * The adminSecret is the raw administrator secret; it is hashed to a derived
 * value OUTSIDE PostgreSQL (bootstrapService) before being passed to
 * complete_bootstrap(). The raw secret is never logged.
 */
router.post("/first", async (req, res) => {
  try {
    const { adminDisplayName, credentialLookupId, adminSecret, audience, displayPrefix } =
      req.body || {};

    if (!adminDisplayName || !credentialLookupId || !adminSecret) {
      return res.status(400).json({
        error: "adminDisplayName, credentialLookupId, and adminSecret are required",
      });
    }

    // Enforce bootstrap state — only 'enabled' permits first bootstrap.
    const { state } = await getBootstrapState();
    if (state !== "enabled") {
      return res.status(409).json({
        error: "bootstrap is not enabled",
        code: "bootstrap_disabled",
      });
    }

    const result = await executeFirstBootstrap({
      adminDisplayName,
      credentialLookupId,
      rawAdminSecret: adminSecret,
      adminAudience: audience || "gitwire-app",
      adminDisplayPrefix: displayPrefix || "gw_pat_",
    });

    // Do NOT echo the secret or the hash. Return only the principal id.
    return res.status(201).json({
      ok: true,
      principalId: result.principalId,
      message: "bootstrap complete — administrator created; bootstrap is now disabled",
    });
  } catch (err) {
    if (err.cause === "bootstrap_disabled") {
      return res.status(409).json({ error: err.message, code: "bootstrap_disabled" });
    }
    if (err.cause === "admin_role_missing") {
      return res.status(500).json({ error: err.message, code: "admin_role_missing" });
    }
    logger.error({ err: err.message }, "bootstrap first failed");
    return res.status(500).json({ error: "bootstrap failed" });
  }
});

// NOTE: there is intentionally NO recovery-re-enable route here. Recovery
// re-enable is operator-only via direct DB INSERT into
// auth_bootstrap_recovery_markers (issue #94 / ADR-0008).

export default router;
