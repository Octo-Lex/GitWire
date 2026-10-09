// tests/direct-dangerous-keys.test.js
// #425 Unit B: direct-path regressions for CodeQL #36/#37. All three
// dangerous keys — __proto__, constructor, prototype — are driven through
// the DIRECT programmatic entry points that bypass configuration validation
// (resolveConfigLayers for mergeSparse; mergeDeep itself), at top level and
// nested. No validation runs first: the merge primitives' own guards are the
// only protection being exercised.
//
// v2 (maintainer correction): the nested destination's PROTOTYPE is asserted
// explicitly, not inferred. A `target.a.b.__proto__ = {...}` assignment
// changes the nested object's prototype WITHOUT creating an own property,
// and a root-prototype check cannot see it. The mergeDeep cases capture the
// nested object's actual prototype reference BEFORE the merge and assert the
// SAME reference after (before/after reference equality is realm-safe — both
// reads happen in this file's realm against module-produced objects). The
// resolver cases assert the module-created nested objects are plain by
// constructor-name + null-prototype-of-prototype (cross-realm safe) AND that
// repeated resolution yields nested objects with the SAME prototype.

import { describe, test, expect } from "@jest/globals";
import { resolveConfigLayers, mergeDeep } from "../src/index.js";

function crafted(dangerousKey, nested) {
  // JSON.parse creates OWN properties for these names — object literals
  // cannot (the __proto__ setter fires instead of creating an own key).
  if (nested) {
    return JSON.parse(`{"a": {"b": {"${dangerousKey}": {"polluted": "yes"}}}}`);
  }
  return JSON.parse(`{"${dangerousKey}": {"polluted": "yes"}}`);
}

function assertPlainObject(obj, label) {
  // Realm-safe plainness: jest vm contexts give test and module distinct
  // Object.prototype identities, so reference equality against the test
  // realm's Object.prototype would spuriously fail. A plain object's
  // prototype has a null prototype of its own and an "Object" constructor.
  const proto = Object.getPrototypeOf(obj);
  expect(proto && proto.constructor && proto.constructor.name).toBe("Object");
  expect(Object.getPrototypeOf(proto)).toBeNull();
  void label;
}

const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];

for (const key of DANGEROUS_KEYS) {
  for (const nested of [false, true]) {
    const where = nested ? "nested" : "top-level";

    test(`resolveConfigLayers (direct): ${where} "${key}" never pollutes Object.prototype, layer outputs, or nested prototypes`, () => {
      const craftedInput = crafted(key, nested);

      const resolved = resolveConfigLayers({
        org: { values: craftedInput, source: "org@direct" },
      });

      // Object.prototype untouched (own-property, descriptor, fresh lookup).
      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toBeUndefined();
      expect(Object.getPrototypeOf({}).polluted).toBeUndefined();

      // The dangerous key did NOT become an own property of the merged
      // config at either level (skipped entirely by the guard).
      const merged = resolved.config;
      expect(Object.hasOwn(merged, key)).toBe(false);
      if (nested) {
        expect(Object.hasOwn(merged.a, "b")).toBe(true);
        expect(Object.hasOwn(merged.a.b, key)).toBe(false);
      }

      // Root AND nested destinations are plain objects — a __proto__-setter
      // hit on the nested object would swap its prototype away from plain.
      assertPlainObject(merged, "root");
      if (nested) {
        assertPlainObject(merged.a, "a");
        assertPlainObject(merged.a.b, "a.b");
      }

      // Cross-output stability: the same crafted input resolves to nested
      // objects with the SAME prototype both times — a dangerous key cannot
      // redirect where nested objects inherit from between runs.
      const again = resolveConfigLayers({
        org: { values: craftedInput, source: "org@direct-2" },
      });
      if (nested) {
        expect(Object.getPrototypeOf(again.config.a.b)).toBe(Object.getPrototypeOf(merged.a.b));
      }

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
    });

    test(`mergeDeep (direct): ${where} "${key}" never pollutes Object.prototype, the target, or nested prototypes`, () => {
      const source = crafted(key, nested);
      const target = nested ? { a: { b: { keep: 1 } } } : { keep: 1 };

      // Capture the ACTUAL prototype references BEFORE the merge; asserting
      // the same references after is the direct proof that no __proto__
      // setter fired at any depth. (Same-realm before/after comparisons are
      // realm-safe by construction.)
      const rootProtoBefore = Object.getPrototypeOf(target);
      const nestedProtoBefore = nested ? Object.getPrototypeOf(target.a.b) : null;

      const returned = mergeDeep(target, source);

      expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
      expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toBeUndefined();
      expect(Object.getPrototypeOf({}).polluted).toBeUndefined();

      // The dangerous key never lands on the target at either level.
      expect(Object.hasOwn(returned, key)).toBe(false);
      if (nested) {
        expect(Object.hasOwn(returned.a.b, key)).toBe(false);
        expect(returned.a.b.keep).toBe(1);
      } else {
        expect(returned.keep).toBe(1);
      }

      // EXPLICIT nested-prototype invariant: same reference, at every depth.
      expect(Object.getPrototypeOf(returned)).toBe(rootProtoBefore);
      if (nested) {
        expect(Object.getPrototypeOf(returned.a)).toBe(Object.getPrototypeOf(target.a));
        expect(Object.getPrototypeOf(returned.a.b)).toBe(nestedProtoBefore);
      }
    });
  }
}

describe("predicate edges and the failure mode the v2 assertions guard against", () => {
  test("the denylist predicate itself rejects exactly the three dangerous keys", async () => {
    const { isDangerousConfigKey } = await import("../src/index.js");
    expect(isDangerousConfigKey("__proto__")).toBe(true);
    expect(isDangerousConfigKey("constructor")).toBe(true);
    expect(isDangerousConfigKey("prototype")).toBe(true);
    expect(isDangerousConfigKey("pillars")).toBe(false);
    expect(isDangerousConfigKey("__proto")).toBe(false);
    expect(isDangerousConfigKey("prototypeX")).toBe(false);
  });

  test("an unguarded __proto__ assignment swaps the prototype WITHOUT an own property — why own-key checks alone are insufficient", () => {
    // Documents the failure mode the explicit nested-prototype assertions
    // exist for: if mergeDeep ever lost its guard, a plain
    // `obj["__proto__"] = {...}` assignment changes the object's prototype
    // and leaves NO own key. Own-property checks would pass while the
    // pollution succeeded; only a prototype-reference comparison catches it.
    const unguarded = {};
    unguarded["__proto__"] = { polluted: "yes" }; // setter fires
    expect(Object.hasOwn(unguarded, "__proto__")).toBe(false); // NO own key
    expect(Object.getPrototypeOf(unguarded).polluted).toBe("yes"); // swapped
  });
});
