# Heal History API

CI healing attempt history and statistics.

## Statistics

```
GET /api/heal/stats
```

```json
{
  "total": 42,
  "healed": 28,
  "failed": 8,
  "skipped": 6,
  "success_rate": 0.667
}
```

## List Heal History

```
GET /api/heal
```

All heal attempts. Supports pagination.

## Heal History by Repo

```
GET /api/heal/:owner/:repo
```

## Heal History by CI Run

```
GET /api/heal/run/:githubRunId
```

Heal attempts for a specific GitHub Actions run.

→ [Duplicates API](/api/duplicates)
