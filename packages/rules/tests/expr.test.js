// @gitwire/rules — tests/expr.test.js
// Tests for the expression language engine.

import { tokenize, TokenType, evaluateExpr, evaluateExprWithTrace, BUILTINS } from "../src/expr/index.js";

// ── Lexer tests ──────────────────────────────────────────────────────────────

describe("tokenize", () => {
  test("empty input", () => {
    const tokens = tokenize("");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe(TokenType.EOF);
  });

  test("boolean literals", () => {
    const tokens = tokenize("true false");
    expect(tokens[0]).toMatchObject({ type: TokenType.BOOL, value: true });
    expect(tokens[1]).toMatchObject({ type: TokenType.BOOL, value: false });
  });

  test("number literals", () => {
    const tokens = tokenize("42 3.14");
    expect(tokens[0]).toMatchObject({ type: TokenType.NUMBER, value: 42 });
    expect(tokens[1]).toMatchObject({ type: TokenType.NUMBER, value: 3.14 });
  });

  test("string literals", () => {
    const tokens = tokenize("'hello' \"world\"");
    expect(tokens[0]).toMatchObject({ type: TokenType.STRING, value: "hello" });
    expect(tokens[1]).toMatchObject({ type: TokenType.STRING, value: "world" });
  });

  test("identifiers with dots", () => {
    const tokens = tokenize("changes.added");
    expect(tokens[0]).toMatchObject({ type: TokenType.IDENT, value: "changes.added" });
  });

  test("operators", () => {
    const tokens = tokenize("> >= < <= == != + - * / | ( ) ,");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.GT, TokenType.GE, TokenType.LT, TokenType.LE,
      TokenType.EQ, TokenType.NE, TokenType.PLUS, TokenType.MINUS,
      TokenType.STAR, TokenType.SLASH, TokenType.PIPE,
      TokenType.LPAREN, TokenType.RPAREN, TokenType.COMMA, TokenType.EOF,
    ]);
  });

  test("keywords", () => {
    const tokens = tokenize("and or not true false");
    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.AND, TokenType.OR, TokenType.NOT,
      TokenType.BOOL, TokenType.BOOL, TokenType.EOF,
    ]);
  });

  test("throws on unexpected character", () => {
    expect(() => tokenize("^")).toThrow("Unexpected character");
  });

  test("throws on unterminated string", () => {
    expect(() => tokenize("'hello")).toThrow("Unterminated string");
  });

  test("escape in string", () => {
    const tokens = tokenize("'it\\'s'");
    expect(tokens[0]).toMatchObject({ type: TokenType.STRING, value: "it's" });
  });
});

// ── Evaluator tests ──────────────────────────────────────────────────────────

describe("evaluateExpr", () => {
  test("boolean literal", () => {
    expect(evaluateExpr("true", {})).toBe(true);
    expect(evaluateExpr("false", {})).toBe(false);
  });

  test("number literal", () => {
    expect(evaluateExpr("42", {})).toBe(42);
    expect(evaluateExpr("3.14", {})).toBeCloseTo(3.14);
  });

  test("string literal", () => {
    expect(evaluateExpr("'hello'", {})).toBe("hello");
  });

  test("variable lookup", () => {
    expect(evaluateExpr("author", { author: "alice" })).toBe("alice");
  });

  test("dotted variable lookup", () => {
    expect(evaluateExpr("changes.added", { changes: { added: 42 } })).toBe(42);
  });

  test("undefined variable returns undefined", () => {
    expect(evaluateExpr("missing", {})).toBeUndefined();
  });

  test("logical and", () => {
    expect(evaluateExpr("true and true", {})).toBe(true);
    expect(evaluateExpr("true and false", {})).toBe(false);
    expect(evaluateExpr("false and true", {})).toBe(false);
  });

  test("logical or", () => {
    expect(evaluateExpr("true or false", {})).toBe(true);
    expect(evaluateExpr("false or false", {})).toBe(false);
  });

  test("logical not", () => {
    expect(evaluateExpr("not true", {})).toBe(false);
    expect(evaluateExpr("not false", {})).toBe(true);
  });

  test("comparison operators", () => {
    expect(evaluateExpr("5 > 3", {})).toBe(true);
    expect(evaluateExpr("3 > 5", {})).toBe(false);
    expect(evaluateExpr("5 >= 5", {})).toBe(true);
    expect(evaluateExpr("3 < 5", {})).toBe(true);
    expect(evaluateExpr("5 <= 5", {})).toBe(true);
    expect(evaluateExpr("5 == 5", {})).toBe(true);
    expect(evaluateExpr("5 != 3", {})).toBe(true);
  });

  test("arithmetic", () => {
    expect(evaluateExpr("3 + 4", {})).toBe(7);
    expect(evaluateExpr("10 - 3", {})).toBe(7);
    expect(evaluateExpr("3 * 4", {})).toBe(12);
    expect(evaluateExpr("10 / 2", {})).toBe(5);
    expect(evaluateExpr("-5", {})).toBe(-5);
  });

  test("parenthesized expression", () => {
    expect(evaluateExpr("(true or false) and true", {})).toBe(true);
    expect(evaluateExpr("(1 + 2) * 3", {})).toBe(9);
  });

  test("complex: changes.added + changes.deleted > 100", () => {
    const ctx = { changes: { added: 80, deleted: 30 } };
    expect(evaluateExpr("changes.added + changes.deleted > 100", ctx)).toBe(true);
    expect(evaluateExpr("changes.added + changes.deleted > 200", ctx)).toBe(false);
  });
});

// ── Pipe / filter tests ──────────────────────────────────────────────────────

