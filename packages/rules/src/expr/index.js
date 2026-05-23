// @gitwire/rules — expr/index.js
// Expression language engine — tokenize → parse → evaluate.
//
// Usage:
//   import { evaluate, evaluateExpr, evaluateWithTrace } from "@gitwire/rules/expr";
//
//   const result = evaluateExpr("files | some(match('src/**'))", {
//     files: ["src/app.js", "README.md"]
//   });
//   // → true

export { tokenize, Token, TokenType } from "./lexer.js";
export { Parser, parseExpression } from "./parser.js";
export { evaluate, evaluateWithTrace } from "./evaluator.js";
export { BUILTINS } from "./builtins.js";

import { tokenize } from "./lexer.js";
import { Parser } from "./parser.js";
import { evaluate, evaluateWithTrace } from "./evaluator.js";

/**
 * Convenience: parse and evaluate an expression string in one call.
 *
 * @param {string} expr — expression string
 * @param {object} context — variable bindings
 * @param {object} [plugins] — custom filter functions
 * @returns {any} evaluation result
 */
export function evaluateExpr(expr, context, plugins) {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  return evaluate(ast, context, plugins);
}

/**
 * Convenience: parse and evaluate with trace output.
 */
export function evaluateExprWithTrace(expr, context, plugins) {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  return evaluateWithTrace(ast, context, plugins);
}
