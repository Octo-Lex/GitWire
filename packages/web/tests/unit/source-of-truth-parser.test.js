// tests/unit/source-of-truth-parser.test.js
//
// Pure-function unit tests for the positional source-of-truth marker parser.
// Operates on synthetic text only — no filesystem, no checked-out-tree
// mutation. Each negative case asserts an EXACT sorted code array so that
// cascading secondary violations are caught as regressions.
//
// Ten primary schema/parse cases + six positional-only cases + one positive.

import { describe, it, expect } from "@jest/globals";
import { parseSourceTruthMarker } from "../../../../scripts/parse-source-truth.mjs";

const DOC = "AGENTS.md";

function codes(result) {
  return result.violations.map((v) => v.code).sort();
}

// A canonical valid marker body. Tests clone and mutate this.
const VALID_BODY = `
{
  "schemaVersion": 1,
  "version": "0.23.1",
  "services": ["gitwire-app", "postgres"],
  "workers": ["startWebhookWorker", "startTriageWorker"],
  "migrations": { "first": "001", "last": "037", "count": 37 }
}
`;

function wrap(body) {
  return `<!-- gitwire:source-of-truth:begin -->\n\`\`\`json\n${body}\n\`\`\`\n<!-- gitwire:source-of-truth:end -->`;
}

function validMarker() {
  return wrap(VALID_BODY.trim());
}

describe("source-of-truth marker parser — positive case", () => {
  it("parses a valid marker and returns data with no violations", () => {
    const result = parseSourceTruthMarker(validMarker(), { document: DOC });
    expect(result.violations).toEqual([]);
    expect(result.data).not.toBeNull();
    expect(result.data.schemaVersion).toBe(1);
    expect(result.data.version).toBe("0.23.1");
    expect(result.data.services).toEqual(["gitwire-app", "postgres"]);
    expect(result.data.workers).toEqual(["startWebhookWorker", "startTriageWorker"]);
    expect(result.data.migrations).toEqual({ first: "001", last: "037", count: 37 });
  });
});

// ─── Ten primary negative cases ──────────────────────────────────────────

