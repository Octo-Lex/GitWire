// src/routes/setup.js
// First-run setup checklist + starter policy templates.
// GET /api/setup           → { overall, completed, total, next_step, checks[] }
// GET /api/setup/templates → { data: [{ id, name, description, ... }] }
// GET /api/setup/templates/:id → { meta: {...}, content: "..." }
//
// All endpoints are read-only and auth-protected (behind apiKeyAuth).
// No secret values are ever returned — checks report boolean presence only.

import { Router } from "express";
import { getSetupStatus } from "../services/setupService.js";
import { listTemplates, getTemplate } from "../services/templateService.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    const result = await getSetupStatus();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to compute setup status");
    res.status(500).json({ error: "Failed to compute setup status" });
  }
});

// ── Starter policy templates ─────────────────────────────────────────────

router.get("/templates", async (_req, res) => {
  try {
    const templates = await listTemplates();
    res.json({ data: templates });
  } catch (err) {
    logger.error({ err }, "Failed to list templates");
    res.status(500).json({ error: "Failed to list templates" });
  }
});

router.get("/templates/:id", async (req, res) => {
  try {
    const result = await getTemplate(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.code === "NOT_FOUND") {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ err }, "Failed to get template");
    res.status(500).json({ error: "Failed to get template" });
  }
});

export default router;
