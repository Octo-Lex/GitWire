# GitWire

> AI-powered GitHub account management platform.

## Quick Start

```bash
# 1. Install dependencies
npm install

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
│   ├── core/          # Shared types, constants, utilities
│   ├── web/           # Express API + workers + dashboard (current runtime)
│   ├── worker/        # Generic worker loop (future extraction)
│   ├── triage/        # AI issue/PR classification (future extraction)
│   ├── healer/        # CI diagnosis + auto-patch (future extraction)
│   ├── quality-gate/  # Phase gates + diff-aware review (future)
│   ├── rules/         # YAML/DSL policy definitions (future)
│   ├── insights/      # Multi-repo analytics (future extraction)
│   ├── maintainer/    # Team access + branch rules (future)
│   ├── ai-skills/     # Prompt templates + LLM routing (future)
│   ├── mcp/           # MCP server for external tools (future)
│   └── cli/           # CLI entry point (future)
├── config/            # Shared configuration
├── db/migrations/     # PostgreSQL schema migrations
├── docker/            # Docker Compose (PostgreSQL, Redis)
├── docs/              # Project documentation
└── scripts/           # Build and migration scripts
```

## Four Pillars

| Pillar | Package | Status |
|--------|---------|--------|
| **Maintainer Tools** | `@gitwire/maintainer` | Stub |
| **Issue & PR Triage** | `@gitwire/triage` (logic in `@gitwire/web`) | ✅ Working |
| **Self-Healing CI** | `@gitwire/healer` (logic in `@gitwire/web`) | ✅ Working |
| **Multi-Repo Insights** | `@gitwire/insights` (logic in `@gitwire/web`) | ✅ Working |

## Tech Stack

- **Runtime:** Node.js 20+
- **API:** Express + Helmet + CORS + Zod validation
- **Queue:** BullMQ + Redis
- **Database:** PostgreSQL
- **AI:** Claude (Anthropic API)
- **GitHub:** Octokit + GitHub App webhooks
- **Logging:** Pino
- **Auth:** Bearer API key + HMAC webhook verification
- **Rate Limiting:** Redis sliding window

## License

MIT
