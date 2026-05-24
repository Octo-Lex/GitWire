// src/app.js
// Express application factory.
// Keeps app creation separate from server startup so it's testable.

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { webhookRouter }      from "./routes/webhooks.js";
import { reposRouter }         from "./routes/repos.js";
import { issuesRouter }        from "./routes/issues.js";
import { pullRequestsRouter }  from "./routes/pullRequests.js";
import { ciRouter }            from "./routes/ciRuns.js";
import { insightsRouter }      from "./routes/insights.js";
import { maintainerRouter }     from "./routes/maintainer.js";
import { fixRouter }              from "./routes/fix.js";
import { healRouter }          from "./routes/healHistory.js";
import { duplicatesRouter }    from "./routes/duplicates.js";
import { enforcementRouter }  from "./routes/enforcement.js";
import { phase2Router }       from "./routes/phase2.js";
import { phase3Router }       from "./routes/phase3.js";
import { phase4Router }       from "./routes/phase4.js";
import { configRouter }        from "./routes/config.js";
import activityRouter from "./routes/activity.js";
import readinessRouter from "./routes/readiness.js";
import { decisionsRouter } from "./routes/decisions.js";
import waiverRouter from "./routes/waivers.js";
import gatesRouter from "./routes/gates.js";
import webhookDeliveriesRouter from "./routes/webhookDeliveries.js";
import authRouter from "./routes/auth.js";
import actionsRouter from "./routes/actions.js";
import { apiKeyAuth }           from "./middleware/auth.js";
import { rateLimiter }          from "./middleware/rateLimiter.js";
import { logger } from "./lib/logger.js";
import { config } from "../config/index.js";

export function createApp() {
  const app = express();

  // ── Security headers ────────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS (restrict to your frontend domain in production) ───────────────
  app.use(
    cors({
      origin:
        config.server.env === "production"
          ? config.server.baseUrl
          : ["http://localhost:3001", "http://localhost:3000"],
      credentials: true,
    })
  );

  // ── Request logging ─────────────────────────────────────────────────────
  app.use(
    morgan("combined", {
      stream: { write: (msg) => logger.info(msg.trim()) },
      skip: (_req, res) => res.statusCode < 400, // only log errors in prod
    })
  );

  // ── Body parsing ─────────────────────────────────────────────────────────
  // NOTE: The webhook route handles its own raw body parsing for HMAC
  // verification. Apply json() only to non-webhook routes.
  app.use((req, res, next) => {
    if (req.path.startsWith("/webhooks")) return next();
    express.json({ limit: "1mb" })(req, res, next);
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  app.use(rateLimiter);

  // ── Auth routes (no API key required) ─────────────────────────────────────
  app.use("/api/auth", authRouter);

  // ── API key authentication ─────────────────────────────────────────────────
  app.use(apiKeyAuth);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "gitwire", ts: new Date().toISOString() });
  });

  app.use("/webhooks", webhookRouter);

  // ── REST API ──────────────────────────────────────────────────────────────
  app.use("/api/repos",          reposRouter);
  app.use("/api/issues",         issuesRouter);
  app.use("/api/pull-requests",  pullRequestsRouter);
  app.use("/api/ci",             ciRouter);
  app.use("/api/insights",       insightsRouter);
  app.use("/api/maintainer",     maintainerRouter);
  app.use("/api/fix",             fixRouter);
  app.use("/api/heal",            healRouter);
  app.use("/api/duplicates",       duplicatesRouter);

  // ── Phase 1: Enforcement ─────────────────────────────────────────────────
  app.use("/api/enforcement",     enforcementRouter);

  // ── Phase 2: Automation ──────────────────────────────────────────────────
  app.use("/api/phase2",          phase2Router);

  // ── Phase 3: Trust & Resilience ──────────────────────────────────────────
  app.use("/api/phase3",          phase3Router);

  // ── Phase 4: Intelligence & Compliance ──────────────────────────────────
  app.use("/api",                 phase4Router);

  // ── Config: per-repo .gitwire.yml overrides ─────────────────────────────
  app.use("/api/config",          configRouter);
  app.use("/api/activity",         activityRouter);
  app.use("/api/readiness",        readinessRouter);
  app.use("/api/decisions",        decisionsRouter);
  app.use("/api/waivers",          waiverRouter);
  app.use("/api/gates",            gatesRouter);
  app.use("/api/webhooks/deliveries", webhookDeliveriesRouter);
  app.use("/api/actions",            actionsRouter);

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    // Malformed JSON body → 400, not 500
    // body-parser creates errors with {status:400, statusCode:400, body:'...'}
    // Note: 'body' is a non-enumerable property on body-parser errors
    if (err.status === 400 || err.statusCode === 400) {
      if (err.type === 'SyntaxError' || (err.message && err.message.includes('JSON'))) {
        return res.status(400).json({ error: 'Invalid JSON', message: err.message });
      }
    }
    logger.error({ err, path: req.path }, "Unhandled error");
    res.status(500).json({
      error: config.server.env === "production" ? "Internal server error" : err.message,
    });
  });

  return app;
}
