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

  // ── API key authentication ─────────────────────────────────────────────────
  app.use(apiKeyAuth);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "gitops-hub", ts: new Date().toISOString() });
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

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    logger.error({ err, path: req.path }, "Unhandled error");
    res.status(500).json({
      error: config.server.env === "production" ? "Internal server error" : err.message,
    });
  });

  return app;
}
