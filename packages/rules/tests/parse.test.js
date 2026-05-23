import { parseConfig, mergeDeep } from "../src/parse.js";
import { DEFAULT_CONFIG } from "../src/schema.js";

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
