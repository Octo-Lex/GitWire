# First-Run Onboarding Walkthrough

This guide walks you through installing GitWire from zero to your first governed policy rollout. If you follow it in order, you will have a working, safe GitWire installation in about 30 minutes.

::: tip Who this is for
You are new to GitWire. You have a GitHub account, an Anthropic API key, and a server (VPS or local). You want to see GitWire working on a real repo before trusting it.
:::

## The 10-Step Path

```mermaid
graph LR
    A[1. Install] --> B[2. Configure App]
    B --> C[3. Start Services]
    C --> D[4. Open Dashboard]
    D --> E[5. Use Checklist]
    E --> F[6. Pick Template]
    F --> G[7. Validate Policy]
    G --> H[8. Simulate Policy]
    H --> I[9. Create Rollout]
    I --> J[10. Approve & Promote]
    J --> K[✅ First governed rollout]
```

---

## Step 1: Install GitWire

Clone the repository and configure environment:

```bash
git clone https://github.com/Octo-Lex/GitWire.git
cd GitWire
cp packages/web/.env.example packages/web/.env
```

Edit `packages/web/.env` — leave the GitHub values empty for now, we'll fill them in Step 2.

See [Prerequisites](/installation/prerequisites) for server requirements and [Docker Compose](/installation/docker-compose) for full deployment details.

## Step 2: Configure the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
2. Set:
   - **Name:** `GitWire`
   - **Homepage URL:** your domain
   - **Webhook URL:** `https://yourdomain/webhooks/github`
   - **Webhook secret:** generate a random string
3. Set repository permissions (see the [GitHub App Setup guide](/installation/github-app-setup) for the full table)
4. Subscribe to events: Issues, Pull requests, Issue comment, Check runs, Workflows
5. Generate a private key (`.pem` file download)
6. Install the App on your chosen repository

Now fill in your `.env`:

```bash
GITHUB_APP_ID=1234567                    # from the App settings page
GITHUB_APP_CLIENT_ID=Iv1.xxxxx            # from the App settings page
GITHUB_APP_CLIENT_SECRET=your-secret       # from the App settings page
GITHUB_WEBHOOK_SECRET=your-webhook-secret  # the string you generated above
GITHUB_PRIVATE_KEY_PATH=./gitwire.private-key.pem
DATABASE_URL=postgresql://gitwire:changeme@postgres:5432/gitops_hub
REDIS_URL=redis://redis:6379
ANTHROPIC_API_KEY=sk-ant-xxxxx
APP_BASE_URL=https://gitwire.yourdomain.com
```

Place the private key file:

```bash
cp ~/Downloads/gitwire.private-key.pem packages/web/gitwire.private-key.pem
```

## Step 3: Start Services

```bash
docker compose up -d
```

This starts 5 containers:

| Container | Purpose |
|-----------|---------|
| `gitwire-app` | Express API + 9 background workers |
| `gitwire-dashboard` | Next.js dashboard (port 3001) |
| `postgres` | PostgreSQL 16 database |
| `redis` | Redis 7 for BullMQ job queues |
| `cloudflared` | Cloudflare Tunnel (outbound-only) |

Verify they're running:

```bash
docker compose ps
```

Run database migrations:

```bash
docker compose exec gitwire-app npm run db:migrate
```

::: tip Tunnel setup
If you're using Cloudflare Tunnel, follow the [Cloudflare Tunnel guide](/installation/cloudflare-tunnel) to expose your instance. The tunnel must be running before webhooks can reach GitWire.
:::

## Step 4: Open the Dashboard

Navigate to `http://yourdomain:3001` (or `http://localhost:3001` for local dev).

You'll see the dashboard with a **Setup Checklist** panel at the top.

## Step 5: Use the Setup Checklist

The checklist shows 8 checks. Here's what each means:

| Check | Status | What to do |
|-------|--------|------------|
| GitHub App configured | ✓ Pass | Already done in Step 2 |
| Database connected | ✓ Pass | PostgreSQL is running |
| Redis connected | ✓ Pass | Redis is running |
| GitHub App installed | ✓ Pass | The App is installed on at least one repo |
| Repositories synced | ✓ Pass | At least one repo has been imported |
| Webhook events received | ⚠ Warn | No events yet — trigger a sync or push a commit |
| Policy file configured | ⚠ Warn | No `.gitwire.yml` — pick a template (Step 6) |
| Dry-run mode | ⚠ Warn | Live mode is active by default — consider dry-run |

::: warning Read this before going live
The checklist uses color-coded status:
- **Red** = blocking: infrastructure is down or missing
- **Amber** = action needed: safe to run but recommended to fix
- **Green** = ready: check passed

A production system with live mutations intentionally enabled will show amber for "Dry-run mode" — this is **not** an error.
:::

If any check shows **red**, fix it before continuing. The checklist shows a "Next step" recommendation with specific instructions.

## Step 6: Pick a Starter Template

When `.gitwire.yml` is not found, the checklist shows template suggestions. Each template has an explicit safety label:

