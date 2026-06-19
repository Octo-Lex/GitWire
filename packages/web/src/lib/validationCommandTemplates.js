// src/lib/validationCommandTemplates.js
// Fixed argv templates for approved validation identifiers.
//
// Maps each approved validation identifier (from task_envelope.required_validation)
// to a fixed argv array. No raw command strings are ever passed to a shell.
// Only allowlisted identifiers resolve to executable templates.
//
// This is the single source of truth for what commands the executor may run.
// Adding a new validation identifier requires adding its template here AND
// updating the allowlist.

/**
 * Map of approved validation identifier → fixed argv template.
 *
 * The identifier comes from task_envelope.required_validation.
 * The argv is passed directly to child_process.spawn (no shell).
 */
export const COMMAND_TEMPLATES = {
  lint: ["npm", "run", "lint", "--"],
  test:  ["npm", "test", "--"],
  build: ["npm", "run", "build", "--"],
  typecheck: ["npm", "run", "typecheck", "--"],
};

/**
 * The allowlist of approved validation identifiers.
 * Derived from COMMAND_TEMPLATES keys so they can never diverge.
 */
export const ALLOWED_COMMAND_IDS = new Set(Object.keys(COMMAND_TEMPLATES));

/**
 * Resolve a validation identifier to its fixed argv template.
 *
 * @param {string} id - validation identifier (e.g., "lint", "test")
 * @returns {string[]} argv array
 * @throws {Error} if the identifier is not allowlisted
 */
export function resolveCommandTemplate(id) {
  const template = COMMAND_TEMPLATES[id];
  if (!template) {
    throw new Error(
      `Validation identifier '${id}' is not allowlisted — no argv template defined`
    );
  }
  return template;
}

/**
 * Check if a validation identifier is allowlisted.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isAllowedCommandId(id) {
  return ALLOWED_COMMAND_IDS.has(id);
}
