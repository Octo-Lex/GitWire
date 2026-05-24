// src/services/telegramNotifyService.js
// Sends notifications from GitWire's webhook pipeline to the Telegram bot.
//
// Called after webhook processing to push real-time alerts:
//   - CI failures and healing results
//   - Quality gate evaluations
//   - Custom rule matches
//   - Issue triage results
//
// The bot must be running at BOT_INTERNAL_URL (default: http://gitwire-bot:3002).

import { logger } from "../lib/logger.js";

const BOT_URL = process.env.BOT_INTERNAL_URL || "http://gitwire-bot:3002";

/**
 * Send a notification to the Telegram bot.
 * Non-blocking — errors are logged but don't affect webhook processing.
 *
 * @param {object} event — { type, repo, ...payload }
 */
export async function notifyTelegram(event) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return; // Bot not configured

  try {
    const res = await fetch(`${BOT_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Telegram notification failed");
    }
  } catch (err) {
    // Non-critical — bot may not be deployed
    logger.debug({ err: err.message }, "Telegram notification skipped");
  }
}

/**
 * Send a CI failure notification.
 */
export function notifyCIFailure(repo, data) {
  return notifyTelegram({
    type: "ci_failure",
    repo,
    pr_number: data.pr_number,
    failure_type: data.failure_type,
    confidence: data.confidence,
    healed: data.healed || false,
  });
}

/**
 * Send a quality gate evaluation notification.
 */
export function notifyGateResult(repo, data) {
  return notifyTelegram({
    type: "quality_gate",
    repo,
    pr_number: data.pr_number,
    passed: data.passed,
    gate_name: data.gate_name,
    summary: data.summary,
  });
}

/**
 * Send a custom rule match notification.
 */
export function notifyCustomRule(repo, data) {
  return notifyTelegram({
    type: "custom_rule",
    repo,
    rule_name: data.rule_name,
    action_type: data.action_type,
    matched: data.matched,
  });
}

/**
 * Send an issue triage notification.
 */
export function notifyTriage(repo, data) {
  return notifyTelegram({
    type: "triage",
    repo,
    issue_number: data.issue_number,
    priority: data.priority,
    triage_type: data.triage_type,
  });
}

/**
 * Send an issue fix notification.
 */
export function notifyIssueFix(repo, data) {
  return notifyTelegram({
    type: "issue_fix",
    repo,
    issue_number: data.issue_number,
    status: data.status,
  });
}
