// scripts/parse-source-truth.mjs
//
// Positional parser for the gitwire:source-of-truth marker contract.
// Pure function: text in, structured violations out. No filesystem access.
//
// The marker is an HTML-token-delimited block containing exactly one ```json
// fence. The JSON must conform to SourceTruthContract (schemaVersion 1).
//
// Usage:
//   import { parseSourceTruthMarker } from "./parse-source-truth.mjs";
//   const { data, violations } = parseSourceTruthMarker(text, { document: "AGENTS.md" });
//
// Violation shape: { code, document, field, message }
//
// Token classification is deterministic (see PRECEDENCE below). One malformed
// input produces exactly one root-cause violation; downstream identity
// comparison is the caller's responsibility and must be skipped when this
// function returns data === null.

export const MARKER_BEGIN = "<!-- gitwire:source-of-truth:begin -->";
export const MARKER_END = "<!-- gitwire:source-of-truth:end -->";

// Line-oriented fence recognition. Optional leading/trailing whitespace only.
// Matches ```json (opening) or ``` (closing). Backticks inside JSON strings
// or prose are not line-structural and will not match.
const JSON_FENCE_OPEN_RE = /^[ \t]*```json[ \t]*$/;
const JSON_FENCE_CLOSE_RE = /^[ \t]*```[ \t]*$/;

export const SCHEMA_VERSION_CURRENT = 1;

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MIGRATION_ID_RE = /^\d{3}$/;

/**
 * Positional scan for begin/end tokens. Returns an ordered list of token
 * positions so the caller can classify structural defects deterministically.
 *
 * @param {string} text
 * @returns {{kind: "begin"|"end", index: number}[]}
 */
function scanTokens(text) {
  const tokens = [];
  let from = 0;
  while (from <= text.length) {
    const beginAt = text.indexOf(MARKER_BEGIN, from);
    const endAt = text.indexOf(MARKER_END, from);
    if (beginAt === -1 && endAt === -1) break;
    if (beginAt !== -1 && (endAt === -1 || beginAt < endAt)) {
      tokens.push({ kind: "begin", index: beginAt });
      from = beginAt + MARKER_BEGIN.length;
    } else {
      tokens.push({ kind: "end", index: endAt });
      from = endAt + MARKER_END.length;
    }
  }
  return tokens;
}

/**
 * Validate the ordered token stream. PRECEDENCE (deterministic):
 *
 *   no begin or end tokens            → MARKER_MISSING
 *   end token without an open begin   → MARKER_MALFORMED
 *   begin without a closing end       → MARKER_MALFORMED
 *   nested begin                      → MARKER_MALFORMED
 *   two complete blocks               → MARKER_DUPLICATE
 *
 * @returns {{ok: true, interiorStart: number, interiorEnd: number} | {ok: false, violation: Violation}}
 */
function classifyTokens(tokens, document) {
  if (tokens.length === 0) {
    return { ok: false, violation: { code: "MARKER_MISSING", document, field: "marker", message: "no source-of-truth marker block present" } };
  }

  // Walk the token stream as a small state machine. A "complete block" is a
  // begin immediately followed by its matching end (with no nested begin
  // between them).
  let completeBlocks = 0;
  let firstBlockInterior = null; // {start, end} of first valid block
  let openBegin = null; // index of an unmatched begin

  for (const tok of tokens) {
    if (tok.kind === "begin") {
      if (openBegin !== null) {
        // begin while already inside a begin → nested
        return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: "nested begin token inside an open marker block" } };
      }
      openBegin = tok.index;
    } else {
      // end token
      if (openBegin === null) {
        // end with no open begin → orphan
        return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: "end token without an open begin (orphan end)" } };
      }
      // Matching pair found.
      if (completeBlocks === 0) {
        firstBlockInterior = {
          interiorStart: openBegin + MARKER_BEGIN.length,
          interiorEnd: tok.index,
        };
      }
      completeBlocks += 1;
      openBegin = null;
    }
  }

  if (openBegin !== null) {
    // dangling begin with no closing end
    return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: "begin token without a matching end (unclosed fence)" } };
  }

  if (completeBlocks > 1) {
    return { ok: false, violation: { code: "MARKER_DUPLICATE", document, field: "marker", message: `found ${completeBlocks} complete marker blocks; expected exactly 1` } };
  }

  return { ok: true, ...firstBlockInterior };
}