describe("source-of-truth marker parser — ten primary negative cases", () => {
  // 1. missing marker
  it("rejects text with no marker at all (MARKER_MISSING)", () => {
    const result = parseSourceTruthMarker("just prose, no marker", { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MISSING"]);
  });

  // 2. duplicate marker
  it("rejects two complete marker blocks (MARKER_DUPLICATE)", () => {
    const text = validMarker() + "\n\n" + validMarker();
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_DUPLICATE"]);
  });

  // 3. nested JSON fences inside the marker block
  it("rejects nested ```json fences (MARKER_MALFORMED)", () => {
    const body = VALID_BODY.trim() + "\n```json\n{}\n```";
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });

  // 4. malformed JSON
  it("rejects malformed JSON body (MARKER_PARSE_FAILURE)", () => {
    const result = parseSourceTruthMarker(wrap("{ this is not json"), { document: DOC });
    expect(codes(result)).toEqual(["MARKER_PARSE_FAILURE"]);
  });

  // 5. non-object (JSON array)
  it("rejects a JSON array at the top level (SCHEMA_NON_OBJECT)", () => {
    const result = parseSourceTruthMarker(wrap("[1, 2, 3]"), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_NON_OBJECT"]);
  });

  // 6. wrong schema version (integer other than 1)
  it("rejects schemaVersion integer other than 1 (SCHEMA_VERSION)", () => {
    const body = VALID_BODY.trim().replace('"schemaVersion": 1', '"schemaVersion": 2');
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_VERSION"]);
  });

  // 7. missing required field (workers)
  it("rejects a missing required field (SCHEMA_MISSING_FIELD)", () => {
    const body = VALID_BODY.trim().replace(/,\s*"workers":\s*\[[^\]]*\]/, "");
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_MISSING_FIELD"]);
    expect(result.violations[0].field).toBe("workers");
  });

  // 8. unknown field
  it("rejects an unknown top-level field (SCHEMA_UNKNOWN_FIELD)", () => {
    const body = VALID_BODY.trim().replace(/\}\s*$/, ',\n  "foo": 1\n}');
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_UNKNOWN_FIELD"]);
    expect(result.violations[0].field).toBe("foo");
  });

  // 9. wrong type (version as number)
  it("rejects a wrong-typed field (SCHEMA_WRONG_TYPE)", () => {
    const body = VALID_BODY.trim().replace('"version": "0.23.1"', '"version": 123');
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_WRONG_TYPE"]);
    expect(result.violations[0].field).toBe("version");
  });

  // 10. duplicate array entry
  it("rejects a duplicate array entry (SCHEMA_DUPLICATE_ARRAY_ENTRY)", () => {
    const body = VALID_BODY.trim().replace(
      '"services": ["gitwire-app", "postgres"]',
      '"services": ["gitwire-app", "gitwire-app"]'
    );
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(codes(result)).toEqual(["SCHEMA_DUPLICATE_ARRAY_ENTRY"]);
    expect(result.violations[0].field).toBe("services");
  });
});

// ─── Six positional-only cases (token-stream classification) ─────────────

describe("source-of-truth marker parser — six positional cases", () => {
  // P1. missing begin (no tokens at all) — already covered by primary #1,
  // but restate here as a positional case for the precedence table.
  it("no begin or end tokens → MARKER_MISSING", () => {
    const result = parseSourceTruthMarker("plain prose with no html comment", { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MISSING"]);
  });

  // P2. end token without an open begin (orphan end)
  it("orphan end token (no preceding begin) → MARKER_MALFORMED (not MARKER_MISSING)", () => {
    const text = "prose\n<!-- gitwire:source-of-truth:end -->\nmore prose";
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });

  // P3. begin without a closing end (unclosed fence)
  it("begin with no matching end → MARKER_MALFORMED", () => {
    const text = "<!-- gitwire:source-of-truth:begin -->\n```json\n{}\n```\n(no end)";
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });

  // P4. nested begin inside an open block
  it("nested begin inside an open block → MARKER_MALFORMED", () => {
    const text =
      "<!-- gitwire:source-of-truth:begin -->\n" +
      "<!-- gitwire:source-of-truth:begin -->\n" +
      "<!-- gitwire:source-of-truth:end -->\n";
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });

  // P5. multiple JSON fences inside the (single valid) marker block
  it("multiple ```json fences inside the block → MARKER_MALFORMED", () => {
    const body = "```json\n{}\n```\n```json\n{}\n```";
    // We hand-build the block so the outer fence scan sees two open fences.
    const text =
      "<!-- gitwire:source-of-truth:begin -->\n" +
      body + "\n" +
      "<!-- gitwire:source-of-truth:end -->\n";
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });

  // P6. stray content outside the JSON fence but inside the marker block
  it("stray non-whitespace content outside the JSON fence → MARKER_MALFORMED", () => {
    const text =
      "<!-- gitwire:source-of-truth:begin -->\n" +
      "stray prose before the fence\n" +
      "```json\n" + VALID_BODY.trim() + "\n```\n" +
      "<!-- gitwire:source-of-truth:end -->\n";
    const result = parseSourceTruthMarker(text, { document: DOC });
    expect(codes(result)).toEqual(["MARKER_MALFORMED"]);
  });
});

// ─── Cascade-isolation spot checks ───────────────────────────────────────
//
// These prove that structural failures short-circuit: a parse/schema defect
// produces exactly ONE violation, never secondary schema defects. (The
// identity-comparison cascade prevention lives in check-source-of-truth.mjs
// and is exercised by the fixture suite in commit 9.)

describe("source-of-truth marker parser — cascade isolation", () => {
  it("SCHEMA_NON_OBJECT produces exactly one violation, never cascades", () => {
    const result = parseSourceTruthMarker(wrap("[1,2,3]"), { document: DOC });
    expect(result.violations.length).toBe(1);
  });

  it("MARKER_PARSE_FAILURE produces exactly one violation", () => {
    const result = parseSourceTruthMarker(wrap("{bad"), { document: DOC });
    expect(result.violations.length).toBe(1);
  });

  it("missing migrations.first AND migrations.last yields two distinct defects (no cascade suppression of sibling fields)", () => {
    // Both sub-fields independently missing → two SCHEMA_MISSING_FIELD.
    // This proves cascade suppression only applies to dependent downstream
    // stages (e.g. identity comparison), not to parallel field checks.
    const body = VALID_BODY.trim().replace(/"migrations":\s*\{[^}]*\}/, '"migrations": { "count": 37 }');
    const result = parseSourceTruthMarker(wrap(body), { document: DOC });
    expect(result.violations.length).toBe(2);
    expect(codes(result)).toEqual(["SCHEMA_MISSING_FIELD", "SCHEMA_MISSING_FIELD"]);
    const fields = result.violations.map((v) => v.field).sort();
    expect(fields).toEqual(["migrations.first", "migrations.last"]);
  });
});
