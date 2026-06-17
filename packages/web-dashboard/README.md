# @gitwire/web-dashboard

GitWire Dashboard — monitoring UI for the [GitWire](https://github.com/Octo-Lex/GitWire) AI GitHub App platform.

## Stack

- **Next.js 16** — App Router, standalone output
- **SWR** — data fetching with caching and revalidation
- **Recharts** — charts for CI runs, triage breakdown, fix attempts
- **Tailwind CSS** — utility-first styling

## Pages

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | Overview — repo count, open issues, recent activity |
| Repos | `/repos` | All synced repositories with stats |
| Issues | `/issues` | Triage queue with AI classifications |
| Pull Requests | `/pull-requests` | PR status, AI review findings |
| CI Runs | `/ci` | CI failures and healing history |
| Duplicates | `/duplicates` | Duplicate issue detection results |
| Automation | `/automation` | Merge queue and error recovery |
| Trust | `/trust` | Flaky tests, dependency scanning, policy status |
| Maintainer | `/maintainer` | Stale issues/PRs, branch cleanup, settings |
| Intelligence | `/intelligence` | AI review findings and audit trail |
| Fix Attempts | `/fix-attempts` | Autonomous issue fix history |

## Development

```bash
# From monorepo root
npm install
npm run --workspace=@gitwire/web-dashboard dev

# Or from this directory
npm run dev
```

The dashboard runs on **port 3001** in development.

The API backend is expected at `http://localhost:3000`. Configure via `NEXT_PUBLIC_API_URL` in `.env.local`.

## Production

The dashboard builds as a Next.js standalone Docker image:

```bash
docker build -t gitwire-dashboard .
docker run -p 3001:3001 gitwire-dashboard
```

See the monorepo `docker-compose.yml` for the full deployment configuration.

## Testing

```bash
npm test
```

Tests cover the API client (`lib/api.ts`), URL builders, and React components (Sidebar, ErrorBoundary).