/**
 * Extract the single ```json fence body from inside the HTML block. Line scan.
 *
 * @returns {{ok: true, json: string} | {ok: false, violation: Violation}}
 */
function extractJsonFence(blockText, document) {
  const lines = blockText.split(/\r?\n/);
  let fenceOpenIdx = -1;
  let fenceCloseIdx = -1;
  let openCount = 0;
  let closeCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (JSON_FENCE_OPEN_RE.test(lines[i])) {
      openCount += 1;
      if (fenceOpenIdx === -1) fenceOpenIdx = i;
    } else if (JSON_FENCE_CLOSE_RE.test(lines[i])) {
      closeCount += 1;
      if (fenceOpenIdx !== -1 && fenceCloseIdx === -1) {
        fenceCloseIdx = i;
      }
    }
  }

  if (openCount === 0 && closeCount === 0) {
    return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: "no ```json fence found inside marker block" } };
  }
  if (openCount !== 1 || closeCount !== 1) {
    return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: `expected exactly one open and one close fence; found ${openCount} open and ${closeCount} close (possible nested or multiple fences)` } };
  }

  // Lines strictly between the open and close fence lines.
  const bodyLines = lines.slice(fenceOpenIdx + 1, fenceCloseIdx);

  // Lines BEFORE the open fence and AFTER the close fence (inside the HTML
  // block) must be whitespace-only. Stray content outside the JSON fence but
  // inside the marker is malformed.
  const before = lines.slice(0, fenceOpenIdx).join("");
  const after = lines.slice(fenceCloseIdx + 1).join("");
  if (before.trim() !== "" || after.trim() !== "") {
    return { ok: false, violation: { code: "MARKER_MALFORMED", document, field: "marker", message: "stray non-whitespace content outside the JSON fence but inside the marker block" } };
  }

  return { ok: true, json: bodyLines.join("\n") };
}

/**
 * Validate a parsed value against SourceTruthContract (schemaVersion 1).
 * Emits each distinct schema defect once. Returns null on success.
 *
 * @param {*} value
 * @param {string} document
 * @returns {Violation[]} empty if valid
 */
