// @gitwire/rules — expr/lexer.js
// Tokenizes expression strings into a stream of tokens.
//
// Token types:
//   BOOL      — true | false
//   NUMBER    — integer or decimal
//   STRING    — 'single' or "double" quoted
//   IDENT     — variable/function names (a-z, A-Z, 0-9, _, .)
//   PIPE      — |
//   LPAREN    — (
//   RPAREN    — )
//   COMMA     — ,
//   AND       — and
//   OR        — or
//   NOT       — not
//   GT        — >
//   GE        — >=
//   LT        — <
//   LE        — <=
//   EQ        — ==
//   NE        — !=
//   PLUS      — +
//   MINUS     — -
//   STAR      — *
//   SLASH     — /
//   EOF       — end of input

export const TokenType = {
  BOOL:   "BOOL",
  NUMBER: "NUMBER",
  STRING: "STRING",
  IDENT:  "IDENT",
  PIPE:   "PIPE",
  LPAREN: "LPAREN",
  RPAREN: "RPAREN",
  COMMA:  "COMMA",
  AND:    "AND",
  OR:     "OR",
  NOT:    "NOT",
  GT:     "GT",
  GE:     "GE",
  LT:     "LT",
  LE:     "LE",
  EQ:     "EQ",
  NE:     "NE",
  PLUS:   "PLUS",
  MINUS:  "MINUS",
  STAR:   "STAR",
  SLASH:  "SLASH",
  EOF:    "EOF",
};

const KEYWORDS = {
  true:  TokenType.BOOL,
  false: TokenType.BOOL,
  and:   TokenType.AND,
  or:    TokenType.OR,
  not:   TokenType.NOT,
};

export class Token {
  constructor(type, value, pos) {
    this.type = type;
    this.value = value;
    this.pos = pos;
  }
  toString() {
    return `${this.type}(${JSON.stringify(this.value)})`;
  }
}

/**
 * Tokenize an expression string.
 * Returns an array of Token objects (always ends with EOF).
 */
export function tokenize(input) {
  const tokens = [];
  let pos = 0;

  while (pos < input.length) {
    // Skip whitespace
    if (/\s/.test(input[pos])) {
      pos++;
      continue;
    }

    const start = pos;

    // Two-character operators
    const two = input.slice(pos, pos + 2);
    if (two === ">=") { tokens.push(new Token(TokenType.GE, ">=", start)); pos += 2; continue; }
    if (two === "<=") { tokens.push(new Token(TokenType.LE, "<=", start)); pos += 2; continue; }
    if (two === "==") { tokens.push(new Token(TokenType.EQ, "==", start)); pos += 2; continue; }
    if (two === "!=") { tokens.push(new Token(TokenType.NE, "!=", start)); pos += 2; continue; }

    // Single-character operators / punctuation
    const ch = input[pos];
    if (ch === "|") { tokens.push(new Token(TokenType.PIPE, "|", start)); pos++; continue; }
    if (ch === "(") { tokens.push(new Token(TokenType.LPAREN, "(", start)); pos++; continue; }
    if (ch === ")") { tokens.push(new Token(TokenType.RPAREN, ")", start)); pos++; continue; }
    if (ch === ",") { tokens.push(new Token(TokenType.COMMA, ",", start)); pos++; continue; }
    if (ch === ">") { tokens.push(new Token(TokenType.GT, ">", start)); pos++; continue; }
    if (ch === "<") { tokens.push(new Token(TokenType.LT, "<", start)); pos++; continue; }
    if (ch === "+") { tokens.push(new Token(TokenType.PLUS, "+", start)); pos++; continue; }
    if (ch === "-") { tokens.push(new Token(TokenType.MINUS, "-", start)); pos++; continue; }
    if (ch === "*") { tokens.push(new Token(TokenType.STAR, "*", start)); pos++; continue; }
    if (ch === "/") { tokens.push(new Token(TokenType.SLASH, "/", start)); pos++; continue; }

    // String literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      pos++;
      let value = "";
      while (pos < input.length && input[pos] !== quote) {
        if (input[pos] === "\\" && pos + 1 < input.length) {
          pos++;
          value += input[pos];
        } else {
          value += input[pos];
        }
        pos++;
      }
      if (pos >= input.length) {
        throw new SyntaxError(`Unterminated string at position ${start}`);
      }
      pos++; // skip closing quote
      tokens.push(new Token(TokenType.STRING, value, start));
      continue;
    }

    // Number literal
    if (/\d/.test(ch)) {
      let num = "";
      while (pos < input.length && /[\d.]/.test(input[pos])) {
        num += input[pos];
        pos++;
      }
      tokens.push(new Token(TokenType.NUMBER, parseFloat(num), start));
      continue;
    }

    // Identifier (or keyword)
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = "";
      while (pos < input.length && /[a-zA-Z0-9_.]/.test(input[pos])) {
        ident += input[pos];
        pos++;
      }
      // Check if it's a keyword
      const kwType = KEYWORDS[ident];
      if (kwType) {
        const val = ident === "true" ? true : ident === "false" ? false : ident;
        tokens.push(new Token(kwType, val, start));
      } else {
        tokens.push(new Token(TokenType.IDENT, ident, start));
      }
      continue;
    }

    throw new SyntaxError(`Unexpected character '${ch}' at position ${pos}`);
  }

  tokens.push(new Token(TokenType.EOF, null, pos));
  return tokens;
}
