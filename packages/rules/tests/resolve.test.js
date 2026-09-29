// tests/resolve.test.js
// W2-04 canonical configuration layering — resolver matrix (A1–A7, A10–A13, A19).

import { jest } from "@jest/globals";
import {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
  parseConfigLayer,
  resolveConfigLayers,
  stableStringify,
  hashCanonical,
} from "../src/index.js";

describe("stableStringify / hashCanonical (A6, A19)", () => {
  test("key order does not affect canonical form", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  test("array order is semantic and preserved", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  test("hashes are stable across identical inputs and key orders", () => {
    expect(hashCanonical({ x: 1, y: { b: 2, a: 3 } }))
      .toBe(hashCanonical({ y: { a: 3, b: 2 }, x: 1 }));
  });
});

describe("parseConfigLayer — sparse source parsing", () => {
  test("empty and whitespace input is an explicit empty layer", () => {
    for (const input of ["", "   ", "\n", null, undefined]) {
      const { layer, explicitKeys } = parseConfigLayer(input);
      expect(layer).toEqual({});
      expect(explicitKeys).toEqual([]);
    }
  });

  test("returns only explicitly supplied values", () => {
    const { layer, explicitKeys } = parseConfigLayer("pillars:\n  triage:\n    enabled: true\n");
    expect(layer).toEqual({ pillars: { triage: { enabled: true } } });
    expect(explicitKeys).toEqual(["pillars"]);
    // No defaults leaked into the sparse layer.
    expect(layer.settings).toBeUndefined();
    expect(layer.pillars.ci_healing).toBeUndefined();
  });

  test("invalid shape throws and supplies nothing (no partial apply)", () => {
    expect(() => parseConfigLayer("pillars:\n  triage:\n    enabled: yes-but-not-boolean\n"))
      .toThrow(/must be a boolean/);
    expect(() => parseConfigLayer("custom_rules:\n  broken:\n    if: 7\n"))
      .toThrow(/must be a string expression/);
    expect(() => parseConfigLayer("- just\n- a\n- list\n"))
      .toThrow(/must be a mapping/);
  });

  test("explicit permitted null survives as a supplied value", () => {
    const { layer } = parseConfigLayer(
      "pillars:\n  maintainer:\n    stale:\n      issues:\n        close_days: null\n",
    );
    expect(layer.pillars.maintainer.stale.issues.close_days).toBeNull();
  });
});

describe("resolveConfigLayers — precedence and sparsity", () => {
  const orgLayer = (values, source = "org/gitwire-config@abc") =>
    ({ values, source });
  const repoLayer = (values, source = "owner/repo@def") => ({ values, source });

  test("A1: resolver order is defaults → org → repo → governed", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({ settings: { dry_run: false } }),
      repo: repoLayer({ settings: { dry_run: true } }),
      governed: { values: { settings: { dry_run: false } }, source: "policy:v1:promo:p1" },
    });
    expect(resolved.config.settings.dry_run).toBe(false);
    expect(resolved.provenance["/settings/dry_run"]).toBe("governed");

    const withoutGoverned = resolveConfigLayers({
      org: orgLayer({ settings: { dry_run: false } }),
      repo: repoLayer({ settings: { dry_run: true } }),
    });
    expect(withoutGoverned.config.settings.dry_run).toBe(true);
    expect(withoutGoverned.provenance["/settings/dry_run"]).toBe("repo");

    const withoutRepo = resolveConfigLayers({
      org: orgLayer({ settings: { dry_run: false } }),
    });
    expect(withoutRepo.config.settings.dry_run).toBe(false);
    expect(withoutRepo.provenance["/settings/dry_run"]).toBe("org");
  });

  test("A2: higher layers override only explicitly supplied values", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({
        pillars: { triage: { enabled: true, auto_label: false } },
      }),
      repo: repoLayer({ pillars: { triage: { enabled: false } } }),
    });
    // repo explicitly supplied only `enabled`; org's auto_label inherits.
    expect(resolved.config.pillars.triage.enabled).toBe(false);
    expect(resolved.config.pillars.triage.auto_label).toBe(false);
    expect(resolved.provenance["/pillars/triage/enabled"]).toBe("repo");
    expect(resolved.provenance["/pillars/triage/auto_label"]).toBe("org");
  });

  test("A3: missing repo values inherit explicit org values, not defaults", () => {
    // The baseline defect: parseConfig-expanded repo layer reset org values
    // to built-in defaults for every key the repo YAML omitted.
    const resolved = resolveConfigLayers({
      org: orgLayer({
        pillars: { triage: { enabled: true }, ai_review: { model: "org-model" } },
      }),
      repo: repoLayer({ pillars: { triage: { auto_label: false } } }),
    });
    expect(resolved.config.pillars.triage.enabled).toBe(true);
    expect(resolved.config.pillars.triage.auto_label).toBe(false);
    expect(resolved.config.pillars.ai_review.model).toBe("org-model");
    expect(resolved.provenance["/pillars/triage/enabled"]).toBe("org");
    expect(resolved.provenance["/pillars/ai_review/model"]).toBe("org");
  });

  test("A4: arrays replace; objects merge recursively", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({
        pillars: {
          triage: { triggers: { branches: ["main"], ignore_authors: ["bot"] } },
        },
      }),
      repo: repoLayer({
        pillars: { triage: { triggers: { branches: ["dev"] } } },
      }),
    });
    // Arrays replace, never concatenate.
    expect(resolved.config.pillars.triage.triggers.branches).toEqual(["dev"]);
    // Sibling object keys inside the same node inherit.
    expect(resolved.config.pillars.triage.triggers.ignore_authors).toEqual(["bot"]);
    expect(resolved.provenance["/pillars/triage/triggers/branches"]).toBe("repo");
    expect(resolved.provenance["/pillars/triage/triggers/ignore_authors"]).toBe("org");
  });

  test("A5: explicit null differs from absence", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({
        pillars: { maintainer: { stale: { issues: { close_days: 14 } } } },
      }),
      repo: repoLayer({
        pillars: { maintainer: { stale: { issues: { close_days: null } } } },
      }),
    });
    expect(resolved.config.pillars.maintainer.stale.issues.close_days).toBeNull();
    expect(resolved.provenance["/pillars/maintainer/stale/issues/close_days"]).toBe("repo");

    const absent = resolveConfigLayers({
      org: orgLayer({
        pillars: { maintainer: { stale: { issues: { close_days: 14 } } } },
      }),
      repo: repoLayer({ pillars: { maintainer: { stale: { issues: { warn_days: 90 } } } } }),
    });
    expect(absent.config.pillars.maintainer.stale.issues.close_days).toBe(14);
  });

  test("A6: same inputs and source revisions produce identical bundles", () => {
    const inputs = () => ({
      org: orgLayer({ pillars: { triage: { enabled: true } } }),
      repo: repoLayer({ settings: { dry_run: false } }),
      governed: { values: { pillars: { trust: { enabled: true } } }, source: "pv:u1:pr:pm1" },
    });
    const a = resolveConfigLayers(inputs());
    const b = resolveConfigLayers(inputs());
    expect(stableStringify(a.config)).toBe(stableStringify(b.config));
    expect(stableStringify(a.provenance)).toBe(stableStringify(b.provenance));
    expect(stableStringify(a.versionVector)).toBe(stableStringify(b.versionVector));
    expect(a.effectiveHash).toBe(b.effectiveHash);
  });

  test("A6/A7-intent: revision change with identical values changes vector, not hash", () => {
    const values = { pillars: { triage: { enabled: true } } };
    const a = resolveConfigLayers({ repo: repoLayer(values, "owner/repo@sha-1") });
    const b = resolveConfigLayers({ repo: repoLayer(values, "owner/repo@sha-2") });
    expect(a.versionVector.repo).toBe("owner/repo@sha-1");
    expect(b.versionVector.repo).toBe("owner/repo@sha-2");
    // Same effective values → same canonical configuration → same hash.
    expect(a.effectiveHash).toBe(b.effectiveHash);
    expect(stableStringify(a.config)).toBe(stableStringify(b.config));
  });

  test("A7: every effective leaf carries supplying-layer provenance", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({ pillars: { triage: { enabled: true } } }),
      repo: repoLayer({ pillars: { ai_review: { model: "repo-model" } } }),
    });
    // Walk the effective config; every leaf must have a provenance entry.
    const leaves = [];
    (function walk(value, path) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const key of Object.keys(value)) {
          if (key === "_meta" || key === "_explicitKeys") continue;
          walk(value[key], path + "/" + key);
        }
        return;
      }
      leaves.push(path);
    })(resolved.config, "");
    expect(leaves.length).toBeGreaterThan(50);
    for (const pointer of leaves) {
      expect(["defaults", "org", "repo", "governed"])
        .toContain(resolved.provenance[pointer]);
    }
  });

  test("A10: governed override wins over repo/org/default values", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({ settings: { dry_run: false } }),
      repo: repoLayer({ settings: { dry_run: false } }),
      governed: { values: { settings: { dry_run: true } }, source: "pv:v9:pr:pm9" },
    });
    expect(resolved.config.settings.dry_run).toBe(true);
    expect(resolved.provenance["/settings/dry_run"]).toBe("governed");
  });

  test("A11-intent: repo/org cannot displace governed identity in the vector", () => {
    const resolved = resolveConfigLayers({
      repo: repoLayer({ pillars: { triage: { enabled: true } } }),
      governed: { values: { pillars: { trust: { enabled: true } } }, source: "pv:v1:pr:pm1" },
    });
    expect(resolved.versionVector.governed).toBe("pv:v1:pr:pm1");
    expect(resolved.versionVector.repo).toBe("owner/repo@def");
    expect(resolved.layers.governed).toBe(true);
  });

  test("A19: observational metadata cannot enter identity", () => {
    const inputs = () => ({
      repo: repoLayer({ pillars: { triage: { enabled: true } } }),
    });
    const a = resolveConfigLayers(inputs());
    const b = resolveConfigLayers(inputs());
    // The resolver output carries no timestamps at all; attaching one
    // afterwards cannot change the hash because the hash is computed inside.
    a.config._meta = { resolved_at: "2026-09-29T00:00:00Z" };
    expect(a.effectiveHash).toBe(b.effectiveHash);
    expect(JSON.stringify(a.versionVector)).not.toContain("resolved_at");
  });

  test("absent optional layers are explicitly absent in the vector", () => {
    const resolved = resolveConfigLayers({});
    expect(resolved.versionVector).toEqual({
      defaults: CONFIG_SCHEMA_VERSION,
      org: null,
      repo: null,
      governed: null,
    });
    expect(resolved.layers).toEqual({
      defaults: true,
      org: false,
      repo: false,
      governed: false,
    });
  });

  test("explicitKeys is the union of org and repo top-level keys", () => {
    const resolved = resolveConfigLayers({
      org: orgLayer({ pillars: { triage: { enabled: true } }, expressions: {} }),
      repo: repoLayer({ pillars: { ai_review: { model: "m" } }, custom_rules: {} }),
    });
    expect(resolved.explicitKeys).toEqual(["custom_rules", "expressions", "pillars"]);
  });

  test("quality_gates: explicit YAML gate set strips the built-in default gate", () => {
    const resolved = resolveConfigLayers({
      repo: repoLayer({
        quality_gates: {
          strict: {
            conditions: [{ metric: "readiness_score", operator: ">=", threshold: 80 }],
            block_on_fail: false,
          },
        },
      }),
    });
    expect(resolved.config.quality_gates.default).toBeUndefined();
    expect(resolved.config.quality_gates.strict).toBeDefined();
    expect(resolved.provenance["/quality_gates/strict/block_on_fail"]).toBe("repo");
  });

  test("quality_gates: explicit set naming a 'default' gate keeps it", () => {
    const resolved = resolveConfigLayers({
      repo: repoLayer({
        quality_gates: {
          default: {
            conditions: [{ metric: "readiness_score", operator: ">=", threshold: 70 }],
            block_on_fail: false,
          },
        },
      }),
    });
    expect(resolved.config.quality_gates.default.block_on_fail).toBe(false);
  });

  test("quality_gates: no explicit YAML gates leaves the defaults gate intact", () => {
    const resolved = resolveConfigLayers({
      repo: repoLayer({ pillars: { triage: { enabled: true } } }),
    });
    expect(resolved.config.quality_gates.default).toBeDefined();
    expect(resolved.provenance["/quality_gates/default/conditions"]).toBe("defaults");
  });

  test("quality_gates: a governed-supplied 'default' gate is never stripped by YAML gate sets", () => {
    const resolved = resolveConfigLayers({
      repo: repoLayer({
        quality_gates: {
          strict: {
            conditions: [{ metric: "readiness_score", operator: ">=", threshold: 70 }],
            block_on_fail: false,
          },
        },
      }),
      governed: {
        values: {
          quality_gates: {
            default: {
              conditions: [{ metric: "readiness_score", operator: ">=", threshold: 95 }],
              block_on_fail: false,
            },
          },
        },
        source: "pv:v1:pr:pm1",
      },
    });
    expect(resolved.config.quality_gates.default.conditions[0].threshold).toBe(95);
    expect(resolved.config.quality_gates.strict).toBeDefined();
    expect(resolved.provenance["/quality_gates/default/conditions"]).toBe("governed");
  });

  test("governed layer contributes values but not explicitKeys", () => {
    const resolved = resolveConfigLayers({
      governed: { values: { quality_gates: {} }, source: "pv:v1:pr:pm1" },
    });
    expect(resolved.explicitKeys).toEqual([]);
  });

  test("a YAML syntax error is a validation rejection, never an absent layer", () => {
    expect(() => parseConfigLayer("pillars:\n  triage:\n   enabled: [unclosed"))
      .toThrow(/Invalid \.gitwire\.yml: YAML syntax error:/);
    expect(() => parseConfigLayer("\tversion: 1"))
      .toThrow(/Invalid \.gitwire\.yml:/);
  });

  test("prototype-pollution keys are rejected at any depth (CodeQL guard)", () => {
    expect(() => parseConfigLayer("__proto__:\n  polluted: yes\n"))
      .toThrow(/must not contain __proto__/);
    expect(() => parseConfigLayer("pillars:\n  triage:\n    triggers:\n      __proto__:\n        polluted: yes\n"))
      .toThrow(/must not contain __proto__/);
    expect(() => parseConfigLayer("constructor:\n  prototype:\n    x: 1\n"))
      .toThrow(/must not contain __proto__|constructor/);
  });

  test("own __proto__ keys fed DIRECTLY to the resolver cannot pollute Object.prototype", () => {
    // Object literals do not create own __proto__ keys (the setter fires
    // instead), so the reproducer must use JSON.parse — the fifth review
    // round proved the merge primitive was reachable this way from any
    // caller that bypasses parseConfigLayer validation.
    const crafted = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "settings": {"dry_run": false}}',
    );
    const resolved = resolveConfigLayers({ repo: { values: crafted, source: "r@1" } });

    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(({}).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({}).polluted).toBeUndefined();
    // Legitimate keys from the same crafted document still resolve normally.
    expect(resolved.config.settings.dry_run).toBe(false);
  });

  test("procedural metadata keys supplied by any layer are stripped before hashing", () => {
    const withMeta = resolveConfigLayers({
      governed: {
        values: { _meta: { resolved_at: "1999-01-01T00:00:00Z" }, _explicitKeys: ["x"] },
        source: "pv:v1:pr:pm1",
      },
    });
    expect(withMeta.config._meta).toBeUndefined();
    expect(withMeta.config._explicitKeys).toBeUndefined();
    // The hash is computed after the strip: identical values produce the
    // identical hash regardless of carried metadata.
    const withoutMeta = resolveConfigLayers({
      governed: { values: {}, source: "pv:v1:pr:pm1" },
    });
    expect(withMeta.effectiveHash).toBe(withoutMeta.effectiveHash);
  });

  test("quality_gates: a PARTIAL YAML override of 'default' keeps the merged gate", () => {
    // parseConfig semantics: naming a gate "default" — even partially —
    // merges onto the built-in gate instead of replacing it wholesale, and
    // the strip pass must not delete the result.
    const resolved = resolveConfigLayers({
      repo: repoLayer({
        quality_gates: {
          default: {
            block_on_fail: false,
          },
        },
      }),
    });
    expect(resolved.config.quality_gates.default.block_on_fail).toBe(false);
    // The untouched leaf still comes from defaults (merged, not replaced).
    expect(resolved.config.quality_gates.default.conditions).toBeDefined();
    expect(resolved.provenance["/quality_gates/default/conditions"]).toBe("defaults");
  });
});

