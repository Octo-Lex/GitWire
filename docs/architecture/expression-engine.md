# Architecture: Expression Engine

The expression engine is the core of GitWire's custom rules system. It's a safe, sandboxed evaluator that processes declarative `if`/`run` rules defined in `.gitwire.yml`.

## Pipeline

```
Expression String
      │
      ▼
   ┌────────┐
   │ Lexer  │  Tokenize: "files | some(match('src/**'))" → [IDENT, PIPE, IDENT, LPAREN, ...]
   └────────┘
      │ Tokens
      ▼
   ┌────────┐
   │ Parser │  Recursive-descent → AST
   └────────┘
      │ AST
      ▼
   ┌───────────┐
   │ Evaluator │  Walk AST with context + builtins + plugins
   └───────────┘
      │
      ▼
   boolean result
```

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Lexer | `packages/rules/src/expr/lexer.js` | Tokenize expression strings |
| Parser | `packages/rules/src/expr/parser.js` | Build AST from token stream |
| Evaluator | `packages/rules/src/expr/evaluator.js` | Evaluate AST against context |
| Builtins | `packages/rules/src/expr/builtins.js` | 11 built-in filter functions |
| Plugins | `packages/rules/src/plugins/` | Plugin loader + sandbox |

## Grammar

```
expression  → or_expr
or_expr     → and_expr ('or' and_expr)*
and_expr    → not_expr ('and' not_expr)*
not_expr    → 'not' not_expr | comparison
comparison  → additive (comp_op additive)?
additive    → multiplicative (('+' | '-') multiplicative)*
multiplicative → unary (('*' | '/') unary)*
unary       → ('-' | 'not') unary | pipe_expr
pipe_expr   → primary ('|' ident call_args?)*
primary     → literal | variable | call | '(' expression ')'
```

## Security

- Expression evaluation is synchronous and bounded
- No access to filesystem, network, or process
- Plugin functions run in a sandboxed `Function` context with restricted globals
- Failed expressions are caught and logged — never crash the worker

## Performance

- Expression parsing and evaluation is sub-millisecond for typical rules
- Named expressions are pre-resolved before rule evaluation
- Plugins are loaded once per config fetch (cached 5 min)
- Custom rules are evaluated after pillar processing (no latency on the hot path)
