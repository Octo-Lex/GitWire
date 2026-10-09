// tests/direct-dangerous-keys.test.js
// #425 Unit B: direct-path regressions for CodeQL #36/#37. All three
// dangerous keys — __proto__, constructor, prototype — are driven through
// the DIRECT programmatic entry points that bypass configuration validation
// (resolveConfigLayers for mergeSparse; mergeDeep itself), at top level and
// nested. No validation runs first: the merge primitives' own guards are the
// only protection being exercised.

import { describe, test, expect } from "@jest/globals";
import { resolveConfigLayers, mergeDeep } from "../src/index.js";

// Crafted objects that bypass ALL validation: resolveConfigLayers accepts
// arbitrary `values` objects (the validation-requiring parseConfigLayer is
// never invoked), and mergeDeep is exported directly.
function crafted(dangerousKey, nested) {
  // JSON.parse creates OWN properties for these names — object literals
  // cannot (the __proto__ setter fires instead of creating an own key).
  if (nested) {
    return JSON.parse(`{"a": {"b": {"${dangerousKey}": {"polluted": "yes"}}}}`);
  }
  return JSON.parse(`{"${dangerousKey}": {"polluted": "yes"}}`);
}

function snapshotPrototypeState() {
  return {
    hasPolluted: Object.hasOwn(Object.prototype, "polluted"),
    protoDescriptor: Object.getOwnPropertyDescriptor(Object.prototype, "polluted"),
    freshProto: Object.getPrototypeOf({}).polluted,
  };
}

const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

for (const key of DANGEROUS_KEYS) {
  for (const nested of [false, true]) {
    const where = nested ? "nested" : "top-level";

    test(`resolveConfigLayers (direct): ${where} "${key}" never pollutes Object.prototype or layer outputs`, () => {
      const before = snapshotPrototypeState();
      const craftedInput = crafted(key, nested);

      const resolved = resolveConfigLayers({
        org: { values: craftedInput, source: "org@direct" },
      });

      // Object.prototype untouched.
      const after = snapshotPrototypeState();
      expect(after.hasPolluted).toBe(false);
      expect(after.protoDescriptor).toBeUndefined();
      expect(after.freshProto).toBeUndefined();

      // The dangerous key did NOT become an own property of the merged
      // config at either level (skipped entirely by the guard).
      const merged = resolved.config;
      expect(Object.hasOwn(merged, key)).toBe(false);
      if (nested) {
        expect(Object.hasOwn(merged.a, "b")).toBe(true);
        expect(Object.hasOwn(merged.a.b, key)).toBe(false);
      }

      // Destination prototypes unchanged: plain-object prototype (whose own
      // prototype is null) in ANY realm — jest vm contexts give the test and
      // the module distinct Object.prototype identities, so reference
      // equality against the test realm would spuriously fail.
      const mergedProto = Object.getPrototypeOf(merged);
      expect(mergedProto.constructor && mergedProto.constructor.name).toBe("Object");
      expect(Object.getPrototypeOf(mergedProto)).toBeNull();

      // Sibling legitimate values still merge correctly alongside the
      // skipped key.
      const withSibling = resolveConfigLayers({
        org: {
          values: JSON.parse(`{"settings": {"dry_run": true}, "${key}": {"polluted": "yes"}}`),
          source: "org@sib",
        },
      });
      expect(withSibling.config.settings.dry_run).toBe(true);
      expect(Object.hasOwn(withSibling.config, key)).toBe(false);
      void before;
    });

    test(`mergeDeep (direct): ${where} "${key}" never pollutes Object.prototype or the target`, () => {
      const before = snapshotPrototypeState();
      const source = crafted(key, nested);
      const target = nested ? { a: { b: { keep: 1 } } } : { keep: 1 };

      const returned = mergeDeep(target, source);

      const after = snapshotPrototypeState();
      expect(after.hasPolluted).toBe(false);
      expect(after.protoDescriptor).toBeUndefined();
      expect(after.freshProto).toBeUndefined();

      // The dangerous key never lands on the target at either level.
      expect(Object.hasOwn(returned, key)).toBe(false);
      if (nested) {
        expect(Object.hasOwn(returned.a.b, key)).toBe(false);
        expect(returned.a.b.keep).toBe(1);
      } else {
        expect(returned.keep).toBe(1);
      }

      // Target stays a plain object (prototype-of-prototype is null), in
      // any realm.
      const retProto = Object.getPrototypeOf(returned);
      expect(retProto.constructor && retProto.constructor.name).toBe("Object");
      expect(Object.getPrototypeOf(retProto)).toBeNull();
      void before;
    });
  }
}

test("the denylist predicate itself rejects exactly the three dangerous keys", async () => {
  const { isDangerousConfigKey } = await import("../src/index.js");
  expect(isDangerousConfigKey("__proto__")).toBe(true);
  expect(isDangerousConfigKey("constructor")).toBe(true);
  expect(isDangerousConfigKey("prototype")).toBe(true);
  expect(isDangerousConfigKey("pillars")).toBe(false);
  expect(isDangerousConfigKey("__proto")).toBe(false);
  expect(isDangerousConfigKey("prototypeX")).toBe(false);
});
