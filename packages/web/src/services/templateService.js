// src/services/templateService.js
// Safe starter policy templates for new operators.
//
// Reads .yml files from packages/web/templates/, returns metadata and content.
// The dashboard surfaces these when .gitwire.yml is not found, giving new
// operators a fast, safe starting point.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../../templates");

// ── Template registry ──────────────────────────────────────────────────────
// Metadata is defined here (not parsed from YAML) so we control labels,
// descriptions, and difficulty without fragile comment parsing.

const TEMPLATE_META = [
  {
    id: "starter-dry-run",
    name: "Starter (Dry-Run)",
    description:
      "Safest first config — all pillars observe only, zero GitHub mutations. Perfect for evaluating GitWire.",
    difficulty: "beginner",
    dry_run: true,
    safety: "dry-run-protected",
    safety_label: "Dry-run protected",
    pillars_active: ["triage", "ci_healing", "maintainer", "enforcement", "trust", "ai_review"],
  },
  {
    id: "triage-only",
    name: "Triage Only",
    description:
      "Minimal scope — AI issue/PR labeling and duplicate detection. Only low-risk mutations: labels and comments.",
    difficulty: "beginner",
    dry_run: false,
    safety: "low-risk-live",
    safety_label: "Low-risk live actions",
    pillars_active: ["triage"],
  },
  {
    id: "ci-healing-dry-run",
    name: "CI Healing (Preview)",
    description:
      "Diagnose every failed CI run with root-cause analysis — no fix PRs opened. Comments only until you opt in.",
    difficulty: "intermediate",
    dry_run: false,
    safety: "safe-to-preview",
    safety_label: "Safe to preview",
    pillars_active: ["ci_healing", "enforcement", "trust"],
  },
  {
    id: "open-source-maintainer",
    name: "Open-Source Maintainer",
    description:
      "Broad automation for public repos — triage, spam protection, stale management, CI fixes, and PR review. Review all pillars before going live.",
    difficulty: "intermediate",
    dry_run: false,
    safety: "review-before-rollout",
    safety_label: "Review before rollout",
    pillars_active: ["triage", "ci_healing", "maintainer", "issue_fix", "enforcement", "trust", "ai_review", "spam_gate"],
  },
  {
    id: "strict-governance",
    name: "Strict Governance",
    description:
      "Maximum control for enterprise/regulated repos — dry-run mode, high thresholds, audit-first posture.",
    difficulty: "advanced",
    dry_run: true,
    safety: "dry-run-protected",
    safety_label: "Dry-run protected",
    pillars_active: ["triage", "ci_healing", "maintainer", "enforcement", "trust", "ai_review", "spam_gate"],
  },
];

// ── API ────────────────────────────────────────────────────────────────────

/**
 * List all available templates with metadata (no file content).
 * @returns {Promise<Array>} template metadata array
 */
export async function listTemplates() {
  return TEMPLATE_META.map((t) => ({ ...t }));
}

/**
 * Get a single template by ID, including the full YAML content.
 * @param {string} id — template id (e.g. "starter-dry-run")
 * @returns {Promise<{meta: object, content: string}>}
 */
export async function getTemplate(id) {
  // Reject any ID that isn't alphanumeric + hyphens — prevents path traversal
  if (!/^[a-z0-9-]+$/.test(id)) {
    const err = new Error(`Invalid template ID`);
    err.code = "NOT_FOUND";
    throw err;
  }

  const meta = TEMPLATE_META.find((t) => t.id === id);
  if (!meta) {
    const err = new Error(`Template not found: ${id}`);
    err.code = "NOT_FOUND";
    throw err;
  }

  // Use meta.id (validated from our allowlist) — NOT the raw input
  const filePath = path.join(TEMPLATES_DIR, `${meta.id}.yml`);
  const content = await fs.promises.readFile(filePath, "utf-8");

  return { meta, content };
}

/**
 * Get all templates with content (for bulk download/preview).
 * @returns {Promise<Array>} array of { ...meta, content }
 */
export async function getAllTemplates() {
  const results = [];
  for (const meta of TEMPLATE_META) {
    const filePath = path.join(TEMPLATES_DIR, `${meta.id}.yml`);
    const content = await fs.promises.readFile(filePath, "utf-8");
    results.push({ ...meta, content });
  }
  return results;
}
