// @gitwire/rules — parse.js
// YAML parser with deep-merge onto defaults.

import yaml from "js-yaml";
import { DEFAULT_CONFIG, validateConfig } from "./schema.js";

/**
 * Parse a .gitwire.yml string into a resolved config object.
 * Missing fields inherit from DEFAULT_CONFIG via deep merge.
 * Returns DEFAULT_CONFIG for null/empty/whitespace-only input.
 */
export function parseConfig(yamlContent) {
  if (!yamlContent || !yamlContent.trim()) return structuredClone(DEFAULT_CONFIG);

  const parsed = yaml.load(yamlContent);

  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_CONFIG);

  // Validate before merge — reject invalid shapes
  const validation = validateConfig(parsed);
  if (!validation.valid) {
    throw new Error("Invalid .gitwire.yml: " + validation.errors.join("; "));
  }

  return mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
}

/**
 * Deep merge source into target. Arrays are replaced, not concatenated.
 * Mutates and returns target.
 */
export function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
