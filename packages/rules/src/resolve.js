// @gitwire/rules — resolve.js
// W2-04 canonical configuration layering.
//
// Separates two concepts parseConfig() conflates:
//   * source parsing  — parseConfigLayer() returns ONLY the values a source
//     explicitly supplied (sparse), validated against the same schema;
//   * effective resolution — resolveConfigLayers() merges sparse sources
//     onto the safe built-in defaults in frozen precedence order and derives
//     value-level provenance, a source version vector, and a canonical
//     effective hash.
//
// Precedence (lowest → highest): defaults ← organization ← repository ←
// governed promotion materialization. A higher layer overrides a lower one
// only where it explicitly supplies a value: absent keys inherit, scalars
// replace, plain objects merge recursively, arrays replace (never
// concatenate), and an explicit null permitted by the schema is a supplied
// value, not absence.
//
// Determinism contract: same source values + same source revisions produce
// the same config, provenance, version vector, and effective hash.
// Observational metadata such as resolved_at never enters identity.

import yaml from "js-yaml";
import { createHash } from "node:crypto";
import {
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
  validateConfig,
  isDangerousConfigKey,
} from "./schema.js";

export const LAYER_ORDER = ["defaults", "org", "repo", "governed"];

/**
 * Canonical JSON serialization: object keys sorted recursively, no whitespace.
 * Arrays keep their order (order is semantic).
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

/** SHA-256 hex digest of the canonical serialization of a value. */
export function hashCanonical(value) {
  return "sha256:" + createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/**
 * Parse one configuration source (a .gitwire.yml document) into the sparse
 * set of values it explicitly supplies.
 *
 * Returns { layer, explicitKeys }:
 *   layer       — structured clone of exactly the supplied values (may be {})
 *   explicitKeys— top-level keys explicitly present in the document
 *
 * Empty/whitespace-only input is an explicitly empty layer. Invalid shapes
 * throw exactly like parseConfig() — a source is never partially applied.
 */
export function parseConfigLayer(yamlContent) {
  if (!yamlContent || !yamlContent.trim()) {
    return { layer: {}, explicitKeys: [] };
  }

  let parsed;
  try {
    parsed = yaml.load(yamlContent);
  } catch (err) {
    // A YAML syntax error is an invalid source, not an absent one: the
    // sparse contract rejects present-but-invalid documents. Carry the same
    // "Invalid .gitwire.yml:" prefix as structural validation failures so
    // consumers classify both as validation errors.
    throw new Error("Invalid .gitwire.yml: YAML syntax error: " + (err.message || String(err)));
  }

  if (parsed === null || parsed === undefined) {
    return { layer: {}, explicitKeys: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid .gitwire.yml: document must be a mapping");
  }

  const validation = validateConfig(parsed);
  if (!validation.valid) {
    throw new Error("Invalid .gitwire.yml: " + validation.errors.join("; "));
  }

  return { layer: structuredClone(parsed), explicitKeys: Object.keys(parsed) };
}

function escapePointerToken(token) {
  return String(token).replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Delete every provenance entry at or below a replaced pointer. */
function clearProvenanceBelow(provenance, prefix) {
  for (const pointer of Object.keys(provenance)) {
    if (pointer === prefix || pointer.startsWith(prefix + "/")) {
      delete provenance[pointer];
    }
  }
}

/**
 * Merge `source` (sparse) onto `target`, recording every supplied leaf (and
 * every explicitly supplied non-branch node) into `provenance` under its
 * JSON-pointer path. Arrays replace; plain objects recurse; explicit null is
 * a supplied value.
 *
 * Provenance stays consistent with the config tree: replacing a subtree
 * (an object replaced by a scalar, or a scalar by anything) removes the
 * replaced subtree's entries, so no dangling pointers survive for consumers
 * that walk provenance (the quality-gate strip among them).
 *
 * Prototype-safety: dangerous keys (__proto__, constructor,
 * prototype) are ignored at this primitive unconditionally. Bracket access
 * on those names resolves to prototype setters/getters, so handling them
 * here would let crafted layer values mutate Object.prototype even when a
 * caller bypassed validation. Validation rejects documents carrying them;
 * this is the defense-in-depth backstop for unvalidated programmatic input.
 */
function mergeSparse(target, source, path, layerName, provenance) {
  for (const key of Object.keys(source)) {
    if (isDangerousConfigKey(key)) continue;
    const value = source[key];
    const pointer = path + "/" + escapePointerToken(key);
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeSparse(target[key], value, pointer, layerName, provenance);
      // The object node itself was explicitly supplied at this layer.
      provenance[pointer] = layerName;
    } else if (isPlainObject(value)) {
      // Object replacing a non-object (or absent key): the fresh node
      // carries only what this layer supplies into it.
      clearProvenanceBelow(provenance, pointer);
      const fresh = {};
      mergeSparse(fresh, value, pointer, layerName, provenance);
      target[key] = fresh;
      provenance[pointer] = layerName;
    } else {
      // Scalar/array replacement drops any subtree entries below the key.
      clearProvenanceBelow(provenance, pointer);
      target[key] = value;
      provenance[pointer] = layerName;
    }
  }
}

/**
 * Collect every leaf pointer present in a value tree, excluding the
 * procedural metadata keys (_meta, _explicitKeys, _hasFile).
 */
function leafPointers(value, path, out) {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (key === "_meta" || key === "_explicitKeys" || key === "_hasFile") continue;
      leafPointers(value[key], path + "/" + escapePointerToken(key), out);
    }
    return;
  }
  out.push(path);
}

