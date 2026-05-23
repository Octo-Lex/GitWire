// config/index.js
// Validates all required environment variables at startup.
// Throws a clear error if anything is missing so you don't get
// cryptic failures later.

import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env in development
if (process.env.NODE_ENV !== "production") {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: path.join(__dirname, "../.env") });
}

// ── Resolve the GitHub private key ──────────────────────────────────────────
// Accept either a raw PEM string (GITHUB_PRIVATE_KEY) or a path to a .pem file
function resolvePrivateKey() {
  if (process.env.GITHUB_PRIVATE_KEY) {
    // Replace literal \n sequences (common when pasting into .env)
    return process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    const keyPath = path.resolve(process.env.GITHUB_PRIVATE_KEY_PATH);
    return fs.readFileSync(keyPath, "utf8");
  }
  return undefined;
}

// ── Runtime secret guard ───────────────────────────────────────────────────
// Refuse to start if any secret contains a template placeholder value.
// This catches the case where .env.production was copied without editing.
const PLACEHOLDER_PATTERNS = [
  /YOUR[_-]KEY/i,
  /YOUR[_-]SECRET/i,
  /YOUR[_-]TOKEN/i,
  /YOUR[_-]PASSWORD/i,
  /YOURDOMAIN/i,
  /^changeme/i,
  /^sk-ant-YOUR/i,
];

function checkPlaceholders(env) {
  const SECRET_KEYS = [
    "ANTHROPIC_API_KEY",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "API_KEY",
    "TUNNEL_TOKEN",
    "DB_PASSWORD",
  ];

  const violations = [];
  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (!value) continue; // missing is fine (optional fields)
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(value)) {
        violations.push(`${key} contains placeholder "${value}"`);
        break;
      }
    }
  }
  return violations;
}

// Strip empty-string env vars so Zod .optional() works correctly
// (an empty string like GITHUB_APP_ID= fails .min(1) before .optional() applies)
function cleanEnv(env) {
  const cleaned = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== "") {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

const schema = z.object({
  // GitHub App
  GITHUB_APP_ID: z.string().min(1, "GITHUB_APP_ID is required").optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1, "GITHUB_APP_CLIENT_ID is required").optional(),
  GITHUB_APP_CLIENT_SECRET: z
    .string()
    .min(1, "GITHUB_APP_CLIENT_SECRET is required")
    .optional(),
  GITHUB_WEBHOOK_SECRET: z
    .string()
    .min(1, "GITHUB_WEBHOOK_SECRET is required")
    .optional(),
  GITHUB_PRIVATE_KEY: z.string().min(1, "GitHub private key is required").optional(),

  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),

  // Database
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL URL"),

  // Redis
  REDIS_URL: z.string().url("REDIS_URL must be a valid Redis URL"),

  // Claude
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required").optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  // App
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL").default("http://localhost:3000"),
});

const rawEnv = {
  ...cleanEnv(process.env),
  GITHUB_PRIVATE_KEY: resolvePrivateKey(),
};

// ── Check for placeholder secrets BEFORE schema validation ─────────────────
if (process.env.NODE_ENV === "production") {
  const placeholderViolations = checkPlaceholders(process.env);
  if (placeholderViolations.length > 0) {
    console.error("🚨  FATAL: Placeholder secrets detected in production environment!");
    console.error("   The following values must be replaced with real secrets:");
    placeholderViolations.forEach((v) => console.error(`   • ${v}`));
    console.error("");
    console.error("   Copy .env.example to .env and fill in real values:");
    console.error("     cp .env.example .env && nano .env");
    process.exit(1);
  }
}

const parsed = schema.safeParse(rawEnv);

if (!parsed.success) {
  console.error("❌  Environment validation failed:");
  parsed.error.issues.forEach((issue) => {
    console.error(`   • ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

export const config = {
  github: {
    appId:         parsed.data.GITHUB_APP_ID         || "",
    clientId:      parsed.data.GITHUB_APP_CLIENT_ID  || "",
    clientSecret:  parsed.data.GITHUB_APP_CLIENT_SECRET || "",
    webhookSecret: parsed.data.GITHUB_WEBHOOK_SECRET   || "dev-secret",
    privateKey:    parsed.data.GITHUB_PRIVATE_KEY       || "",
  },
  server: {
    port: parsed.data.PORT,
    env: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    baseUrl: parsed.data.APP_BASE_URL,
  },
  db: {
    url: parsed.data.DATABASE_URL,
  },
  redis: {
    url: parsed.data.REDIS_URL,
  },
  anthropic: {
    apiKey: parsed.data.ANTHROPIC_API_KEY || "",
    baseURL: parsed.data.ANTHROPIC_BASE_URL || undefined,
  },
};

// ── Register config with @gitwire/runtime auto-init ───────────────────────
// This MUST run before any compat module is first accessed.
// It allows module-level code (like export const phase4Queue = createQueue(...))
// to work even though initRuntime() hasn't been called yet.
import { setConfig } from "@gitwire/runtime/compat/_init.js";
setConfig(config);
