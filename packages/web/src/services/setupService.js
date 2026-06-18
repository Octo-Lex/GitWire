// src/services/setupService.js
// First-run setup checklist — read-only health and integration checks.
//
// computeSetupStatus() is a PURE function: pass it an array of check results,
// get back { overall, completed, total, next_step }. No side effects, no I/O.
// This makes every state (ready, not_configured, action_needed, degraded)
// trivially unit-testable.
//
// getSetupStatus() is the async gatherer that pings DB, Redis, and runs
// count queries to build the checks array, then delegates to computeSetupStatus.

import { db } from "../lib/db.js";
import { redis } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { config } from "../../config/index.js";
import { DEFAULT_CONFIG } from "@gitwire/rules";

// ── Recommendations for the "next step" CTA ─────────────────────────────────
const RECOMMENDATIONS = {
  github_app_configured:
    "Set GITHUB_APP_ID and GITHUB_PRIVATE_KEY in your .env file. See the GitHub App setup guide.",
  database_connected:
    "Ensure PostgreSQL is running and DATABASE_URL is correct: docker compose up -d postgres",
  redis_connected:
    "Ensure Redis is running and REDIS_URL is correct: docker compose up -d redis",
  installations_linked:
    "Install the GitWire GitHub App from your GitHub organization or account settings.",
  repos_synced:
    "Trigger a full sync — the sync worker will import your repositories.",
  webhooks_receiving:
    "Verify your webhook URL is publicly reachable. Use ngrok or a tunnel during development.",
  gitwire_yml_found:
    "Add a .gitwire.yml file to your repos, or use the dashboard config page for overrides.",
  dry_run_status:
    "Consider enabling dry-run mode (settings.dry_run: true) in .gitwire.yml for safer initial testing.",
};

// ── Pure function: compute overall status from check results ────────────────
//
// Overall status logic (per v0.18 design):
//
//   degraded        = any check status === "error"
//   not_configured  = any blocking config/infra check is fail
//   action_needed   = blocking checks pass, but a blocking integration check
//                     fails OR a non-blocking check has warn/fail
//   ready           = all checks pass (no errors, no blocking fails, no warnings)
//
// `checks` shape: { id, label, category, status, blocking, detail }
//   status ∈ { "pass", "warn", "fail", "error" }
//   category ∈ { "config", "infra", "integration", "policy" }

export function computeSetupStatus(checks) {
  const hasError = checks.some((c) => c.status === "error");

  const blockingFails = checks.filter(
    (c) => c.blocking && c.status === "fail"
  );
  const configInfraFails = blockingFails.filter(
    (c) => c.category === "config" || c.category === "infra"
  );
  const nonBlockingIssues = checks.filter(
    (c) => !c.blocking && c.status !== "pass"
  );

  let overall;
  if (hasError) {
    overall = "degraded";
  } else if (configInfraFails.length > 0) {
    overall = "not_configured";
  } else if (blockingFails.length > 0 || nonBlockingIssues.length > 0) {
    overall = "action_needed";
  } else {
    overall = "ready";
  }

  const completed = checks.filter((c) => c.status === "pass").length;

  // Next step: first non-passing check, prioritized by category
  const priority = { config: 0, infra: 1, integration: 2, policy: 3 };
  const nextCheck = checks
    .filter((c) => c.status !== "pass")
    .sort(
      (a, b) =>
        (priority[a.category] ?? 99) - (priority[b.category] ?? 99)
    )[0];

  const next_step = nextCheck
    ? {
        id: nextCheck.id,
        label: nextCheck.label,
        detail: nextCheck.detail,
        recommendation:
          RECOMMENDATIONS[nextCheck.id] ?? nextCheck.detail,
      }
    : null;

  return { overall, completed, total: checks.length, next_step };
}

// ── Async gatherer: run all checks and return full status ──────────────────

export async function getSetupStatus() {
  const checks = [
    checkGithubApp(),
    await checkDatabase(),
    await checkRedis(),
    await checkInstallations(),
    await checkReposSynced(),
    await checkWebhooks(),
    await checkGitwireYml(),
    checkDryRun(),
  ];

  return { ...computeSetupStatus(checks), checks };
}

// ── Individual checks ───────────────────────────────────────────────────────
// Each returns { id, label, category, status, blocking, detail }.
// Security: never return secret VALUES — only boolean presence.

function checkGithubApp() {
  const hasAppId = !!config.github?.appId;
  const hasKey = !!config.github?.privateKey;
  const configured = hasAppId && hasKey;

  return {
    id: "github_app_configured",
    label: "GitHub App configured",
    category: "config",
    blocking: true,
    status: configured ? "pass" : "fail",
    detail: configured
      ? "GitHub App ID and private key are set"
      : "Missing GitHub App credentials — set GITHUB_APP_ID and GITHUB_PRIVATE_KEY in .env",
  };
}