describe("W2-04 safe defaults (A12, A13)", () => {
  const MUTATION_CAPABLE_MASTER_SWITCHES = [
    "/pillars/triage/enabled",
    "/pillars/ci_healing/enabled",
    "/pillars/maintainer/enabled",
    "/pillars/issue_fix/enabled",
    "/pillars/enforcement/enabled",
    "/pillars/trust/enabled",
    "/pillars/merge_queue/enabled",
    "/pillars/ai_review/enabled",
    "/pillars/spam_gate/enabled",
  ];

  test("A12: settings.dry_run defaults true", () => {
    expect(DEFAULT_CONFIG.settings.dry_run).toBe(true);
    const resolved = resolveConfigLayers({});
    expect(resolved.config.settings.dry_run).toBe(true);
    expect(resolved.provenance["/settings/dry_run"]).toBe("defaults");
  });

  test("A13: every mutation-capable switch defaults to the non-mutating state", () => {
    const resolved = resolveConfigLayers({});
    for (const pointer of MUTATION_CAPABLE_MASTER_SWITCHES) {
      const value = pointer.split("/").slice(1).reduce((acc, key) => acc[key], resolved.config);
      expect({ pointer, value }).toEqual({ pointer, value: false });
      expect(resolved.provenance[pointer]).toBe("defaults");
    }
    // The other mutation-capable setting defaults safe too.
    expect(DEFAULT_CONFIG.settings.release_close_fixed_issues).toBe(false);
  });

  test("A14-intent: empty resolution cannot enable any mutation", () => {
    const resolved = resolveConfigLayers({});
    const mutating = MUTATION_CAPABLE_MASTER_SWITCHES.filter((pointer) => {
      const value = pointer.split("/").slice(1).reduce((acc, key) => acc[key], resolved.config);
      return value === true;
    });
    expect(mutating).toEqual([]);
    expect(resolved.config.settings.dry_run).toBe(true);
  });

  test("A15-intent: explicit layers can still enable through normal precedence", () => {
    const resolved = resolveConfigLayers({
      org: { values: { pillars: { triage: { enabled: true } } }, source: "o@1" },
      repo: { values: { settings: { dry_run: false } }, source: "r@1" },
    });
    expect(resolved.config.pillars.triage.enabled).toBe(true);
    expect(resolved.config.settings.dry_run).toBe(false);
  });
});
