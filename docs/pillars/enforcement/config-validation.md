# Config Validation

Push-triggered validation of repository configuration files.

## How It Works

When a `push` event is received:

1. GitWire checks the changed files for known config file patterns
2. Fetches the file content from GitHub
3. Validates against known schema rules
4. Records results in `config_validation_results`

## Supported Config Files

| File | Validation |
|------|-----------|
| `.github/workflows/*.yml` | YAML syntax, basic GitHub Actions schema |
| `.github/CODEOWNERS` | Valid CODEOWNERS syntax |
| `.github/ISSUE_TEMPLATE/*.yml` | YAML syntax |
| `.github/PULL_REQUEST_TEMPLATE.md` | Markdown syntax |
| `package.json` | JSON syntax, required fields |
| `tsconfig.json` | JSON syntax, TypeScript schema |

## Viewing Results

```bash
# All config validation results
curl https://gitwire.yourdomain.com/api/enforcement/config-results \
  -H "Authorization: Bearer YOUR_API_KEY"

# For a specific repo
curl https://gitwire.yourdomain.com/api/enforcement/config-results/owner/repo \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Result Record

| Field | Description |
|-------|-------------|
| `commit_sha` | The commit that triggered validation |
| `file_path` | Path to the config file |
| `file_type` | Type of config file |
| `valid` | Whether validation passed |
| `errors` | JSONB array of error objects |
| `warnings` | JSONB array of warning objects |

→ [Merge Queue](/pillars/merge-queue/merge-queue)
