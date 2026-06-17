# Contributing to GitWire

Thank you for your interest in contributing to GitWire! This guide covers everything you need to get started.

## Quick Start

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR-USER/GitWire.git`
3. **Install** dependencies: `npm install`
4. **Create a branch**: `git checkout -b feature/my-feature`
5. **Make changes** and test
6. **Submit a pull request** against `master`

## Development Setup

See [DEVELOPMENT.md](./DEVELOPMENT.md) for local development instructions.

## Codebase Overview

| Directory | Purpose |
|-----------|---------|
| `packages/web/src/routes/` | API endpoint handlers (14 files, 102 endpoints) |
| `packages/web/src/services/` | Business logic modules (17 files) |
| `packages/web/src/workers/` | Background workers (9 files) |
| `packages/web/db/migrations/` | SQL migrations (11 files, 36 tables) |
| `packages/web-dashboard/src/` | Next.js dashboard (12 pages) |
| `packages/core/src/` | Shared constants and types |
| `docs/` | VitePress documentation site (83 pages) |

## Code Style

- **JavaScript** for backend (Node.js + Express)
- **TypeScript/TSX** for dashboard (Next.js)
- **2-space indentation**
- **ESM** — use `import`/`export`
- **Async/await** — no raw promises
- **JSDoc** for type hints in JS files
- **Parameterized SQL** — never concatenate

## Critical Rules

::: warning MUST follow
- **Never** use `octokit.rest.*` — use `octokit.request('METHOD /path')`
- **Never** use `.catch(() => {})` — always log errors
- **Never** reference `body` column on `issues` table (it doesn't exist)
- **Always** use `addParam()` for SQL parameters including LIMIT/OFFSET
- **Never** add `Co-Authored-By` to commits
:::

## Pull Request Process

1. **One PR per feature** — keep changes focused
2. **Add tests** — unit tests in `packages/web/tests/unit/`, see existing patterns
3. **Update docs** — if you add an endpoint or change behavior
4. **Pass CI** — all required checks must pass: `syntax-check`, `rules-tests`, `web-tests`
5. **Describe changes** — use the PR template
6. **Sign your commits** — DCO is enforced (use `git commit --signoff`)

### Commit Sign-Off (DCO)

All commits must include a `Signed-off-by` line:

```bash
git commit --signoff -m "your message"
```

This certifies that you have the right to submit the work under the project's MIT license.

## Reporting Issues

- **Bugs**: Open an issue with steps to reproduce, expected vs actual behavior
- **Features**: Open an issue describing the use case and proposed solution
- **Questions**: Open a discussion or ask in the issue

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