function validateSchema(value, document) {
  const violations = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    violations.push({ code: "SCHEMA_NON_OBJECT", document, field: "root", message: "marker JSON must be a JSON object" });
    return violations; // cannot continue field-by-field on a non-object
  }

  const knownTopLevel = new Set(["schemaVersion", "version", "services", "workers", "migrations"]);
  for (const key of Object.keys(value)) {
    if (!knownTopLevel.has(key)) {
      violations.push({ code: "SCHEMA_UNKNOWN_FIELD", document, field: key, message: `unknown field '${key}'` });
    }
  }

  // schemaVersion
  if (!("schemaVersion" in value)) {
    violations.push({ code: "SCHEMA_MISSING_FIELD", document, field: "schemaVersion", message: "required field 'schemaVersion' is missing" });
  } else if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "schemaVersion", message: "field 'schemaVersion' must be an integer" });
  } else if (value.schemaVersion !== SCHEMA_VERSION_CURRENT) {
    violations.push({ code: "SCHEMA_VERSION", document, field: "schemaVersion", message: `unsupported schemaVersion ${value.schemaVersion}; expected ${SCHEMA_VERSION_CURRENT}` });
  }

  // version
  if (!("version" in value)) {
    violations.push({ code: "SCHEMA_MISSING_FIELD", document, field: "version", message: "required field 'version' is missing" });
  } else if (typeof value.version !== "string") {
    violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "version", message: "field 'version' must be a string" });
  } else if (!SEMVER_RE.test(value.version)) {
    violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "version", message: "field 'version' must be a semver string (X.Y.Z)" });
  }

  // services + workers share the same array-of-non-empty-unique-strings rules
  for (const field of ["services", "workers"]) {
    if (!(field in value)) {
      violations.push({ code: "SCHEMA_MISSING_FIELD", document, field, message: `required field '${field}' is missing` });
      continue;
    }
    if (!Array.isArray(value[field])) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field, message: `field '${field}' must be an array` });
      continue;
    }
    if (value[field].length === 0) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field, message: `field '${field}' must be a non-empty array` });
      continue;
    }
    const badType = value[field].some((v) => typeof v !== "string");
    if (badType) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field, message: `field '${field}' must contain only strings` });
      continue;
    }
    const emptyString = value[field].some((v) => v.length === 0);
    if (emptyString) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field, message: `field '${field}' must contain no empty strings` });
      continue;
    }
    const seen = new Set();
    for (const v of value[field]) {
      if (seen.has(v)) {
        violations.push({ code: "SCHEMA_DUPLICATE_ARRAY_ENTRY", document, field, message: `duplicate entry '${v}' in '${field}'` });
        break; // one defect per field
      }
      seen.add(v);
    }
  }

  // migrations
  if (!("migrations" in value)) {
    violations.push({ code: "SCHEMA_MISSING_FIELD", document, field: "migrations", message: "required field 'migrations' is missing" });
  } else if (value.migrations === null || typeof value.migrations !== "object" || Array.isArray(value.migrations)) {
    violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "migrations", message: "field 'migrations' must be an object" });
  } else {
    const knownMigrationFields = new Set(["first", "last", "count"]);
    for (const key of Object.keys(value.migrations)) {
      if (!knownMigrationFields.has(key)) {
        violations.push({ code: "SCHEMA_UNKNOWN_FIELD", document, field: `migrations.${key}`, message: `unknown field 'migrations.${key}'` });
      }
    }
    for (const sub of ["first", "last"]) {
      if (!(sub in value.migrations)) {
        violations.push({ code: "SCHEMA_MISSING_FIELD", document, field: `migrations.${sub}`, message: `required field 'migrations.${sub}' is missing` });
      } else if (typeof value.migrations[sub] !== "string") {
        violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: `migrations.${sub}`, message: `field 'migrations.${sub}' must be a string` });
      } else if (!MIGRATION_ID_RE.test(value.migrations[sub])) {
        violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: `migrations.${sub}`, message: `field 'migrations.${sub}' must be a 3-digit zero-padded id (e.g. "001")` });
      }
    }
    if (!("count" in value.migrations)) {
      violations.push({ code: "SCHEMA_MISSING_FIELD", document, field: "migrations.count", message: "required field 'migrations.count' is missing" });
    } else if (typeof value.migrations.count !== "number" || !Number.isInteger(value.migrations.count)) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "migrations.count", message: "field 'migrations.count' must be an integer" });
    } else if (value.migrations.count <= 0) {
      violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "migrations.count", message: "field 'migrations.count' must be positive" });
    }
    // Cross-field invariant: count matches first..last range. Only when the
    // individual fields are well-formed enough to evaluate.
    const f = value.migrations.first;
    const l = value.migrations.last;
    const c = value.migrations.count;
    if (typeof f === "string" && typeof l === "string" && typeof c === "number" &&
        MIGRATION_ID_RE.test(f) && MIGRATION_ID_RE.test(l) && Number.isInteger(c)) {
      const expected = parseInt(l, 10) - parseInt(f, 10) + 1;
      if (expected !== c) {
        violations.push({ code: "SCHEMA_WRONG_TYPE", document, field: "migrations", message: `migrations.count (${c}) does not match first..last range (${f}..${l} = ${expected})` });
      }
    }
  }

  return violations;
}

/**
 * Parse a source-of-truth marker block from text. Deterministic, pure.
 *
 * @param {string} text full document text
 * @param {{document: string}} opts document name for violation attribution
 * @returns {{data: SourceTruthContract|null, violations: Violation[]}}
 */
export function parseSourceTruthMarker(text, { document }) {
  if (typeof text !== "string") {
    return { data: null, violations: [{ code: "MARKER_PARSE_FAILURE", document, field: "marker", message: "input text is not a string" }] };
  }

  const tokenResult = classifyTokens(scanTokens(text), document);
  if (!tokenResult.ok) {
    return { data: null, violations: [tokenResult.violation] };
  }

  const blockText = text.slice(tokenResult.interiorStart, tokenResult.interiorEnd);
  const fenceResult = extractJsonFence(blockText, document);
  if (!fenceResult.ok) {
    return { data: null, violations: [fenceResult.violation] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fenceResult.json);
  } catch (err) {
    return { data: null, violations: [{ code: "MARKER_PARSE_FAILURE", document, field: "marker", message: `JSON parse error: ${err.message}` }] };
  }

  const schemaViolations = validateSchema(parsed, document);
  if (schemaViolations.length > 0) {
    return { data: null, violations: schemaViolations };
  }

  return { data: parsed, violations: [] };
}