| Template | Safety Label | Meaning |
|----------|-------------|---------|
| **Starter (Dry-Run)** | Dry-run protected | All pillars observe only — zero GitHub mutations |
| **Triage Only** | Low-risk live | Labels and comments only — no destructive actions |
| **CI Healing (Preview)** | Safe to preview | CI diagnosis only — no fix PRs opened |
| **Open-Source Maintainer** | Review before rollout | Broad automation — review all pillars before going live |
| **Strict Governance** | Dry-run protected | Enterprise-grade — audit-first, dry-run enforced |

**For your first rollout, pick "Starter (Dry-Run)".** It's the safest possible config: GitWire will triage, diagnose, and review, but perform zero mutations on GitHub.

Click "use →" to open the template in the config playground.

## Step 7: Validate the Policy

In the config playground, the template YAML is loaded. Click **Validate**.

GitWire's validation API checks:
- YAML structure is correct
- All pillar names are recognized
- No risky settings (e.g., auto-patching without blocked file patterns)
- Dry-run status is reported

You'll see a structured report:

```json
{
  "valid": true,
  "dry_run": true,
  "warnings": [],
  "risky_settings": [],
  "enabled_pillars": ["triage", "ci_healing", "maintainer", "enforcement", "trust", "ai_review"]
}
```

::: tip What "valid" means
Valid YAML structure with no configuration errors. It does **not** mean the policy will behave exactly as you expect — that's what simulation (Step 8) is for.
:::

## Step 8: Simulate the Policy

Before applying anything, simulate the proposed policy against historical events.

Click **Simulate**. GitWire replays recent webhook events against your proposed config and shows what **would have happened**:

| Event | Current Policy | Proposed Policy |
|-------|---------------|-----------------|
| Issue #12 opened | Triaged, labeled `bug` | Triaged, labeled `bug` (dry-run: no label applied) |
| CI run failed | Patch PR opened | Diagnosis logged (dry-run: no PR opened) |
| PR #8 opened | AI review posted | AI review logged (dry-run: no comment posted) |

This confirms the proposed policy behaves as expected before any change.

## Step 9: Create a Rollout Plan

Now you're ready to create a governed rollout. This is GitWire's controlled change mechanism.

Click **Create Rollout**. This creates a plan with:
- **Proposed config:** the template you validated and simulated
- **Previous config:** the current effective config (likely defaults)
- **Validation result:** from Step 7
- **Simulation summary:** from Step 8
- **Diff impact:** what changes between current and proposed

The rollout enters `draft` state. Review the full evidence bundle:

1. Validation result ✓
2. Simulation summary ✓
3. Diff impact report ✓
4. Guardrail recommendations ✓

## Step 10: Approve and Promote

::: warning This is the only write path
Policy changes can **only** be applied through the rollout workflow. There is no direct config write API. This is by design — every change has evidence and an audit trail.
:::

**Review the evidence:**
- Does the validation pass?
- Does the simulation match your expectations?
- Are the diff changes what you intended?
- Are there any unmitigated risk recommendations?

**Approve:** Click **Approve**. If there are critical recommendations (e.g., "enable dry-run for risky settings"), you must acknowledge them before approval.

**Promote:** Click **Promote**. GitWire:
1. Writes the new config (write-before-transition)
2. Takes a snapshot of the previous config for rollback
3. Transitions the rollout to `promoted`
4. The new policy is now live

::: tip Did something go wrong?
Click **Rollback**. GitWire restores the previous config snapshot and records the rollback with evidence. The rollback is a governed action — it has its own audit trail with config hashes.
:::

---

## What Happens Next?

Your GitWire instance is now running with a safe dry-run policy. Here's what you'll see over the next few days:

1. **Issues get triaged** — AI classifies type and priority (logged, not applied)
2. **CI failures get diagnosed** — root-cause analysis appears in the dry-run proof view
3. **PRs get reviewed** — AI review findings are logged (not posted)
4. **Dashboard fills up** — activity feed, decision log, and dry-run proofs accumulate

### Moving to Live Mode

When you're confident the AI actions match your expectations:

1. Create a new rollout plan
2. Set `dry_run: false` in the proposed config
3. Optionally enable specific pillars (e.g., `auto_patch: true` for CI healing)
4. Validate → Simulate → Approve → Promote

That's it. You've completed the adoption threshold.

> **Can someone outside the project install GitWire and safely complete their first governed policy rollout?**
>
> **Yes.** ✓

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Setup checklist shows red for Database | Check `docker compose logs postgres`. Verify `DATABASE_URL` in `.env` |
| Setup checklist shows red for Redis | Check `docker compose logs redis`. Verify `REDIS_URL` in `.env` |
| No webhook events received | Verify Cloudflare Tunnel is running. Check webhook URL in GitHub App settings |
| Dashboard shows "not configured" | Ensure all GitHub App env vars are set in `.env` |
| Validation fails | Check YAML syntax — see [Config Reference](/configuration/gitwire-yml) |

## Further Reading

- [Full Walkthrough](/guides/full-walkthrough) — watch GitWire manage a repo end-to-end
- [Policy Preview & Simulation](/api/policy-preview) — API reference for validation and simulation
- [Policy Rollout Controls](/api/rollouts) — API reference for the rollout workflow
- [.gitwire.yml Reference](/configuration/gitwire-yml) — full configuration schema
- [Architecture Overview](/architecture/system-architecture) — how it all fits together
