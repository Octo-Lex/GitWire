// @gitwire/rules — expr/builtins.js
// Built-in filter functions available in expressions.
//
// Each function receives (input, ...args) where input is the
// piped value and args are the call arguments.
//
// Convention:
//   - String filters return string or boolean
//   - Array filters return boolean (some/all) or number (length)
//   - All functions are pure — no side effects

import { matchGlob } from "../helpers.js";

/**
 * Check if a string matches a glob pattern.
 *   author | match('*[bot]')  →  boolean
 */
export function filter_match(input, ...patterns) {
  const str = String(input);
  return patterns.some((p) => matchGlob(str, p));
}

/**
 * Check if a string/file has one of the given extensions.
 *   files | all(extension('.js', '.ts'))
 */
export function filter_extension(input, ...exts) {
  const str = String(input);
  return exts.some((e) => str.endsWith(e));
}

/**
 * Check if an array includes a value.
 *   labels | includes('bug')
 */
export function filter_includes(arr, value) {
  if (!Array.isArray(arr)) return false;
  return arr.includes(value);
}

/**
 * Array filter: true if at least one element satisfies the sub-filter.
 * The sub-filter is represented as a callback wrapper.
 *   files | some(match('src/**'))
 *
 * Note: In practice, `some` receives the pipe result of applying
 * the inner filter to each element. The evaluator handles this specially.
 */
export function filter_some(arr) {
  if (!Array.isArray(arr)) return false;
  return arr.some(Boolean);
}

/**
 * Array filter: true if all elements satisfy the sub-filter.
 *   files | all(extension('.md'))
 */
export function filter_all(arr) {
  if (!Array.isArray(arr)) return false;
  return arr.every(Boolean);
}

/**
 * Get the length of an array or string.
 *   files | length
 */
export function filter_length(input) {
  if (Array.isArray(input)) return input.length;
  if (typeof input === "string") return input.length;
  return 0;
}

/**
 * Check if a string contains a substring.
 *   title | contains('fix')
 */
export function filter_contains(input, substring) {
  return String(input).includes(substring);
}

/**
 * Check if a string starts with a prefix.
 *   branch | startsWith('feature/')
 */
export function filter_startsWith(input, prefix) {
  return String(input).startsWith(prefix);
}

/**
 * Check if a string ends with a suffix.
 *   filename | endsWith('.test.js')
 */
export function filter_endsWith(input, suffix) {
  return String(input).endsWith(suffix);
}

/**
 * Convert to lowercase.
 *   author | lower
 */
export function filter_lower(input) {
  return String(input).toLowerCase();
}

/**
 * Convert to uppercase.
 *   title | upper
 */
export function filter_upper(input) {
  return String(input).toUpperCase();
}

/**
 * Map of all built-in filter functions.
 * Key = function name used in expressions.
 */
export const BUILTINS = {
  match: filter_match,
  extension: filter_extension,
  includes: filter_includes,
  some: filter_some,
  all: filter_all,
  length: filter_length,
  contains: filter_contains,
  startsWith: filter_startsWith,
  endsWith: filter_endsWith,
  lower: filter_lower,
  upper: filter_upper,
};
