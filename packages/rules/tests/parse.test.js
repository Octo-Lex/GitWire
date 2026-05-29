import { parseConfig, mergeDeep } from "../src/parse.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/schema.js";

describe("parseConfig", () => {
  test("returns DEFAULT_CONFIG for null input", () => {
    const result = parseConfig(null);
    expect(result.pillars.triage.enabled).toBe(true);
    expect(result.pillars.issue_fix.enabled).toBe(false);
    expect(result.version).toBe(1);
  });

  test("returns DEFAULT_CONFIG for empty string", () => {
    const result = parseConfig("");
    expect(result.pillars.triage.enabled).toBe(true);
  });

  test("returns DEFAULT_CONFIG for whitespace-only string", () => {
    const result = parseConfig("   \n\n  ");
    expect(result.pillars.triage.enabled).toBe(true);
  });

  test("overrides only the specified field, keeps defaults for rest", () => {
    const yaml = `
pillars:
  triage:
    enabled: false
`;
    const result = parseConfig(yaml);

    // Overridden
    expect(result.pillars.triage.enabled).toBe(false);

    // Preserved from defaults
    expect(result.pillars.triage.auto_label).toBe(true);
    expect(result.pillars.triage.auto_comment).toBe(true);
    expect(result.pillars.ci_healing.enabled).toBe(true);
    expect(result.pillars.issue_fix.enabled).toBe(false);
    expect(result.pillars.maintainer.enabled).toBe(true);
    expect(result.version).toBe(1);
  });

  test("deep merges nested stale config", () => {
    const yaml = `
pillars:
  maintainer:
    stale:
      issues:
        warn_days: 90
`;
    const result = parseConfig(yaml);

    expect(result.pillars.maintainer.stale.issues.warn_days).toBe(90);
    // Other stale fields preserved
    expect(result.pillars.maintainer.stale.issues.close_days).toBeNull();
    expect(result.pillars.maintainer.stale.issues.exempt_labels).toEqual(["pinned", "security"]);
    expect(result.pillars.maintainer.stale.prs.warn_days).toBe(30);
  });

  test("allows unknown pillar keys (forward compat)", () => {
    const yaml = `
pillars:
  future_feature:
    enabled: true
    some_option: 42
`;
    const result = parseConfig(yaml);

    expect(result.pillars.future_feature.enabled).toBe(true);
    expect(result.pillars.future_feature.some_option).toBe(42);
    // Known pillars still present
    expect(result.pillars.triage.enabled).toBe(true);
  });

  test("overwrites arrays, does not concatenate", () => {
    const yaml = `
pillars:
  ci_healing:
    blocked_file_patterns:
      - "*.secret"
`;
    const result = parseConfig(yaml);

    expect(result.pillars.ci_healing.blocked_file_patterns).toEqual(["*.secret"]);
    // Not concatenated with defaults
    expect(result.pillars.ci_healing.blocked_file_patterns).not.toContain(".env*");
  });

  test("sets dry_run", () => {
    const yaml = `
settings:
  dry_run: true
`;
    const result = parseConfig(yaml);
    expect(result.settings.dry_run).toBe(true);
  });

  test("sets version", () => {
    const result = parseConfig("version: 2");
    expect(result.version).toBe(2);
  });

  test("does not mutate DEFAULT_CONFIG", () => {
    const original = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    parseConfig("pillars:\n  triage:\n    enabled: false");
    expect(DEFAULT_CONFIG.pillars.triage.enabled).toBe(true);
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(JSON.stringify(original));
  });
});

describe("mergeDeep", () => {
  test("merges nested objects", () => {
    const target = { a: { b: 1, c: 2 }, d: 3 };
    const source = { a: { b: 10 } };
    const result = mergeDeep(target, source);
    expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
  });

  test("replaces arrays", () => {
    const target = { list: [1, 2, 3] };
    const source = { list: [4, 5] };
    const result = mergeDeep(target, source);
    expect(result.list).toEqual([4, 5]);
  });

  test("replaces primitives", () => {
    const target = { x: 1, y: "hello" };
    const source = { x: 2 };
    const result = mergeDeep(target, source);
    expect(result).toEqual({ x: 2, y: "hello" });
  });
});

describe("validateConfig — custom_rules and expressions", () => {
  test("accepts valid custom_rules", () => {
    const config = {
      custom_rules: {
        safe_changes: {
          if: "is.formatting or is.docs",
          run: [
            { action: "add-label", args: { label: "safe" } },
          ],
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  test("rejects custom_rules without if string", () => {
    const config = {
      custom_rules: {
        bad_rule: {
          if: 42,
          run: [],
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("if must be a string");
  });

  test("rejects custom_rules without run array", () => {
    const config = {
      custom_rules: {
        bad_rule: {
          if: "true",
          run: "not-array",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("run must be an array");
  });

  test("accepts valid expressions", () => {
    const config = {
      expressions: {
        is: {
          docs: "files | all(extension('.md'))",
          safe: "files | all(extension('.css', '.scss'))",
        },
      },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  test("rejects non-object custom_rules", () => {
    const config = { custom_rules: "bad" };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("custom_rules must be an object");
  });
});

describe("parseConfig — _explicitKeys provenance", () => {
  test("no _explicitKeys for null input (DEFAULT_CONFIG)", () => {
    const result = parseConfig(null);
    expect(result._explicitKeys).toBeUndefined();
  });

  test("no _explicitKeys for empty string (DEFAULT_CONFIG)", () => {
    const result = parseConfig("");
    expect(result._explicitKeys).toBeUndefined();
  });

  test("_explicitKeys lists only user-provided top-level keys", () => {
    const yaml = "version: 1\ndry_run: true";
    const result = parseConfig(yaml);
    expect(result._explicitKeys).toEqual(["version", "dry_run"]);
    // quality_gates should exist (from DEFAULT_CONFIG merge) but NOT be explicit
    expect(result.quality_gates).toBeDefined();
    expect(result._explicitKeys).not.toContain("quality_gates");
  });

  test("_explicitKeys includes quality_gates when user sets it", () => {
    const yaml = `
version: 1
quality_gates:
  my-gate:
    conditions:
      - metric: ci_failure_rate_7d
        operator: "<"
        threshold: 0.5
    block_on_fail: false
`;
    const result = parseConfig(yaml);
    expect(result._explicitKeys).toContain("quality_gates");
    expect(result.quality_gates["my-gate"]).toBeDefined();
    // The default gate from DEFAULT_CONFIG is still present (deep merge)
    expect(result.quality_gates["default"]).toBeDefined();
  });

  test("_explicitKeys does not include keys from DEFAULT_CONFIG", () => {
    const yaml = "triage:\n  enabled: false";
    const result = parseConfig(yaml);
    expect(result._explicitKeys).toEqual(["triage"]);
    expect(result._explicitKeys).not.toContain("pillars");
    expect(result._explicitKeys).not.toContain("quality_gates");
  });
});
