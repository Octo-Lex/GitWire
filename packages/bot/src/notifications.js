// packages/bot/src/notifications.js
// GitWire → Telegram notification sender.
//
// The bot exposes a POST /notify endpoint that GitWire's webhook pipeline
// calls after processing events. This module formats and sends those
// notifications to authenticated Telegram users.

import Redis from "ioredis";
import { getUserKey } from "./auth.js";
import { escHtml as escHtmlOrig } from "./auth.js";

const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");
const SUBSCRIBER_PREFIX = "gitwire:tg-sub:";

/**
 * Subscribe a Telegram user to notifications.
 * Stores their chat_id so we can push messages.
 */
export async function subscribe(userId, chatId) {
  await redis.set(SUBSCRIBER_PREFIX + userId, chatId);
}

/**
 * Unsubscribe from notifications.
 */
export async function unsubscribe(userId) {
  await redis.del(SUBSCRIBER_PREFIX + userId);
}

/**
 * Get all subscribed chat IDs (for broadcast).
 */
export async function getSubscribers() {
  const keys = await redis.keys(SUBSCRIBER_PREFIX + "*");
  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  return values.filter(Boolean).map(Number);
}

/**
 * Format a notification from GitWire event data.
 */
export function formatNotification(event) {
  const type = event.type || event.event_name || "event";
  const repo = event.repo || "";
  const emoji = getEmoji(type);

  switch (type) {
    case "ci_failure":
    case "ci_healing": {
      let text =
        `${emoji} <b>CI ${event.healed ? "Healed" : "Failure"}</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.pr_number ? `PR: #${event.pr_number}\n` : ""}` +
        `${event.failure_type ? `Type: ${esc(event.failure_type)}\n` : ""}` +
        `${event.confidence ? `Confidence: ${Math.round(event.confidence * 100)}%\n` : ""}` +
        `${event.healed ? "✅ Auto-patch applied" : "⚠️ Needs attention"}`;

      // Add interactive buttons for unhealed failures
      const buttons = [];
      if (!event.healed && event.pr_number && repo) {
        buttons.push([
          { text: "🔧 Heal", callback_data: `heal:${repo}:${event.pr_number}` },
          { text: "⏭ Ignore", callback_data: `ignore:${repo}:${event.pr_number}` },
        ]);
      }

      return { text, buttons };
    }

    case "quality_gate":
    case "gate_evaluation": {
      let text =
        `${emoji} <b>Quality Gate ${event.passed ? "PASSED" : "FAILED"}</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.pr_number ? `PR: #${event.pr_number}\n` : ""}` +
        `${event.gate_name ? `Gate: ${esc(event.gate_name)}\n` : ""}` +
        `${event.summary ? esc(event.summary) : ""}`;

      const buttons = [];
      if (!event.passed && repo) {
        buttons.push([
          { text: "🔄 Re-evaluate", callback_data: `evaluate:${repo}` },
        ]);
      }

      return { text, buttons };
    }

    case "custom_rule":
      return {
        text:
          `${emoji} <b>Custom Rule Matched</b>\n` +
          `Repo: <code>${esc(repo)}</code>\n` +
          `Rule: ${esc(event.rule_name || "unknown")}\n` +
          `Action: ${esc(event.action_type || "unknown")}`,
        buttons: [],
      };

    case "triage":
      return {
        text:
          `${emoji} <b>Issue Triaged</b>\n` +
          `Repo: <code>${esc(repo)}</code>\n` +
          `${event.issue_number ? `Issue: #${event.issue_number}\n` : ""}` +
          `Priority: ${esc(event.priority || "unknown")}\n` +
          `Type: ${esc(event.triage_type || "unknown")}`,
        buttons: [],
      };

    case "issue_fix":
      return {
        text:
          `${emoji} <b>Issue Fix Attempt</b>\n` +
          `Repo: <code>${esc(repo)}</code>\n` +
          `${event.issue_number ? `Issue: #${event.issue_number}\n` : ""}` +
          `Status: ${esc(event.status || "unknown")}`,
        buttons: [],
      };

    default:
      return {
        text:
          `${emoji} <b>${esc(type)}</b>\n` +
          `Repo: <code>${esc(repo)}</code>\n` +
          `${event.action ? `Action: ${esc(event.action)}\n` : ""}` +
          `${event.status ? `Status: ${esc(event.status)}` : ""}`,
        buttons: [],
      };
  }
}

function getEmoji(type) {
  const map = {
    ci_failure: "🚨",
    ci_healing: "🔧",
    quality_gate: "🛡",
    gate_evaluation: "🛡",
    custom_rule: "⚡",
    triage: "🏷",
    issue_fix: "🩹",
    merge: "🔀",
    enforcement: "🔒",
  };
  return map[type] || "📡";
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Handle incoming notification from GitWire.
 * Called by the Express POST /notify handler.
 */
export async function handleNotification(bot, payload) {
  const subscribers = await getSubscribers();
  if (subscribers.length === 0) return;

  const { text, buttons } = formatNotification(payload);

  for (const chatId of subscribers) {
    try {
      const opts = { parse_mode: "HTML" };
      if (buttons && buttons.length > 0) {
        opts.reply_markup = { inline_keyboard: buttons };
      }
      await bot.api.sendMessage(chatId, text, opts);
    } catch (_e) {
      // User may have blocked the bot — skip silently
    }
  }
}

/**
 * Register callback query handlers for inline buttons.
 */
export function registerCallbacks(bot) {
  // /heal button
  bot.callbackQuery(/^heal:(.+):(\d+)$/, async (ctx) => {
    const repo = ctx.match[1];
    const prNumber = ctx.match[2];
    await ctx.answerCallbackQuery({ text: "🔧 Heal requested..." });

    try {
      const apiKey = await getUserKey(ctx.from.id);
      if (!apiKey) {
        return ctx.reply("🔐 Session expired. /start again with your API key.");
      }

      // Re-trigger CI heal via the API
      const [owner, repoName] = repo.split("/");
      await ctx.reply(
        `🔧 CI heal re-triggered for <code>${esc(repo)}</code> PR #${prNumber}.\n` +
        `The next CI failure on this PR will be auto-diagnosed.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // /ignore button
  bot.callbackQuery(/^ignore:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "⏭ Ignored" });
    await ctx.editMessageReplyMarkup(); // Remove buttons
  });

  // /evaluate button
  bot.callbackQuery(/^evaluate:(.+)$/, async (ctx) => {
    const repo = ctx.match[1];
    await ctx.answerCallbackQuery({ text: "🔄 Evaluating..." });

    try {
      const apiKey = await getUserKey(ctx.from.id);
      if (!apiKey) {
        return ctx.reply("🔐 Session expired. /start again.");
      }

      const { evaluateGates: evalGates } = await import("./api.js");
      const [owner, repoName] = repo.split("/");
      const result = await evalGates(apiKey, owner, repoName);

      const passed = result?.passed ?? result?.result === "passed";
      const emoji = passed ? "✅" : "❌";
      await ctx.reply(
        `${emoji} <b>Re-evaluated: ${esc(repo)}</b>\nResult: ${passed ? "PASSED" : "FAILED"}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply("❌ " + escHtml(err.message));
    }
  });
}
