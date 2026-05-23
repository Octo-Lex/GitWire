# Custom Rules

Define custom automation rules in `.gitwire.yml` using GitWire's expression language. Rules evaluate conditions against PR/issue context and execute actions.

## Basic Structure

```yaml
custom_rules:
  rule_name:
    if: "<expression>"
    run:
      - action: <action-name>
        args: { <key>: <value> }
```

## Example: Auto-label bots

```yaml
custom_rules:
  label_bots:
    if: "author | match('*[bot]')"
    run:
      - action: add-label
        args: { label: "bot" }
```

## Example: Security review

```yaml
custom_rules:
  security_review:
    if: "files | some(match('src/auth/**'), match('**/secrets*'))"
    run:
      - action: add-label
        args: { label: "security-review" }
      - action: request-review
        args: { team: "security-team" }
```

## Example: Size-based labeling

```yaml
custom_rules:
  size_label:
    if: "changes.added + changes.deleted > 500"
    run:
      - action: add-label
        args: { label: "size/XL" }
```

## Available Actions

| Action | Args | Description |
|--------|------|-------------|
| `add-label` | `{ label: string }` | Add a label to the PR/issue |
| `remove-label` | `{ label: string }` | Remove a label |
| `add-comment` | `{ comment: string }` | Post a comment |
| `approve` | — | Approve the PR |
| `request-review` | `{ team: string }` or `{ user: string }` | Request a reviewer |
| `skip` | — | Skip further processing |
| `set-priority` | `{ priority: string }` | Set triage priority |

## Multiple Rules

Rules are evaluated in order. Multiple rules can match:

```yaml
custom_rules:
  label_bots:
    if: "author | match('*[bot]')"
    run:
      - action: add-label
        args: { label: "bot" }

  label_large:
    if: "changes.added + changes.deleted > 100"
    run:
      - action: add-label
        args: { label: "size/L" }

  label_docs:
    if: "files | all(extension('.md'))"
    run:
      - action: add-label
        args: { label: "documentation" }
```

## With Named Expressions

Combine with the `expressions` section for reusable conditions:

```yaml
expressions:
  is:
    safe: "files | all(extension('.css', '.md', '.txt'))"
    security: "files | some(match('src/auth/**'))"

custom_rules:
  approve_safe:
    if: "is.safe"
    run:
      - action: approve
      - action: add-label
        args: { label: "safe-change" }

  flag_security:
    if: "is.security"
    run:
      - action: add-label
        args: { label: "needs-security-review" }
```

## With Plugins

Custom filter functions from `.gitwire/plugins/` are available in expressions:

```yaml
custom_rules:
  frontend_review:
    if: "author | inTeam('frontend')"
    run:
      - action: add-label
        args: { label: "frontend" }
```

See: [Plugins](/configuration/plugins) | [Expression Language](/configuration/expression-language)
