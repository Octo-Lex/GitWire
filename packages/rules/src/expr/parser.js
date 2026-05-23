// @gitwire/rules — expr/parser.js
// Recursive-descent parser producing an AST from a token stream.
//
// Grammar (precedence low → high):
//   expression  → or_expr
//   or_expr     → and_expr ('or' and_expr)*
//   and_expr    → not_expr ('and' not_expr)*
//   not_expr    → 'not' not_expr | comparison
//   comparison  → additive (('>'|'>='|'<'|'<='|'=='|'!=') additive)?
//   additive    → multiplicative (('+' | '-') multiplicative)*
//   multiplicative → unary (('*' | '/') unary)*
//   unary       → ('-' | 'not') unary | pipe_expr
//   pipe_expr   → primary ('|' ident call_args?)*
//   primary     → BOOL | NUMBER | STRING | IDENT call_args? | '(' expression ')'
//   call_args   → '(' (expression (',' expression)*)? ')'
//
// AST node types:
//   { type: 'literal', value: ... }
//   { type: 'variable', name: '...' }
//   { type: 'call', name: '...', args: [...node] }
//   { type: 'pipe', input: node, func: '...', args: [...node] }
//   { type: 'unary', op: 'not'|'-', operand: node }
//   { type: 'binary', op: 'and'|'or'|'>'|'>='|'<'|'<='|'=='|'!='|'+'|'-'|'*'|'/', left: node, right: node }

import { TokenType } from "./lexer.js";

import { tokenize } from "./lexer.js";

export class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  advance() {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  expect(type) {
    const t = this.peek();
    if (t.type !== type) {
      throw new SyntaxError(
        `Expected ${type} but got ${t.type}(${JSON.stringify(t.value)}) at position ${t.pos}`
      );
    }
    return this.advance();
  }

  parse() {
    const node = this.orExpr();
    if (this.peek().type !== TokenType.EOF) {
      const t = this.peek();
      throw new SyntaxError(`Unexpected token ${t.type} at position ${t.pos}`);
    }
    return node;
  }

  orExpr() {
    let left = this.andExpr();
    while (this.peek().type === TokenType.OR) {
      this.advance();
      left = { type: "binary", op: "or", left, right: this.andExpr() };
    }
    return left;
  }

  andExpr() {
    let left = this.notExpr();
    while (this.peek().type === TokenType.AND) {
      this.advance();
      left = { type: "binary", op: "and", left, right: this.notExpr() };
    }
    return left;
  }

  notExpr() {
    if (this.peek().type === TokenType.NOT) {
      this.advance();
      return { type: "unary", op: "not", operand: this.notExpr() };
    }
    return this.comparison();
  }

  comparison() {
    const left = this.additive();
    const compOps = [TokenType.GT, TokenType.GE, TokenType.LT, TokenType.LE, TokenType.EQ, TokenType.NE];
    if (compOps.includes(this.peek().type)) {
      const op = this.advance().value;
      return { type: "binary", op, left, right: this.additive() };
    }
    return left;
  }

  additive() {
    let left = this.multiplicative();
    while (this.peek().type === TokenType.PLUS || this.peek().type === TokenType.MINUS) {
      const op = this.advance().value;
      left = { type: "binary", op, left, right: this.multiplicative() };
    }
    return left;
  }

  multiplicative() {
    let left = this.unary();
    while (this.peek().type === TokenType.STAR || this.peek().type === TokenType.SLASH) {
      const op = this.advance().value;
      left = { type: "binary", op, left, right: this.unary() };
    }
    return left;
  }

  unary() {
    if (this.peek().type === TokenType.MINUS) {
      this.advance();
      return { type: "unary", op: "-", operand: this.unary() };
    }
    return this.pipeExpr();
  }

  pipeExpr() {
    let node = this.primary();
    while (this.peek().type === TokenType.PIPE) {
      this.advance();
      const name = this.expect(TokenType.IDENT).value;
      let args = [];
      if (this.peek().type === TokenType.LPAREN) {
        args = this.callArgs();
      }
      node = { type: "pipe", input: node, func: name, args };
    }
    return node;
  }

  primary() {
    const t = this.peek();

    // Boolean or number literal
    if (t.type === TokenType.BOOL || t.type === TokenType.NUMBER) {
      this.advance();
      return { type: "literal", value: t.value };
    }

    // String literal
    if (t.type === TokenType.STRING) {
      this.advance();
      return { type: "literal", value: t.value };
    }

    // Identifier (possibly with call args)
    if (t.type === TokenType.IDENT) {
      this.advance();
      let args = [];
      if (this.peek().type === TokenType.LPAREN) {
        args = this.callArgs();
      }
      if (args.length > 0) {
        return { type: "call", name: t.value, args };
      }
      return { type: "variable", name: t.value };
    }

    // Parenthesized expression
    if (t.type === TokenType.LPAREN) {
      this.advance();
      const inner = this.orExpr();
      this.expect(TokenType.RPAREN);
      return inner;
    }

    throw new SyntaxError(`Unexpected token ${t.type}(${JSON.stringify(t.value)}) at position ${t.pos}`);
  }

  callArgs() {
    this.expect(TokenType.LPAREN);
    const args = [];
    if (this.peek().type !== TokenType.RPAREN) {
      args.push(this.orExpr());
      while (this.peek().type === TokenType.COMMA) {
        this.advance();
        args.push(this.orExpr());
      }
    }
    this.expect(TokenType.RPAREN);
    return args;
  }
}

export function parseExpression(input) {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parse();
}
