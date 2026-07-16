#!/usr/bin/env node
// scripts/read-strict-env.mjs
//
// Strict dotenv reader for production environment files.
//
// production.env is a dotenv file, NOT trusted shell code. This module parses
// it without sourcing or evaluating it. It accepts only exact `KEY=value`
// lines and rejects anything that would make shell evaluation ambiguous
// (quoting, multiline, export prefixes, source-ing, command substitution).
//
// Two modes:
//
//   1. Full validation (no --get):
//        node read-strict-env.mjs <file> <requiredKey1> [requiredKey2 ...]
//      Validates syntax + that every required key is present and non-empty.
//      Prints only a success line to stdout (never the full configuration).
//      Exit 0 on success, 1 on any failure (errors to stderr).
//
//   2. Non-evaluating single-value lookup (--get):
//        node read-strict-env.mjs --get <KEY> <file>
//      Writes ONLY the requested value to stdout. Validation errors to stderr.
//      Exit 0 on success, 1 if the file is malformed or the key is
//      absent/empty. Used by deploy-release.sh via read_prod_env() so the
//      shell never sources production.env and never receives secret values
//      as command-line arguments.
//
// What this rejects:
//   - Lines that do not match ^[A-Z][A-Z0-9_]*=.+
//   - Duplicate keys
//   - Values containing shell metacharacters that would change meaning under
//     evaluation: backticks, $, or unmatched/escaped quotes. (Compose's own
//     dotenv parser is stricter than bash `source`; we mirror Compose's
//     consumption, not bash's.)

import fs from "node:fs";

// A value may contain anything except characters that make shell evaluation
// ambiguous. We permit spaces, colons, slashes, @, etc. (digest references,
// connection strings) but reject backticks, $, and quote characters.
//
// Rationale: Compose consumes this file via --env-file using its OWN parser,
// not bash. But deploy-release.sh reads individual values out via --get and
// assigns them to shell variables. A value containing $ or ` would be
// re-evaluated under `$(...)` assignment if the script ever slipped into
// unsafe quoting. Rejecting them here is defense-in-depth.
const VALUE_FORBIDDEN = /[`$"\\]/;

function fail(msg) {
  process.stderr.write(`::error::read-strict-env: ${msg}\n`);
  process.exit(1);
}

/**
 * Parse a dotenv file strictly.
 * @param {string} file - path to the dotenv file
 * @returns {Map<string, string>} ordered map of KEY -> value
 * @throws {Error} on any malformed line or duplicate key
 */
function parseStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }

  const values = new Map();
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and comments.
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Reject `export KEY=...` and other leading-token forms.
    if (/^export\s+/.test(trimmed)) {
      throw new Error(`${file}:${i + 1}: 'export' prefix is not supported`);
    }

    // Must match KEY=value exactly.
    const match = /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(trimmed);
    if (!match) {
      throw new Error(
        `${file}:${i + 1}: invalid line (expected KEY=value): ${JSON.stringify(trimmed)}`,
      );
    }

    const [, key, value] = match;

    if (values.has(key)) {
      throw new Error(`${file}:${i + 1}: duplicate key '${key}'`);
    }
    if (VALUE_FORBIDDEN.test(value)) {
      throw new Error(
        file + ":" + (i + 1) + ": value for '" + key +
          "' contains a forbidden shell metacharacter (dollar, backtick, backslash, or double-quote)",
      );
    }

    values.set(key, value);
  }

  return values;
}

function main() {
  const argv = process.argv.slice(2);

  // Mode 2: --get KEY <file>
  if (argv[0] === "--get") {
    const [, key, file] = argv;
    if (!key || !file) {
      fail("usage: read-strict-env.mjs --get <KEY> <file>");
    }
    let values;
    try {
      values = parseStrict(file);
    } catch (err) {
      fail(err.message);
    }
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      fail(`key '${key}' is absent or empty in ${file}`);
    }
    // Write ONLY the value to stdout. No newline-trimming — the value is
    // captured via $(...) which strips trailing newlines.
    process.stdout.write(value + "\n");
    return;
  }

  // Mode 1: full validation — <file> <requiredKey1> [requiredKey2 ...]
  const [file, ...requiredKeys] = argv;
  if (!file) {
    fail("usage: read-strict-env.mjs <file> [requiredKey1 ...]");
  }

  let values;
  try {
    values = parseStrict(file);
  } catch (err) {
    fail(err.message);
  }

  for (const key of requiredKeys) {
    const v = values.get(key);
    if (v === undefined || v.length === 0) {
      fail(`required key '${key}' is absent or empty in ${file}`);
    }
  }

  const keys = [...values.keys()];
  console.log(
    `✓ ${file}: ${keys.length} key(s) parsed, ${requiredKeys.length} required key(s) present`,
  );
}

main();