function layerRevision(layer) {
  // A layer is { values, source } where source is a stable identity string
  // (or an object carrying one). Absent layer → null vector component.
  if (!layer) return null;
  if (typeof layer.source === "string") return layer.source;
  if (layer.source && typeof layer.source.revision === "string") return layer.source.revision;
  return "unversioned";
}

/**
 * Resolve the effective configuration from sparse layers.
 *
 * Each of org/repo/governed is null/undefined (absent) or
 * { values: <sparse object>, source: <stable source identity> }.
 *
 * Returns {
 *   config,          — effective config WITHOUT procedural metadata
 *   provenance,      — pointer → supplying layer name (highest wins)
 *   provenanceSources— pointer-independent per-layer source identities:
 *                      { defaults, org, repo, governed }
 *   versionVector,   — { defaults, org, repo, governed } source identities
 *   effectiveHash,   — sha256 over the canonical effective config values
 *                      only (not provenance, not the vector, not timestamps)
 *   explicitKeys,    — union of top-level keys explicitly supplied by the
 *                      org and repo YAML sources (governed excluded: a
 *                      promoted policy is a full materialization, and gate
 *                      opt-in semantics belong to YAML sources)
 *   layers,          — { defaults: true, org, repo, governed } presence booleans
 * }
 */
export function resolveConfigLayers({ defaults, org, repo, governed } = {}) {
  const baseDefaults = defaults === undefined ? DEFAULT_CONFIG : defaults;

  const config = structuredClone(baseDefaults);
  const provenance = {};
  const explicitKeys = new Set();

  // Mark every defaults leaf as supplied by the defaults layer.
  {
    const out = [];
    leafPointers(config, "", out);
    for (const pointer of out) provenance[pointer] = "defaults";
  }

  for (const layerName of ["org", "repo"]) {
    const layer = layerName === "org" ? org : repo;
    if (!layer || !layer.values) continue;
    mergeSparse(config, layer.values, "", layerName, provenance);
    for (const key of Object.keys(layer.values)) explicitKeys.add(key);
  }

  if (governed && governed.values) {
    mergeSparse(config, governed.values, "", "governed", provenance);
  }

  // quality_gates semantics preserved from parseConfig(): when any YAML
  // source explicitly supplies a gate set, the built-in "default" gate is
  // removed — unless the YAML set itself names a "default" gate (in whole or
  // in part: a partial override merges onto the built-in gate and keeps it,
  // exactly like parseConfig) or a higher layer (governed promotion) has
  // supplied "default" itself. The strip therefore applies only while the
  // ENTIRE surviving gate is still defaults-owned.
  const yamlSuppliedGates = (org?.values && "quality_gates" in org.values) ||
    (repo?.values && "quality_gates" in repo.values);
  if (yamlSuppliedGates && isPlainObject(config.quality_gates) && "default" in config.quality_gates) {
    // Wholly defaults-owned = every provenance entry at or below the
    // default gate still names the defaults layer (generic walk, so the
    // check cannot be defeated or narrowed by pointer hard-coding).
    const gatePrefix = "/quality_gates/default";
    const defaultGateEntries = Object.keys(provenance).filter(
      (pointer) => pointer === gatePrefix || pointer.startsWith(gatePrefix + "/"),
    );
    const defaultGateWhollyFromDefaults =
      defaultGateEntries.length > 0 &&
      defaultGateEntries.every((pointer) => provenance[pointer] === "defaults");
    if (defaultGateWhollyFromDefaults) {
      delete config.quality_gates.default;
      delete provenance["/quality_gates/default"];
      delete provenance["/quality_gates/default/conditions"];
      delete provenance["/quality_gates/default/block_on_fail"];
    }
  }

  // Procedural metadata never participates in the effective config: if any
  // source supplied _meta/_explicitKeys/_hasFile-shaped keys (e.g. a stored
  // override document carrying a previously attached _meta), strip them
  // before provenance is finalized and the hash is computed, so the hash
  // covers configuration values only. Fresh metadata is attached by the
  // caller after resolution.
  delete config._meta;
  delete config._explicitKeys;
  delete config._hasFile;
  clearProvenanceBelow(provenance, "/_meta");
  clearProvenanceBelow(provenance, "/_explicitKeys");
  clearProvenanceBelow(provenance, "/_hasFile");

  const versionVector = {
    defaults: CONFIG_SCHEMA_VERSION,
    org: layerRevision(org),
    repo: layerRevision(repo),
    governed: layerRevision(governed),
  };

  const provenanceSources = {
    defaults: "defaults:" + CONFIG_SCHEMA_VERSION,
    org: layerRevision(org),
    repo: layerRevision(repo),
    governed: layerRevision(governed),
  };

  // The effective hash is computed from canonical configuration data only
  // (the effective config values — not provenance, not the vector, not any
  // timestamp). Source revisions participate in identity through the version
  // vector: a revision change that does not change effective values changes
  // the vector while leaving this hash unchanged — that distinction is
  // intentional.
  const effectiveHash = hashCanonical(config);

  return {
    config,
    provenance,
    provenanceSources,
    versionVector,
    effectiveHash,
    explicitKeys: [...explicitKeys].sort(),
    layers: {
      defaults: true,
      org: Boolean(org && org.values && Object.keys(org.values).length > 0),
      repo: Boolean(repo && repo.values && Object.keys(repo.values).length > 0),
      governed: Boolean(governed && governed.values && Object.keys(governed.values).length > 0),
    },
  };
}