async function checkDatabase() {
  try {
    await db.query("SELECT 1");
    return {
      id: "database_connected",
      label: "Database connected",
      category: "infra",
      blocking: true,
      status: "pass",
      detail: "PostgreSQL is reachable",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: database ping failed");
    return {
      id: "database_connected",
      label: "Database connected",
      category: "infra",
      blocking: true,
      status: "error",
      detail: "Cannot connect to PostgreSQL — verify DATABASE_URL",
    };
  }
}

async function checkRedis() {
  try {
    await redis.ping();
    return {
      id: "redis_connected",
      label: "Redis connected",
      category: "infra",
      blocking: true,
      status: "pass",
      detail: "Redis is reachable",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: redis ping failed");
    return {
      id: "redis_connected",
      label: "Redis connected",
      category: "infra",
      blocking: true,
      status: "error",
      detail: "Cannot connect to Redis — verify REDIS_URL",
    };
  }
}

async function checkInstallations() {
  try {
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM installations WHERE deleted_at IS NULL"
    );
    const cnt = rows[0]?.cnt || 0;
    return {
      id: "installations_linked",
      label: "GitHub App installed",
      category: "integration",
      blocking: true,
      status: cnt > 0 ? "pass" : "fail",
      detail:
        cnt > 0
          ? `${cnt} installation(s) linked`
          : "No installations — install the GitWire GitHub App on your org or repos",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: installations query failed");
    return {
      id: "installations_linked",
      label: "GitHub App installed",
      category: "integration",
      blocking: true,
      status: "error",
      detail: "Failed to query installations: " + err.message,
    };
  }
}

async function checkReposSynced() {
  try {
    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS cnt FROM repositories"
    );
    const cnt = rows[0]?.cnt || 0;
    return {
      id: "repos_synced",
      label: "Repositories synced",
      category: "integration",
      blocking: true,
      status: cnt > 0 ? "pass" : "fail",
      detail:
        cnt > 0
          ? `${cnt} repos synced`
          : "No repos synced yet — trigger a full sync",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: repos query failed");
    return {
      id: "repos_synced",
      label: "Repositories synced",
      category: "integration",
      blocking: true,
      status: "error",
      detail: "Failed to query repositories: " + err.message,
    };
  }
}

async function checkWebhooks() {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS cnt, MAX(received_at) AS last_received
       FROM webhook_deliveries WHERE received_at > NOW() - INTERVAL '7 days'`
    );
    const cnt = rows[0]?.cnt || 0;
    const last = rows[0]?.last_received;

    // Warn (not fail) — a correctly installed but quiet repo may have no recent traffic
    return {
      id: "webhooks_receiving",
      label: "Webhook events received",
      category: "integration",
      blocking: false,
      status: cnt > 0 ? "pass" : "warn",
      detail:
        cnt > 0
          ? `${cnt} event(s) in last 7 days`
          : last
            ? `No events in 7 days (last: ${new Date(last).toLocaleDateString()})`
            : "No webhook events received yet",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: webhooks query failed");
    return {
      id: "webhooks_receiving",
      label: "Webhook events received",
      category: "integration",
      blocking: false,
      status: "error",
      detail: "Failed to query webhook deliveries: " + err.message,
    };
  }
}

async function checkGitwireYml() {
  try {
    const { rows } = await db.query(
      "SELECT COUNT(DISTINCT repo_id)::int AS cnt FROM repo_config"
    );
    const cnt = rows[0]?.cnt || 0;

    // Non-blocking warning — GitWire runs on defaults without a .gitwire.yml,
    // but operators should be nudged toward explicit policy.
    return {
      id: "gitwire_yml_found",
      label: "Policy file configured",
      category: "policy",
      blocking: false,
      status: cnt > 0 ? "pass" : "warn",
      detail:
        cnt > 0
          ? `${cnt} repo(s) with config overrides`
          : "No .gitwire.yml or dashboard overrides — using defaults",
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Setup check: gitwire_yml query failed");
    return {
      id: "gitwire_yml_found",
      label: "Policy file configured",
      category: "policy",
      blocking: false,
      status: "error",
      detail: "Failed to query repo config: " + err.message,
    };
  }
}

function checkDryRun() {
  // Informational — shows whether the default mode is dry-run or live.
  // Non-blocking: live mode is intentional for production, not a setup failure.
  const dryRun = DEFAULT_CONFIG.settings?.dry_run === true;

  return {
    id: "dry_run_status",
    label: "Dry-run mode",
    category: "policy",
    blocking: false,
    status: dryRun ? "pass" : "warn",
    detail: dryRun
      ? "Dry-run enabled — GitWire logs actions without applying changes"
      : "Live mode — GitWire will apply changes to GitHub",
  };
}
