// @gitwire/rules — expr/evaluator.js
// Evaluates an AST produced by the parser against a context object.
//
// Usage:
//   const result = evaluate(ast, context);
//   const result = evaluate(ast, context, customFilters);
//   const { result, trace } = evaluateWithTrace(ast, context, customFilters);
//
// Context is a flat object with variables available in expressions:
//   { author: "alice", files: ["src/app.js"], labels: ["bug"], ... }
//
// Custom filters are merged over builtins:
//   { inTeam: (input, team) => ..., touchesPackage: (files) => ... }

import { BUILTINS } from "./builtins.js";

/**
 * Evaluate an AST node against a context.
 *
 * @param {object} node — AST node
 * @param {object} context — variable bindings
 * @param {object} [plugins] — additional filter functions
 * @returns {any} — the result value
 */
export function evaluate(node, context, plugins = {}) {
  const filters = { ...BUILTINS, ...plugins };

  switch (node.type) {
    case "literal":
      return node.value;

    case "variable":
      return resolveVariable(node.name, context);

    case "call":
      return callFunction(node.name, node.args, context, filters);

    case "pipe": {
      const input = evaluate(node.input, context, plugins);
      // Special handling for some() and all() — they need element-wise evaluation
      if (node.func === "some" || node.func === "all") {
        return evaluateArrayFilter(input, node.func, node.args, context, plugins);
      }
      const args = node.args.map((a) => evaluate(a, context, plugins));
      const fn = filters[node.func];
      if (!fn) {
        throw new Error(`Unknown filter function: ${node.func}`);
      }
      return fn(input, ...args);
    }

    case "unary":
      if (node.op === "not") return !evaluate(node.operand, context, plugins);
      if (node.op === "-") return -evaluate(node.operand, context, plugins);
      throw new Error(`Unknown unary operator: ${node.op}`);

    case "binary": {
      const left = evaluate(node.left, context, plugins);
      const right = evaluate(node.right, context, plugins);
      return applyBinaryOp(node.op, left, right);
    }

    default:
      throw new Error(`Unknown AST node type: ${node.type}`);
  }
}

/**
 * Evaluate with step-by-step trace output.
 */
export function evaluateWithTrace(node, context, plugins = {}) {
  const trace = [];
  const result = evaluateTraced(node, context, plugins, trace);
  return { result, trace };
}

