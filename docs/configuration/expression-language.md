# Expression Language

GitWire's expression language lets you write declarative rules in `.gitwire.yml` using a safe, sandboxed DSL. Inspired by gitStream's CM syntax but extended with pipe-style filters.

## Syntax Overview

```yaml
custom_rules:
  approve_safe:
    if: "files | all(extension('.css', '.md'))"
    run:
      - action: add-label
        args: { label: "safe-change" }
```

### Operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `and` | Logical AND | `is.docs and is.small` |
| `or` | Logical OR | `is.formatting or is.tests` |
| `not` | Logical NOT | `not is.draft` |
| `>`, `>=` | Greater than | `changes.added > 50` |
| `<`, `<=` | Less than | `files \| length < 5` |
| `==`, `!=` | Equality | `author == 'alice'` |
| `+`, `-`, `*`, `/` | Arithmetic | `changes.added + changes.deleted > 100` |

### Pipe Syntax

The pipe operator (`|`) chains filter functions:

```
input | filter(arg1, arg2)
```

Multiple pipes chain left-to-right:
```
author | lower | contains('bot')
```

### Built-in Filters

| Filter | Input | Returns | Example |
|--------|-------|---------|---------|
| `match(pattern...)` | string | boolean | `author \| match('*[bot]')` |
| `contains(substring)` | string | boolean | `title \| contains('fix')` |
| `startsWith(prefix)` | string | boolean | `branch \| startsWith('feature/')` |
| `endsWith(suffix)` | string | boolean | `file \| endsWith('.test.js')` |
| `includes(value)` | array | boolean | `labels \| includes('bug')` |
| `some(filter)` | array | boolean | `files \| some(match('src/**'))` |
| `all(filter)` | array | boolean | `files \| all(extension('.md'))` |
| `length` | array/string | number | `files \| length > 10` |
| `extension(ext...)` | string | boolean | `file \| extension('.js', '.ts')` |
| `lower` | string | string | `author \| lower` |
| `upper` | string | string | `title \| upper` |

### Context Variables

Available in every rule evaluation:

| Variable | Type | Description |
|----------|------|-------------|
| `author` | string | PR/issue author login |
| `branch` | string | Branch name (PRs only) |
| `title` | string | PR title or issue title |
| `body` | string | PR body or issue body |
| `labels` | string[] | Current labels |
| `files` | string[] | Changed file paths (PRs only) |
| `changes` | {added, deleted, modified} | Line change counts |
| `repo` | string | Repository full name |
| `is_new` | boolean | True for newly opened items |
| `is_draft` | boolean | True for draft PRs |

### Named Expressions

Define reusable expressions in the `expressions` section:

```yaml
expressions:
  is:
    docs: "files | all(extension('.md', '.rst'))"
    formatting: "files | all(extension('.css', '.scss', '.less'))"
    tests: "files | all(match('**/*.test.*'))"
    safe: "is.docs or is.formatting or is.tests"
    security: "files | some(match('src/auth/**'), match('**/secrets*'))"

custom_rules:
  approve_safe:
    if: "is.safe"
    run:
      - action: approve
```
