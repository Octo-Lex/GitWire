# Config Playground

The config playground lets you test expression rules in the browser before committing them to `.gitwire.yml`.

## Access

Navigate to **Playground** in the sidebar, or go to `/config/playground`.

## How to Use

1. **Write an expression** in the top-left editor
2. **Provide a context** (JSON object simulating a PR/issue event)
3. **Click Evaluate** to see the result

## Expression Library

Click any expression from the library bar to insert it into the editor:

- Author is bot
- Has label 'bug'
- Touches src/
- All docs
- Large PR
- Feature branch
- And more...

## Example Context

```json
{
  "author": "alice",
  "branch": "feature/new-api",
  "files": ["src/app.js", "src/utils.js", "README.md"],
  "labels": ["enhancement"],
  "title": "Add new API endpoint",
  "changes": { "added": 45, "deleted": 12, "modified": 3 },
  "repo": "acme/app",
  "is_new": true,
  "is_draft": false
}
```

## Evaluation Trace

The playground shows a step-by-step trace of how the expression was evaluated:

```
✓ ['src/app.js', 'README.md'] | some(match('src/**'))
  → 1/2 elements match
  → true
```

This helps you understand which filters matched and debug complex expressions.

## API

You can also call the playground programmatically:

```
POST /api/config/playground
```

**Body:**

```json
{
  "expression": "files | some(match('src/**'))",
  "context": {
    "files": ["src/app.js", "README.md"],
    "author": "alice"
  },
  "expressions": {
    "is": {
      "docs": "files | all(extension('.md'))"
    }
  }
}
```

**Response:**

```json
{
  "result": true,
  "trace": [
    { "step": "| some(...) on 2 elements", "result": true, "detail": "1/2 elements match" }
  ],
  "evaluated_at": "2026-05-23T20:00:00.000Z"
}
```
