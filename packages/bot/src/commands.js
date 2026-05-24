// packages/bot/src/commands.js
// All Telegram bot command handlers.

import {
  requireAuth,
  fmtNum,
  fmtPct,
  trunc,
  escHtml,
} from "./auth.js";

import {
  getHealth,
  getInsights,
  getRepos,
  getReadiness,
  getRepoReadiness,
  getGatesForRepo,
  evaluateGates,
  getDeliveryStats,
  getDecisions,
  getDecisionSummary,
  getRepoConfig,
  getActivitySummary,
} from "./api.js";

/**
 * Register all commands on the bot instance.
 */
export function registerCommands(bot) {
  // ── /start <API_KEY> — Authenticate ───────────────────────────────────────
  bot.command("start", async (ctx) => {
    const token = ctx.message?.text?.split(" ")[1];
    if (!token) {
      return ctx.reply(
        "🔐 <b>Welcome to GitWire Bot</b>\n\n" +
        "Authenticate with your API key:\n" +
        "<code>/start YOUR_API_KEY</code>\n\n" +
        "Get your key from the GitWire dashboard or server .env file.",
        { parse_mode: "HTML" }
      );
    }

    // Validate key by calling health
    try {
      const { importDynamic } = await import("./auth.js");
      const { setUserKey } = await import("./auth.js");
      await setUserKey(ctx.from.id, token);

      // Verify the key works
      const health = await fetch(
        (process.env.GITWIRE_API_URL || "http://gitwire-app:3000") + "/health",
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!health.ok) {
        const { removeUserKey } = await import("./auth.js");
        await removeUserKey(ctx.from.id);
        return ctx.reply("❌ Invalid API key. Try again with <code>/start YOUR_KEY</code>", { parse_mode: "HTML" });
      }

      ctx.reply(
        "✅ <b>Authenticated!</b>\n\n" +
        "You're now connected to GitWire. Use /help to see available commands.",
        { parse_mode: "HTML" }
      );
    } catch (err) {
      ctx.reply("❌ Authentication failed: " + escHtml(err.message));
    }
  });

  // ── /help — Show commands ─────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    ctx.reply(
      "⚡ <b>GitWire Bot Commands</b>\n\n" +
      "<b>Overview</b>\n" +
      "/status — System health + fleet summary\n" +
      "/repos — Connected repositories\n" +
      "/readiness — Fleet readiness scores\n" +
      "/activity — Recent action summary\n\n" +
      "<b>Quality Gates</b>\n" +
      "/gates owner/repo — Gate status for a repo\n" +
      "/evaluate owner/repo — Run gates now\n\n" +
      "<b>Operations</b>\n" +
      "/deliveries — Webhook delivery stats\n" +
      "/decisions — Recent decision log\n" +
      "/config owner/repo — Show .gitwire.yml config\n\n" +
      "<b>Auth</b>\n" +
      "/start API_KEY — Authenticate\n" +
      "/whoami — Show auth status\n" +
      "/logout — Remove your API key",
      { parse_mode: "HTML" }
    );
  });

  // ── /status — System health + fleet summary ───────────────────────────────
  bot.command("status", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first: <code>/start YOUR_API_KEY</code>", { parse_mode: "HTML" });

    try {
      const [health, summary] = await Promise.all([
        getHealth(apiKey),
        getActivitySummary(apiKey).catch(() => null),
      ]);

      let text = "✅ <b>GitWire Status</b>\n\n";
      text += `Service: <b>${escHtml(health.status)}</b>\n`;
      text += `Time: ${new Date(health.ts).toLocaleString()}\n`;

      if (summary) {
        text += `\n📊 <b>Activity</b>\n`;
        text += `Total actions: ${fmtNum(summary.total)}\n`;
        text += `Last 24h: ${fmtNum(summary.recent?.last_24h)}\n`;
        text += `Last 7d: ${fmtNum(summary.recent?.last_7d)}\n`;
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /repos — Connected repositories ───────────────────────────────────────
  bot.command("repos", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first: <code>/start YOUR_API_KEY</code>", { parse_mode: "HTML" });

    try {
      const result = await getRepos(apiKey);
      const repos = result?.data ?? result ?? [];

      if (repos.length === 0) {
        return ctx.reply("📦 No connected repositories yet.");
      }

      let text = `📦 <b>${repos.length} Repositories</b>\n\n`;
      for (const r of repos) {
        const name = r.full_name || r.name || "unknown";
        text += `• <code>${escHtml(name)}</code>\n`;
      }
      if (repos.length > 20) text += `\n... and ${repos.length - 20} more`;

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /readiness — Fleet readiness scores ───────────────────────────────────
  bot.command("readiness", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    try {
      const result = await getReadiness(apiKey);
      const repos = result?.repos ?? result?.data ?? (Array.isArray(result) ? result : []);

      if (repos.length === 0) {
        return ctx.reply("📊 No readiness data yet.");
      }

      const avg = result?.average_score;
      let text = "📊 <b>Fleet Readiness</b>";
      if (avg != null) text += ` — avg: ${Math.round(avg)}`;
      text += "\n\n";
      for (const r of repos.slice(0, 10)) {
        const score = r.readiness_score ?? r.score ?? "—";
        const emoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";
        text += `${emoji} <code>${escHtml(r.full_name || r.repo)}</code> — ${score}\n`;
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /gates owner/repo — Quality gate status ───────────────────────────────
  bot.command("gates", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    const args = ctx.message?.text?.split(" ").slice(1).join(" ");
    if (!args || !args.includes("/")) {
      return ctx.reply("Usage: <code>/gates owner/repo</code>", { parse_mode: "HTML" });
    }

    try {
      const [owner, repo] = args.split("/");
      const result = await getGatesForRepo(apiKey, owner, repo);
      const gates = result?.gates ?? result?.data ?? [];

      if (gates.length === 0) {
        return ctx.reply(`🛡 No quality gates configured for <code>${escHtml(args)}</code>`, { parse_mode: "HTML" });
      }

      let text = `🛡 <b>Quality Gates: ${escHtml(args)}</b>\n\n`;
      for (const g of gates) {
        const status = g.last_result === "passed" ? "✅" : g.last_result === "failed" ? "❌" : "⚪";
        text += `${status} <b>${escHtml(g.name)}</b>`;
        if (g.is_default) text += " (default)";
        text += "\n";

        if (g.conditions) {
          for (const c of g.conditions) {
            const metric = c.metric || "unknown";
            const passed = c.passed ? "✓" : "✗";
            const actual = c.actual != null ? fmtPct(c.actual) : "—";
            const threshold = c.threshold != null ? fmtPct(c.threshold) : "—";
            text += `  ${passed} ${metric}: ${actual} ${c.operator} ${threshold}\n`;
          }
        }
        text += "\n";
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /evaluate owner/repo — Run quality gates ──────────────────────────────
  bot.command("evaluate", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    const args = ctx.message?.text?.split(" ").slice(1).join(" ");
    if (!args || !args.includes("/")) {
      return ctx.reply("Usage: <code>/evaluate owner/repo</code>", { parse_mode: "HTML" });
    }

    try {
      const [owner, repo] = args.split("/");
      const result = await evaluateGates(apiKey, owner, repo);

      const passed = result?.passed ?? result?.result === "passed";
      const emoji = passed ? "✅" : "❌";
      let text = `${emoji} <b>Gate Evaluation: ${escHtml(args)}</b>\n`;
      text += `Result: ${passed ? "PASSED" : "FAILED"}\n`;

      if (result?.summary) text += `\n${escHtml(result.summary)}`;

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /deliveries — Webhook delivery stats ──────────────────────────────────
  bot.command("deliveries", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    try {
      const stats = await getDeliveryStats(apiKey);

      let text = "🔗 <b>Webhook Deliveries</b>\n\n";
      text += `Total: <b>${fmtNum(stats.total)}</b>\n`;
      text += `Errors: <b>${stats.errors}</b> (${fmtPct(stats.error_rate)})\n`;
      text += `Last 24h: ${fmtNum(stats.last_24h)}\n`;
      text += `Last 7d: ${fmtNum(stats.last_7d)}\n`;
      text += `Events/hour: ${stats.events_per_hour}\n`;
      text += `Active repos: ${stats.active_repos}\n`;

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /decisions — Recent decision log ──────────────────────────────────────
  bot.command("decisions", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    try {
      const result = await getDecisions(apiKey);
      const decisions = result?.data ?? result ?? [];

      if (decisions.length === 0) {
        return ctx.reply("⚖ No recent decisions.");
      }

      let text = `⚖ <b>Recent Decisions</b>\n\n`;
      for (const d of decisions.slice(0, 8)) {
        const action = d.action || d.decision || "unknown";
        const repo = d.repo || d.repo_name || "";
        const pillar = d.pillar || "";
        const reason = trunc(d.reason || d.rationale || "", 50);
        const emoji = action === "acted" ? "✅" : action === "skipped" ? "⏭" : action === "blocked" ? "🚫" : "•";

        text += `${emoji} <code>${escHtml(repo)}</code> ${escHtml(pillar)}: ${escHtml(reason)}\n`;
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /config owner/repo — Show .gitwire.yml config ─────────────────────────
  bot.command("config", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    const args = ctx.message?.text?.split(" ").slice(1).join(" ");
    if (!args || !args.includes("/")) {
      return ctx.reply("Usage: <code>/config owner/repo</code>", { parse_mode: "HTML" });
    }

    try {
      const [owner, repo] = args.split("/");
      const result = await getRepoConfig(apiKey, owner, repo);

      let text = `⚙ <b>Config: ${escHtml(args)}</b>\n\n`;

      // Show enabled pillars
      const config = result?.config || result?.merged || result;
      if (config?.pillars) {
        text += "<b>Pillars:</b>\n";
        for (const [name, settings] of Object.entries(config.pillars)) {
          if (typeof settings === "object" && settings.enabled !== false) {
            text += `  ✅ ${name}\n`;
          }
        }
      }

      // Dry run
      if (config?.settings?.dry_run) {
        text += "\n⚠️ <b>DRY RUN MODE</b> — no mutations applied";
      }

      // Custom rules
      if (config?.custom_rules?.length) {
        text += `\n⚡ ${config.custom_rules.length} custom rule(s)`;
      }

      // Quality gates
      if (config?.quality_gates?.length) {
        text += `\n🛡 ${config.quality_gates.length} quality gate(s)`;
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /activity — Recent action summary ─────────────────────────────────────
  bot.command("activity", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    try {
      const summary = await getActivitySummary(apiKey);

      let text = "📊 <b>Activity Summary</b>\n\n";
      text += `Total actions: <b>${fmtNum(summary.total)}</b>\n`;
      text += `Last 24h: ${fmtNum(summary.recent?.last_24h)}\n`;
      text += `Last 7d: ${fmtNum(summary.recent?.last_7d)}\n\n`;

      // Breakdown by source
      if (summary.by_source) {
        text += "<b>By Source:</b>\n";
        for (const [key, val] of Object.entries(summary.by_source)) {
          const src = val.source || key;
          const statuses = val.statuses || {};
          const ok = statuses.ok || statuses.success || 0;
          const err = statuses.error || statuses.failed || 0;
          text += `  ${src}: ${fmtNum(ok)} ok`;
          if (err > 0) text += `, ${err} errors`;
          text += "\n";
        }
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /actions — Recent action lifecycle ────────────────────────────────────
  bot.command("actions", async (ctx) => {
    const apiKey = await requireAuth(ctx.from.id).catch(() => null);
    if (!apiKey) return ctx.reply("🔐 Authenticate first", { parse_mode: "HTML" });

    try {
      const result = await fetch(
        (process.env.GITWIRE_API_URL || "http://gitwire-app:3000") + "/api/actions?limit=10",
        { headers: { Authorization: `Bearer ${apiKey}` } }
      ).then((r) => r.json());

      const actions = result?.data ?? [];
      if (actions.length === 0) {
        return ctx.reply("⚙️ No actions tracked yet.");
      }

      let text = "⚙️ <b>Recent Actions</b>\n\n";
      for (const a of actions) {
        const statusEmoji = {
          proposed: "💡", approved: "✅", executing: "⚡", succeeded: "✅",
          failed: "❌", retrying: "🔄", cancelled: "🚫", reconciled: "🔒",
        }[a.status] || "•";
        const repo = (a.repo_full_name || "").split("/").pop();
        text += `${statusEmoji} <code>${escHtml(repo)}</code> ${escHtml(a.action_type)} — ${a.status}`;
        if (a.retries > 0) text += ` (${a.retries} retries)`;
        text += "\n";
      }

      ctx.reply(text, { parse_mode: "HTML" });
    } catch (err) {
      ctx.reply("❌ " + escHtml(err.message));
    }
  });

  // ── /logout — Remove API key ──────────────────────────────────────────────
  bot.command("logout", async (ctx) => {
    const { removeUserKey } = await import("./auth.js");
    await removeUserKey(ctx.from.id);
    ctx.reply("👋 Logged out. Your API key has been removed.");
  });

  // ── /whoami — Show current auth status ─────────────────────────────────────
  bot.command("whoami", async (ctx) => {
    const apiKey = await getUserKey(ctx.from.id);
    if (!apiKey) {
      return ctx.reply("🔐 Not authenticated. Use /start YOUR_API_KEY");
    }

    try {
      const health = await getHealth(apiKey);
      ctx.reply(
        "✅ <b>Authenticated</b>\n" +
        `User ID: <code>${ctx.from.id}</code>\n` +
        `API: <code>${escHtml(apiKey.slice(0, 8))}...${escHtml(apiKey.slice(-4))}</code>\n` +
        `Gateway: ${escHtml(health.status)}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      ctx.reply("❌ API key invalid or server unreachable. Try /start again.");
    }
  });
}