function evaluateTraced(node, context, plugins, trace) {
  const filters = { ...BUILTINS, ...plugins };

  switch (node.type) {
    case "literal":
      return node.value;

    case "variable":
      return resolveVariable(node.name, context);

    case "call":
      return callFunction(node.name, node.args, context, filters);

    case "pipe": {
      const input = evaluateTraced(node.input, context, plugins, trace);
      if (node.func === "some" || node.func === "all") {
        const r = evaluateArrayFilterTraced(input, node.func, node.args, context, plugins, trace);
        return r;
      }
      const args = node.args.map((a) => evaluateTraced(a, context, plugins, trace));
      const fn = filters[node.func];
      if (!fn) throw new Error(`Unknown filter function: ${node.func}`);
      const result = fn(input, ...args);
      trace.push({ step: formatPipeStep(node, input, args), result });
      return result;
    }

    case "unary":
      if (node.op === "not") return !evaluateTraced(node.operand, context, plugins, trace);
      if (node.op === "-") return -evaluateTraced(node.operand, context, plugins, trace);
      throw new Error(`Unknown unary operator: ${node.op}`);

    case "binary": {
      const left = evaluateTraced(node.left, context, plugins, trace);
      const right = evaluateTraced(node.right, context, plugins, trace);
      const result = applyBinaryOp(node.op, left, right);
      trace.push({ step: `${formatValue(left)} ${node.op} ${formatValue(right)}`, result });
      return result;
    }

    default:
      throw new Error(`Unknown AST node type: ${node.type}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a dotted variable name from context.
 * "changes.added" → context.changes.added
 */
function resolveVariable(name, context) {
  const parts = name.split(".");
  let value = context;
  for (const part of parts) {
    if (value == null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Call a named function with evaluated arguments.
 */
function callFunction(name, argNodes, context, filters) {
  const args = argNodes.map((a) => {
    // For call nodes, we evaluate them
    if (a.type === "call") return callFunction(a.name, a.args, context, filters);
    if (a.type === "variable") return resolveVariable(a.name, context);
    if (a.type === "literal") return a.value;
    // For complex nodes, evaluate recursively
    return evaluateWithSimpleContext(a, context, filters);
  });
  const fn = filters[name];
  if (!fn) throw new Error(`Unknown function: ${name}`);
  return fn(...args);
}

function evaluateWithSimpleContext(node, context, filters) {
  // Simple recursive evaluate for nested expressions
  switch (node.type) {
    case "literal": return node.value;
    case "variable": return resolveVariable(node.name, context);
    case "binary": {
      const left = evaluateWithSimpleContext(node.left, context, filters);
      const right = evaluateWithSimpleContext(node.right, context, filters);
      return applyBinaryOp(node.op, left, right);
    }
    case "unary":
      if (node.op === "not") return !evaluateWithSimpleContext(node.operand, context, filters);
      if (node.op === "-") return -evaluateWithSimpleContext(node.operand, context, filters);
      return evaluateWithSimpleContext(node.operand, context, filters);
    default:
      return resolveVariable(JSON.stringify(node), context);
  }
}

/**
 * Evaluate `some()` or `all()` with element-wise filter application.
 * These are special because the inner expression is applied to each element.
 */
function evaluateArrayFilter(input, funcName, argNodes, context, plugins) {
  if (!Array.isArray(input)) {
    return funcName === "some" ? false : true;
  }

  // The argNodes should be pipe nodes or call nodes that we apply per-element
  const results = input.map((element) => {
    // Create a sub-context where the pipe input is the element
    // If there are argNodes, evaluate them as filters on the element
    if (argNodes.length === 0) return Boolean(element);

    // argNodes are filter expressions to apply to the element
    return argNodes.reduce((val, argNode) => {
      if (argNode.type === "call") {
        // It's a function call — evaluate its args, then call with element
        const fn = plugins[argNode.name] || BUILTINS[argNode.name];
        if (!fn) throw new Error(`Unknown filter function: ${argNode.name}`);
        const callArgs = argNode.args.map((a) => evaluate(a, context, plugins));
        return fn(val, ...callArgs);
      }
      if (argNode.type === "pipe") {
        // Nested pipe: evaluate inner, then apply outer
        const inner = evaluateArrayFilter([val], funcName, [argNode.input], context, plugins);
        if (argNode.func) {
          const fn = plugins[argNode.func] || BUILTINS[argNode.func];
          if (!fn) throw new Error(`Unknown filter function: ${argNode.func}`);
          const callArgs = argNode.args.map((a) => evaluate(a, context, plugins));
          return fn(inner === true ? val : inner, ...callArgs);
        }
        return inner;
      }
      // Literal or variable — just evaluate
      return evaluate(argNode, context, plugins);
    }, element);
  });

  if (funcName === "some") return results.some(Boolean);
  return results.every(Boolean);
}

/**
 * Traced version of evaluateArrayFilter.
 */
function evaluateArrayFilterTraced(input, funcName, argNodes, context, plugins, trace) {
  if (!Array.isArray(input)) {
    return funcName === "some" ? false : true;
  }

  let matchCount = 0;
  const results = input.map((element) => {
    let result;
    if (argNodes.length === 0) {
      result = Boolean(element);
    } else {
      result = argNodes.reduce((val, argNode) => {
        if (argNode.type === "call") {
          const fn = plugins[argNode.name] || BUILTINS[argNode.name];
          if (!fn) throw new Error(`Unknown filter function: ${argNode.name}`);
          const callArgs = argNode.args.map((a) => evaluate(a, context, plugins));
          return fn(val, ...callArgs);
        }
        return evaluate(argNode, context, plugins);
      }, element);
    }
    if (result) matchCount++;
    return result;
  });

  const finalResult = funcName === "some" ? results.some(Boolean) : results.every(Boolean);
  trace.push({
    step: `| ${funcName}(...) on ${input.length} elements`,
    result: finalResult,
    detail: `${matchCount}/${input.length} elements match`,
  });
  return finalResult;
}

/**
 * Apply a binary operator to two values.
 */
function applyBinaryOp(op, left, right) {
  switch (op) {
    case "and": return left && right;
    case "or":  return left || right;
    case ">":   return left > right;
    case ">=":  return left >= right;
    case "<":   return left < right;
    case "<=":  return left <= right;
    case "==":  return left == right;  // intentional loose equality
    case "!=":  return left != right;
    case "+":   return (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0);
    case "-":   return (typeof left === "number" ? left : 0) - (typeof right === "number" ? right : 0);
    case "*":   return left * right;
    case "/":   return right !== 0 ? left / right : 0;
    default:
      throw new Error(`Unknown binary operator: ${op}`);
  }
}

function formatPipeStep(node, input, args) {
  const inputStr = formatValue(input);
  const argsStr = args.map(formatValue).join(", ");
  return `${inputStr} | ${node.func}(${argsStr})`;
}

function formatValue(val) {
  if (typeof val === "string") return `'${val}'`;
  if (Array.isArray(val)) return `[${val.length} items]`;
  return String(val);
}
