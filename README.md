# GitWire

> Self-hosted AI that manages your GitHub — triage, CI healing, stale management, autonomous fixes, and more.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/Elephant-Rock-Lab/GitWire.git
cd GitWire && npm install

# 2. Configure environment
cp packages/web/.env.example packages/web/.env
# Edit packages/web/.env with your GitHub App credentials and API keys

# 3. Start PostgreSQL + Redis
cd docker && docker compose up -d && cd ..

# 4. Run database migrations
npm run db:migrate

# 5. Start development server
npm run dev
```

## Monorepo Structure

```
GitWire/
├── packages/
│   ├── core/          # Shared constants, enums (zero deps)
│   ├── runtime/       # DB, Redis, logger, GitHub factories
│   ├── rules/         # Config schema, validation, risk scoring
│   ├── web/           # Express API + BullMQ workers
│   ├── web-dashboard/ # Next.js 16 dashboard UI
│   ├── worker/        # Generic worker loop (future extraction)
│   ├── triage/        # AI issue/PR classification (future extraction)
│   ├── healer/        # CI diagnosis + auto-patch (future extraction)
│   ├── quality-gate/  # Phase gates + diff-aware review (future)
│   ├── insights/      # Multi-repo analytics (future extraction)
│   ├── maintainer/    # Team access + branch rules (future)
│   ├── ai-skills/     # Prompt templates + LLM routing (future)
│   ├── mcp/           # MCP server for external tools (future)
│   └── cli/           # CLI entry point (future)
├── docs/              # VitePress documentation site
├── scripts/           # Migration, backup, restore scripts
└── security/          # Security audit reports
```

## Pillars

| Pillar | Description | Status |
|--------|-------------|--------|
| **Issue & PR Triage** | AI classification, auto-label, duplicate detection | ✅ Working |
| **Self-Healing CI** | Diagnose failures, generate patch PRs | ✅ Working |
| **Maintainer Tools** | Stale management, branch cleanup, settings API | ✅ Working |
| **Multi-Repo Insights** | Cross-repo sync, metrics, health scores | ✅ Working |
| **Autonomous Contributor** | AI-generated fix PRs with scope guards | ✅ Working |
| **Branch Enforcement** | Config validation, policy reconciliation | ✅ Working |
| **Merge Queue** | Automated merge management, error recovery | ✅ Working |
| **AI Review Gate** | PR code review, audit trail, compliance | ✅ Working |

## Policy-as-Code

Configure per-repo behavior with `.gitwire.yml`:

```yaml
pillars:
  triage:
    enabled: true
    auto_label: true
  ci_healing:
    enabled: true
    min_confidence_to_patch: medium
  issue_fix:
    enabled: false
settings:
  dry_run: false
```

See [`.gitwire.example.yml`](.gitwire.example.yml) for the full reference.

## Tech Stack

- **Runtime:** Node.js 20+ (ESM)
- **API:** Express + Helmet + CORS + Zod validation
- **Dashboard:** Next.js 16 + SWR + Recharts + TailwindCSS
- **Queue:** BullMQ + Redis 7
- **Database:** PostgreSQL 16 (39 tables)
- **AI:** Claude via Anthropic API
- **GitHub:** Octokit + GitHub App webhooks
- **Auth:** Bearer API key + HMAC webhook verification
- **Rate Limiting:** Redis sliding window (100 req/min)

## Documentation

Full docs at [docs/](docs/) (VitePress, 93 pages):

- [Installation Guide](docs/installation/docker-compose.md)
- [Policy-as-Code](docs/configuration/policy-as-code.md)
- [Risk Scoring](docs/configuration/risk-scoring.md)
- [REST API Reference](docs/api/rest-api-reference.md)
- [Architecture](docs/architecture/system-architecture.md)

## License

MIT
