// src/routes/config.js
// Per-repo .gitwire.yml config overrides — managed via dashboard UI.
//
// GET    /api/config/:owner/:repo         — get resolved config + overrides
// PUT    /api/config/:owner/:repo         — set overrides (partial merge)
// DELETE /api/config/:owner/:repo         — delete overrides (revert to YAML)

import { Router } from "express";
import { getConfigForRepo, getConfigOverrides, setConfigOverrides, deleteConfigOverrides, getConfigHistory, restoreConfigVersion } from "../services/configService.js";
import { DEFAULT_CONFIG, validateConfig } from "@gitwire/rules";
import { evaluateExpr, evaluateExprWithTrace } from "@gitwire/rules/expr";
import { loadPlugins } from "@gitwire/rules/plugins";
import { validatePolicy } from "../services/policyValidationService.js";
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

/**
 * GET /api/config/:owner/:repo/custom-rules
 *
 * Returns the resolved custom rules and named expressions for a repo.
 */
configRouter.get("/:owner/:repo/custom-rules", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const config = await getConfigForRepo(fullName);

    const customRules = config.custom_rules || {};
    const expressions = config.expressions || {};

    // List rule names with their conditions
    const rules = Object.entries(customRules).map(([name, rule]) => ({
      name,
      condition: rule.if,
      actions: (rule.run || []).map((a) => a.action),
    }));

    res.json({
      rules,
      expressions,
      total: rules.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Playground ─────────────────────────────────────────────────────────────

/**
 * POST /api/config/playground
 *
 * Evaluate an expression against a test context.
 * Used by the dashboard config playground.
 *
 * Body: {
 *   expression: string,
 *   context: object,
 *   expressions?: object,  // named expressions
 *   plugins?: Array<{source: string, filename: string}>  // plugin sources
 * }
 */
configRouter.post("/playground", async (req, res) => {
  try {
    const { expression, context = {}, expressions = {}, plugins: pluginSources = [] } = req.body;

    if (!expression || typeof expression !== "string") {
      return res.status(400).json({ error: "expression is required and must be a string" });
    }

    if (typeof context !== "object" || Array.isArray(context)) {
      return res.status(400).json({ error: "context must be an object" });
    }

    // Load plugins if provided
    let pluginFilters = {};
    if (Array.isArray(pluginSources) && pluginSources.length > 0) {
      try {
        pluginFilters = loadPlugins(pluginSources);
      } catch (err) {
        return res.status(400).json({ error: `Plugin load error: ${err.message}` });
      }
    }

    // Resolve named expressions
    const exprContext = { ...context };
    for (const [groupName, group] of Object.entries(expressions)) {
      if (typeof group === "object" && group !== null) {
        exprContext[groupName] = {};
        for (const [key, expr] of Object.entries(group)) {
          try {
            exprContext[groupName][key] = evaluateExpr(expr, context, pluginFilters);
          } catch (_e) {
            exprContext[groupName][key] = undefined;
          }
        }
      } else if (typeof group === "string") {
        try {
          exprContext[groupName] = evaluateExpr(group, context, pluginFilters);
        } catch (_e) {
          exprContext[groupName] = undefined;
        }
      }
    }

    // Evaluate with trace
    const { result, trace } = evaluateExprWithTrace(expression, exprContext, pluginFilters);

    res.json({
      result,
      trace,
      evaluated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({
      error: err.message,
      trace: [],
    });
  }
});

// ── Policy validation (non-mutating) ─────────────────────────────────────

/**
 * POST /api/config/validate
 *
 * Validate a .gitwire.yml policy string without writing or mutating anything.
 * Returns structured output: valid, errors, warnings, enabled_pillars,
 * dry_run, risky_settings, normalized_config.
 *
 * Body: { yaml: string }  or  { config: object }
 */
configRouter.post("/validate", async (req, res) => {
  try {
    const { yaml: yamlText, config: configObj } = req.body;

    // Accept either raw YAML string or pre-parsed config object
    let yamlInput;
    if (typeof yamlText === "string") {
      yamlInput = yamlText;
    } else if (configObj && typeof configObj === "object") {
      // Convert object to YAML for the validator
      // (parseConfig handles the merge + validation pipeline)
      const { dump } = await import("js-yaml");
      yamlInput = dump(configObj);
    } else {
      return res.status(400).json({
        error: "Request body must include 'yaml' (string) or 'config' (object)",
      });
    }

    const result = await validatePolicy(yamlInput);
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Policy validation failed");
    res.status(500).json({ error: "Failed to validate policy" });
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
