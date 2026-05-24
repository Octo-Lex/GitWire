#!/usr/bin/env node
// packages/bot/src/index.js
// GitWire Telegram Bot — Grammy-based bot with long polling + notification endpoint.
//
// Architecture:
//   - Grammy bot with long polling (no webhook URL needed)
//   - Express server on :3002 for GitWire → Bot notification POST /notify
//   - Redis for auth (telegram_id → api_key) + subscriptions
//   - All data fetched from GitWire REST API (http://gitwire-app:3000)

import { Bot } from "grammy";
import express from "express";
import { registerCommands } from "./commands.js";
import { handleNotification, subscribe, unsubscribe } from "./notifications.js";
import { setUserKey, getUserKey } from "./auth.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = parseInt(process.env.PORT || "3002");

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

// ── Create bot ──────────────────────────────────────────────────────────────
const bot = new Bot(BOT_TOKEN);

// ── Register all commands ───────────────────────────────────────────────────
registerCommands(bot);

// ── Auto-subscribe on auth ──────────────────────────────────────────────────
// When user runs /start, also subscribe them to notifications
bot.command("start", async (ctx, next) => {
  const token = ctx.message?.text?.split(" ")[1];
  if (token) {
    await subscribe(ctx.from.id, ctx.chat.id);
  }
});

// ── /subscribe and /unsubscribe commands ────────────────────────────────────
bot.command("subscribe", async (ctx) => {
  const apiKey = await getUserKey(ctx.from.id);
  if (!apiKey) {
    return ctx.reply("🔐 Authenticate first: /start YOUR_API_KEY");
  }
  await subscribe(ctx.from.id, ctx.chat.id);
  ctx.reply("✅ Subscribed to notifications. You'll receive alerts for CI failures, gate evaluations, and custom rule matches.");
});

bot.command("unsubscribe", async (ctx) => {
  await unsubscribe(ctx.from.id);
  ctx.reply("🔕 Unsubscribed from notifications.");
});

// ── Express server for GitWire → Bot notifications ──────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gitwire-bot", ts: new Date().toISOString() });
});

// Notification endpoint — GitWire POSTs events here
app.post("/notify", async (req, res) => {
  try {
    const payload = req.body;

    // Support single event or batch
    const events = Array.isArray(payload) ? payload : [payload];

    for (const event of events) {
      await handleNotification(bot, event);
    }

    res.json({ ok: true, sent: events.length });
  } catch (err) {
    console.error("Notification error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
async function main() {
  // Start Express server
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`GitWire Bot API listening on :${PORT}`);
  });

  // Start Grammy long polling
  console.log("Starting GitWire Telegram bot (long polling)...");
  await bot.start({
    onStart: (info) => {
      console.log(`Bot started as @${info.username}`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