describe("pipe expressions with builtins", () => {
  test("match — basic glob", () => {
    expect(evaluateExpr("author | match('*bot*')", { author: "dependabot[bot]" })).toBe(true);
    expect(evaluateExpr("author | match('*bot*')", { author: "alice" })).toBe(false);
  });

  test("match — glob with star", () => {
    expect(evaluateExpr("branch | match('feature/*')", { branch: "feature/new-api" })).toBe(true);
    expect(evaluateExpr("branch | match('feature/*')", { branch: "main" })).toBe(false);
  });

  test("match — multiple patterns", () => {
    expect(evaluateExpr("branch | match('main', 'develop')", { branch: "main" })).toBe(true);
    expect(evaluateExpr("branch | match('main', 'develop')", { branch: "develop" })).toBe(true);
    expect(evaluateExpr("branch | match('main', 'develop')", { branch: "feature/x" })).toBe(false);
  });

  test("contains", () => {
    expect(evaluateExpr("title | contains('fix')", { title: "fix: resolve crash" })).toBe(true);
    expect(evaluateExpr("title | contains('fix')", { title: "Add feature" })).toBe(false);
  });

  test("startsWith", () => {
    expect(evaluateExpr("branch | startsWith('feature/')", { branch: "feature/new-api" })).toBe(true);
    expect(evaluateExpr("branch | startsWith('feature/')", { branch: "bugfix/x" })).toBe(false);
  });

  test("endsWith", () => {
    expect(evaluateExpr("filename | endsWith('.test.js')", { filename: "app.test.js" })).toBe(true);
  });

  test("includes", () => {
    expect(evaluateExpr("labels | includes('bug')", { labels: ["bug", "enhancement"] })).toBe(true);
    expect(evaluateExpr("labels | includes('bug')", { labels: ["feature"] })).toBe(false);
  });

  test("length", () => {
    expect(evaluateExpr("files | length", { files: ["a.js", "b.js", "c.js"] })).toBe(3);
    expect(evaluateExpr("files | length > 5", { files: ["a", "b", "c", "d", "e", "f"] })).toBe(true);
  });

  test("lower and upper", () => {
    expect(evaluateExpr("author | lower", { author: "Alice" })).toBe("alice");
    expect(evaluateExpr("author | upper", { author: "Alice" })).toBe("ALICE");
  });

  test("extension", () => {
    expect(evaluateExpr("filename | extension('.js', '.ts')", { filename: "app.ts" })).toBe(true);
    expect(evaluateExpr("filename | extension('.js', '.ts')", { filename: "app.py" })).toBe(false);
  });

  test("some — at least one element matches", () => {
    const ctx = { files: ["src/app.js", "README.md", "src/util.js"] };
    expect(evaluateExpr("files | some(match('src/**'))", ctx)).toBe(true);
    expect(evaluateExpr("files | some(match('docs/**'))", ctx)).toBe(false);
  });

  test("all — every element matches", () => {
    const ctx = { files: ["a.css", "b.css", "c.css"] };
    expect(evaluateExpr("files | all(extension('.css'))", ctx)).toBe(true);
    const ctx2 = { files: ["a.css", "b.js"] };
    expect(evaluateExpr("files | all(extension('.css'))", ctx2)).toBe(false);
  });
});

// ── Complex expression tests ─────────────────────────────────────────────────

describe("complex expressions", () => {
  test("combined: some(match) and not match", () => {
    const ctx = {
      files: ["src/auth/login.js", "README.md"],
      author: "alice",
    };
    expect(evaluateExpr("files | some(match('src/auth/**')) and not author | match('*[bot]')", ctx)).toBe(true);
  });

  test("bot filter", () => {
    expect(evaluateExpr("author | match('*[bot]')", { author: "dependabot[bot]" })).toBe(true);
    expect(evaluateExpr("author | match('*[bot]')", { author: "alice" })).toBe(false);
  });

  test("size-based logic", () => {
    const ctx = { changes: { added: 300, deleted: 250 } };
    expect(evaluateExpr("changes.added + changes.deleted > 500", ctx)).toBe(true);
    expect(evaluateExpr("changes.added + changes.deleted > 600", ctx)).toBe(false);
  });
});

// ── Custom plugins ───────────────────────────────────────────────────────────

describe("custom plugin functions", () => {
  test("custom filter function", () => {
    const plugins = {
      inTeam: (author, team) => {
        const teams = { frontend: ["alice", "bob"], backend: ["charlie"] };
        return (teams[team] || []).includes(author);
      },
    };
    expect(evaluateExpr("author | inTeam('frontend')", { author: "alice" }, plugins)).toBe(true);
    expect(evaluateExpr("author | inTeam('frontend')", { author: "charlie" }, plugins)).toBe(false);
  });
});

// ── Trace output ─────────────────────────────────────────────────────────────

describe("evaluateExprWithTrace", () => {
  test("produces trace entries", () => {
    const { result, trace } = evaluateExprWithTrace(
      "files | length > 2",
      { files: ["a.js", "b.js", "c.js"] }
    );
    expect(result).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
  });

  test("trace shows pipe steps", () => {
    const { trace } = evaluateExprWithTrace(
      "author | match('*bot*')",
      { author: "dependabot[bot]" }
    );
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0].result).toBe(true);
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  test("unknown filter throws", () => {
    expect(() => evaluateExpr("x | nonexistent()", { x: 1 })).toThrow("Unknown filter function");
  });

  test("syntax error in expression", () => {
    expect(() => evaluateExpr(">>>", {})).toThrow();
  });
});
