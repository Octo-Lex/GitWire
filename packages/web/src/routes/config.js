// src/routes/config.js
// Per-repo .gitwire.yml config overrides — managed via dashboard UI.
//
// GET    /api/config/:owner/:repo         — get resolved config + overrides
// PUT    /api/config/:owner/:repo         — set overrides (partial merge)
// DELETE /api/config/:owner/:repo         — delete overrides (revert to YAML)

import { Router } from "express";
import { getConfigForRepo, getConfigOverrides, setConfigOverrides, deleteConfigOverrides, getConfigHistory, restoreConfigVersion } from "../services/configService.js";
import { DEFAULT_CONFIG, validateConfig } from "@gitwire/rules";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const configRouter = Router();

// ── GET resolved config ──────────────────────────────────────────────────────
configRouter.get("/:owner/:repo", async (req, res) => {
  const { owner, repo } = req.params;
  const fullName = `${owner}/${repo}`;

  try {
    // Get resolved config (defaults + YAML + DB overrides)
    const config = await getConfigForRepo(fullName);

    // Get DB overrides separately (to show what's overridden vs default)
    const overrides = await getConfigOverrides(fullName);

    // Build pillar status summary
    const pillars = {};
    for (const [key, val] of Object.entries(config.pillars || {})) {
      pillars[key] = {
        enabled: val?.enabled !== false,
        hasOverride: overrides?.config?.pillars?.[key] !== undefined,
      };
    }

    res.json({
      config,
      overrides: overrides?.config || {},
      updatedAt: overrides?.updated_at || null,
      updatedBy: overrides?.updated_by || null,
      source: overrides ? "database" : "yaml_or_default",
      pillars,
    });
  } catch (err) {
    logger.error({ err, repo: fullName }, "Failed to get config");
    res.status(500).json({ error: "Failed to get config" });
  }
});

// ── PUT set config overrides ────────────────────────────────────────────────
configRouter.put("/:owner/:repo", async (req, res) => {
  const { owner, repo } = req.params;
  const fullName = `${owner}/${repo}`;
  const overrides = req.body;

  if (!overrides || typeof overrides !== "object") {
    return res.status(400).json({ error: "Request body must be a config object" });
  }

  // Validate the overrides
  const validation = validateConfig(overrides);
  if (!validation.valid) {
    return res.status(400).json({ error: "Invalid config", details: validation.errors });
  }

  // Verify repo exists
  const { rows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  if (!rows.length) {
    return res.status(404).json({ error: "Repo not found" });
  }

  try {
    const actor = req.headers["x-actor-login"] || "dashboard";
    await setConfigOverrides(fullName, overrides, actor, "set");

    // Return the newly resolved config
    const config = await getConfigForRepo(fullName);

    res.json({
      ok: true,
      config,
      message: "Config overrides saved",
    });
  } catch (err) {
    logger.error({ err, repo: fullName }, "Failed to set config overrides");
    res.status(500).json({ error: "Failed to save config" });
  }
});

// ── PATCH partial update (merge with existing overrides) ────────────────────
configRouter.patch("/:owner/:repo", async (req, res) => {
  const { owner, repo } = req.params;
  const fullName = `${owner}/${repo}`;
  const patch = req.body;

  if (!patch || typeof patch !== "object") {
    return res.status(400).json({ error: "Request body must be a config object" });
  }

  try {
    // Get existing overrides, merge with patch
    const existing = await getConfigOverrides(fullName);
    const current = existing?.config || {};

    // Deep merge
    const merged = deepMerge(current, patch);

    const validation = validateConfig(merged);
    if (!validation.valid) {
      return res.status(400).json({ error: "Invalid config after merge", details: validation.errors });
    }

    const actor = req.headers["x-actor-login"] || "dashboard";
    await setConfigOverrides(fullName, merged, actor, "patch");

    const config = await getConfigForRepo(fullName);

    res.json({
      ok: true,
      config,
      message: "Config overrides updated",
    });
  } catch (err) {
    logger.error({ err, repo: fullName }, "Failed to patch config");
    res.status(500).json({ error: "Failed to update config" });
  }
});

// ── DELETE overrides (revert to YAML + defaults) ────────────────────────────
configRouter.delete("/:owner/:repo", async (req, res) => {
  const { owner, repo } = req.params;
  const fullName = `${owner}/${repo}`;

  try {
    const actor = req.headers["x-actor-login"] || "dashboard";
    await deleteConfigOverrides(fullName, actor);
    const config = await getConfigForRepo(fullName);

    res.json({
      ok: true,
      config,
      message: "Config overrides deleted — reverted to YAML + defaults",
    });
  } catch (err) {
    logger.error({ err, repo: fullName }, "Failed to delete config overrides");
    res.status(500).json({ error: "Failed to delete config" });
  }
});

// ── GET config history ────────────────────────────────────────────────────
configRouter.get("/:owner/:repo/history", async (req, res) => {
  const { owner, repo } = req.params;
  const fullName = `${owner}/${repo}`;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const history = await getConfigHistory(fullName, limit);
    res.json({ history });
  } catch (err) {
    logger.error({ err, repo: fullName }, "Failed to get config history");
    res.status(500).json({ error: "Failed to get config history" });
  }
});

// ── POST restore a specific version ────────────────────────────────────────
configRouter.post("/:owner/:repo/restore/:historyId", async (req, res) => {
  const { owner, repo, historyId } = req.params;
  const fullName = `${owner}/${repo}`;

  try {
    const actor = req.headers["x-actor-login"] || "dashboard";
    const config = await restoreConfigVersion(fullName, parseInt(historyId), actor);
    res.json({ ok: true, config, message: `Restored from version ${historyId}` });
  } catch (err) {
    logger.error({ err, repo: fullName, historyId }, "Failed to restore config version");
    res.status(400).json({ error: err.message });
  }
});

// ── Helper ──────────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
