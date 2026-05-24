<p align="center">
  <img src=".github/banner.png" alt="GitWire — Self-hosted AI governance for GitHub organizations" width="100%">
</p>

<div align="center">

# GitWire

**Self-hosted AI governance for GitHub organizations**

_Decide. Execute. Prove._

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-App-181717?logo=github)](https://github.com/apps/gitwire-hq)
[![Telegram](https://img.shields.io/badge/Telegram-@GitWire_HQ_bot-26A5E4?logo=telegram)](https://t.me/GitWire_HQ_bot)

</div>

---

<table width="100%">
<tr>
<td width="50%" valign="top">

### 🧠 Decide

**Expression language + custom rules**

Write policy-as-code rules that evaluate on every webhook event.

```yaml
rules:
  - name: auto-approve-docs
    when: pr.files.every(f =>
        f.path.endsWith('.md'))
    actions:
      - type: approve
```

```yaml
quality_gates:
  - name: default
    conditions:
      - metric: test_pass_rate
        operator: ">="
        threshold: 0.8
```

Define quality gates that block merges until conditions are met.

</td>
<td width="50%" valign="top">

### ⚡ Execute

**9 autonomous workers + Telegram bot**

Each pillar runs as an isolated BullMQ worker with idempotency guarantees.

| Worker | What it does |
|--------|-------------|
| Triage | AI classification, auto-label |
| CI Heal | Diagnose failures, patch PRs |
| Issue Fix | Generate fix PRs with scope guards |
| Maintainer | Stale cleanup, branch pruning |
| Merge Queue | Auto-merge with conflict resolution |
| Trust | Flaky test detection, dep scanning |
| AI Review | PR code review, audit trail |
| Sync | Multi-repo metrics, health scores |
| Reconciliation | Verify actions still in effect |

Control it all from Telegram:

```
/repos          → List watched repos
/gates o/r      → Quality gate status
/heal           → Trigger CI auto-fix
/actions        → Action lifecycle view
```

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 🔒 Prove

**Full evidence chain for every action**

Every GitWire mutation is tracked through an 8-state lifecycle:

```
proposed → approved → executing → succeeded → reconciled
                                → failed → retrying → (×3 backoff)
         → cancelled
```

<div align="center">

| Evidence | What it records |
|----------|----------------|
| **Who proposed** | AI triage (0.94 confidence), custom rule `auto-approve-docs`, quality gate |
| **Why approved** | Confidence policy check, dry-run bypass, scope guard |
| **What happened** | PR #99 created, label applied, review submitted |
| **Is it still there** | Reconciliation confirms label present, PR merged, approval intact |

</div>

All evidence queryable via REST API, dashboard, and Telegram.

</td>
</tr>
</table>

---

<table width="100%">
<tr>
<td width="33%" valign="top" align="center">

### 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/Elephant-Rock-Lab/GitWire.git
cd GitWire && npm install

# 2. Configure
cp packages/web/.env.example \
   packages/web/.env

# 3. Start infrastructure
cd docker && docker compose up -d
cd .. && npm run db:migrate

# 4. Launch
npm run dev
```

See [Installation Guide](docs/installation/docker-compose.md) for production setup with Cloudflare Tunnel.

</td>
<td width="33%" valign="top" align="center">

### 📊 Dashboard

24 pages of real-time visibility:

- **Landing** — health, activity, pillar stats
- **Actions** — lifecycle timeline with status badges
- **Quality Gates** — trends, metric sparklines
- **Custom Rules** — per-repo rules, decision matches
- **Deliveries** — webhook volume, event breakdown
- **Trust** — flaky tests, dependency alerts
- **Readiness** — per-repo health scores
- **Decisions** — AI reasoning audit trail

Auth via API key → Redis session → httpOnly cookie.

</td>
<td width="33%" valign="top" align="center">

### 🏗️ Architecture

```
GitHub Webhook
     ↓
  Express API (:3000)
     ↓
  BullMQ Workers (9)
     ↓
  PostgreSQL 16 (45 tables)
  Redis 7 (9 queues)
     ↓
  Next.js Dashboard (:3001)
  Telegram Bot (long poll)
```

**Monorepo packages:**

| Package | Role |
|---------|------|
| `core` | Constants, enums (zero deps) |
| `runtime` | DB, Redis, logger, GitHub factories |
| `rules` | Expression engine, plugins, quality gates |
| `web` | Express API + BullMQ workers |
| `web-dashboard` | Next.js 16 dashboard |
| `bot` | Grammy Telegram bot |

</td>
</tr>
</table>

---

<table width="100%">
<tr>
<td width="50%" valign="top">

### 🛡️ 9 Pillars

| Pillar | Description | Status |
|--------|-------------|:------:|
| **Issue & PR Triage** | AI classification, auto-label, duplicate detection | ✅ |
| **Self-Healing CI** | Diagnose failures, generate patch PRs | ✅ |
| **Maintainer Tools** | Stale management, branch cleanup, settings | ✅ |
| **Multi-Repo Insights** | Cross-repo sync, metrics, health scores | ✅ |
| **Autonomous Contributor** | AI fix PRs with scope guards | ✅ |
| **Branch Enforcement** | Config validation, policy reconciliation | ✅ |
| **Merge Queue** | Auto-merge, error recovery, feedback rules | ✅ |
| **AI Review Gate** | PR code review, audit trail, compliance | ✅ |
| **Trust & Safety** | Flaky tests, dependency scanning, waivers | ✅ |

</td>
<td width="50%" valign="top">

### 📚 Documentation

**114+ pages** in [docs/](docs/) (VitePress):

**Getting Started**
- [Docker Compose Setup](docs/installation/docker-compose.md)
- [GitHub App Setup](docs/installation/github-app-setup.md)
- [Environment Variables](docs/installation/environment-variables.md)
- [Cloudflare Tunnel](docs/installation/cloudflare-tunnel.md)

**Configuration**
- [Policy-as-Code](docs/configuration/policy-as-code.md)
- [Expression Language](docs/configuration/expression-language.md)
- [Custom Rules](docs/configuration/custom-rules.md)
- [Quality Gates](docs/configuration/quality-gates.md)
- [Trigger Control](docs/configuration/trigger-control.md)
- [Risk Scoring](docs/configuration/risk-scoring.md)

**Architecture**
- [System Overview](docs/architecture/overview.md)
- [Data Flow](docs/architecture/data-flow.md)
- [Expression Engine](docs/architecture/expression-engine.md)
- [Security Model](docs/architecture/security.md)

**API Reference**
- [REST API Overview](docs/api/overview.md)
- [Webhooks](docs/api/webhooks.md)
- [Quality Gates](docs/api/gates.md)

</td>
</tr>
</table>

---

<div align="center">

**Tech Stack:** Node.js 20 (ESM) · Express · Next.js 16 · PostgreSQL 16 · Redis 7 · BullMQ · Octokit · Grammy · Claude AI

**251 tests** · **45 tables** · **9 workers** · **24 dashboard pages** · **114+ doc pages**

</div>
