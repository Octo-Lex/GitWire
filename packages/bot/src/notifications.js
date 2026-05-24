// packages/bot/src/notifications.js
// GitWire → Telegram notification sender.
//
// The bot exposes a POST /notify endpoint that GitWire's webhook pipeline
// calls after processing events. This module formats and sends those
// notifications to authenticated Telegram users.

import Redis from "ioredis";

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
    case "ci_healing":
      return (
        `${emoji} <b>CI ${event.healed ? "Healed" : "Failure"}</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.pr_number ? `PR: #${event.pr_number}\n` : ""}` +
        `${event.failure_type ? `Type: ${esc(event.failure_type)}\n` : ""}` +
        `${event.confidence ? `Confidence: ${Math.round(event.confidence * 100)}%\n` : ""}` +
        `${event.healed ? "✅ Auto-patch applied" : "⚠️ Needs attention"}`
      );

    case "quality_gate":
    case "gate_evaluation":
      return (
        `${emoji} <b>Quality Gate ${event.passed ? "PASSED" : "FAILED"}</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.pr_number ? `PR: #${event.pr_number}\n` : ""}` +
        `${event.gate_name ? `Gate: ${esc(event.gate_name)}\n` : ""}` +
        `${event.summary ? esc(event.summary) : ""}`
      );

    case "custom_rule":
      return (
        `${emoji} <b>Custom Rule Matched</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `Rule: ${esc(event.rule_name || "unknown")}\n` +
        `Action: ${esc(event.action_type || "unknown")}`
      );

    case "triage":
      return (
        `${emoji} <b>Issue Triaged</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.issue_number ? `Issue: #${event.issue_number}\n` : ""}` +
        `Priority: ${esc(event.priority || "unknown")}\n` +
        `Type: ${esc(event.triage_type || "unknown")}`
      );

    case "issue_fix":
      return (
        `${emoji} <b>Issue Fix Attempt</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.issue_number ? `Issue: #${event.issue_number}\n` : ""}` +
        `Status: ${esc(event.status || "unknown")}`
      );

    default:
      return (
        `${emoji} <b>${esc(type)}</b>\n` +
        `Repo: <code>${esc(repo)}</code>\n` +
        `${event.action ? `Action: ${esc(event.action)}\n` : ""}` +
        `${event.status ? `Status: ${esc(event.status)}` : ""}`
      );
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

  const text = formatNotification(payload);

  for (const chatId of subscribers) {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    } catch (_e) {
      // User may have blocked the bot — skip silently
    }
  }
}
