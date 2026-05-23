# Plugins

Extend GitWire's expression language with custom JavaScript filter functions. Place `.js` files in `.gitwire/plugins/` in your repository.

## How It Works

1. GitWire fetches all `.js` files from `.gitwire/plugins/` in your repo
2. Each file is loaded in a sandboxed context (no `require`, `fs`, `process`, `fetch`)
3. Exported functions become filter functions available in expressions
4. Plugins are cached alongside config (5-minute TTL)

## Example Plugin

**File:** `.gitwire/plugins/team-filters.js`

```javascript
// Custom filter: check if author belongs to a team
module.exports.inTeam = function(author, teamName) {
  var teams = {
    frontend: ["alice", "bob", "charlie"],
    backend: ["dave", "eve", "frank"],
    security: ["grace", "heidi"],
  };
  return (teams[teamName] || []).indexOf(author) !== -1;
};

// Custom filter: check if any file is a package manifest
module.exports.touchesPackage = function(files) {
  return files.some(function(f) {
    return f === "package.json" || f === "requirements.txt";
  });
};
```

**Usage in rules:**

```yaml
custom_rules:
  frontend_review:
    if: "author | inTeam('frontend')"
    run:
      - action: add-label
        args: { label: "frontend" }

  package_change_alert:
    if: "files | touchesPackage()"
    run:
      - action: add-label
        args: { label: "package-change" }
```

## Sandbox Restrictions

Plugins run in a restricted JavaScript context. The following are **not available**:

- `require()` — no module loading
- `process` — no environment access
- `fs` — no filesystem access
- `fetch`, `XMLHttpRequest` — no network requests
- `setTimeout`, `setInterval` — no timers
- `Buffer`, `URL` — no Node.js built-ins

Available globals: `JSON`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Date`, `RegExp`, `Map`, `Set`, `parseInt`, `parseFloat`, `console` (silenced).

## Rules

1. **Export functions only** — objects, strings, and numbers are ignored
2. **Functions must be pure** — no side effects, no external calls
3. **Functions must be synchronous** — no async/await or Promises
4. **Functions must complete quickly** — complex computation should be avoided
5. **Use `module.exports`** — ESM `export` syntax is not supported in plugins

## File Structure

```
your-repo/
├── .gitwire/
│   ├── .gitwire.yml         # Config file
│   └── plugins/
│       ├── team-filters.js  # Team-based filters
│       └── size-filters.js  # Size-based filters
└── ...
```

## Error Handling

- If a plugin file has a syntax error, it's skipped (other plugins still load)
- If a plugin function throws at runtime, the rule that used it is skipped
- Plugin errors are logged but don't block the worker pipeline

## Security Model

Plugins are intentionally limited. If you need complex logic (API calls, database queries), implement it as a worker in the GitWire backend, not as a plugin.

See: [Custom Rules](/configuration/custom-rules) | [Expression Language](/configuration/expression-language)
