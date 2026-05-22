// src/lib/logger.js
import pino from "pino";
import { config } from "../../config/index.js";

export const logger = pino({
  level: config.server.logLevel,
  transport:
    config.server.env !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
  base: { service: "gitwire" },
});
