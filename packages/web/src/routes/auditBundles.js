// src/routes/auditBundles.js
// GET /api/audit-bundles/export
//
// Generates an exportable audit bundle (JSON or Markdown) for a given scope.
// All secret-like fields are redacted before export.

import { Router } from "express";
import { generateAuditBundle, bundleToMarkdown } from "../services/auditBundleService.js";
import { logger } from "../lib/logger.js";

export const auditBundlesRouter = Router();

/**
 * GET /api/audit-bundles/export
 *
 * Query params:
 *   repo          - repo full_name (owner/repo)
 *   pillar        - pillar name
 *   target_type   - 'pr' or 'issue'
 *   target_number - PR/issue number
 *   from          - ISO date (inclusive)
 *   to            - ISO date (inclusive)
 *   format        - 'json' (default) or 'markdown'
 *   limit         - max records per section (default 500, capped at 1000)
 */
auditBundlesRouter.get("/export", async (req, res) => {
  try {
    const format = req.query.format === "markdown" ? "markdown" : "json";

    const bundle = await generateAuditBundle({
      repo: req.query.repo,
      pillar: req.query.pillar,
      targetType: req.query.target_type || req.query.targetType,
      targetNumber: req.query.target_number || req.query.targetNumber
        ? Number(req.query.target_number || req.query.targetNumber)
        : undefined,
      from: req.query.from,
      to: req.query.to,
      limit: Math.min(Number(req.query.limit) || 500, 1000),
    });

    if (format === "markdown") {
      const md = bundleToMarkdown(bundle);
      res.setHeader("Content-Type", "text/markdown");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="gitwire-audit-bundle-' + Date.now() + '.md"'
      );
      return res.send(md);
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="gitwire-audit-bundle-' + Date.now() + '.json"'
    );
    res.json(bundle);
  } catch (err) {
    logger.error({ err: err.message }, "Audit bundle export failed");
    res.status(500).json({ error: "Failed to generate audit bundle" });
  }
});
