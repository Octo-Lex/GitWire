// @gitwire/rules — schema.js
// Default config and validation for .gitwire.yml.
//
// The DEFAULT_CONFIG applies when a repo has NO .gitwire.yml.
// Every pillar is enabled (or disabled) with conservative defaults.

export const DEFAULT_CONFIG = {
  version: 1,

  pillars: {
    triage: {
      enabled: true,
      auto_label: true,
      auto_comment: true,
      duplicate_detection: true,
    },

    ci_healing: {
      enabled: true,
      auto_patch: true,
      max_fix_attempts: 3,
      allowed_file_patterns: ["**"],
      blocked_file_patterns: [".env*", "secrets/**", "*.pem", "*.key"],
    },

    maintainer: {
      enabled: true,
      stale: {
        issues: {
          warn_days: 60,
          close_days: null, // null = warn only, never auto-close
          exempt_labels: ["pinned", "security"],
        },
        prs: {
          warn_days: 30,
          close_days: null,
          exempt_labels: ["pinned"],
        },
      },
      branch_cleanup: {
        enabled: true,
        protected_branches: ["main", "master", "develop"],
        min_age_days: 7,
      },
    },

    issue_fix: {
      enabled: false, // Opt-in only — autonomous fixes are destructive
      max_file_changes: 3,
      max_line_changes: 200,
      allowed_labels: [
        "bug",
        "good first issue",
        "help wanted",
        "enhancement",
        "documentation",
      ],
      blocked_paths: ["migrations/**", ".github/**", "db/**"],
    },

    enforcement: {
      enabled: true,
    },

    merge_queue: {
      enabled: false,
      required_checks: [],
    },

    ai_review: {
      enabled: true,
      comment_findings: true,
    },
  },

  settings: {
    dry_run: false,
  },
};

// Validate that a parsed config object has the expected shape.
// Returns { valid: true } or { valid: false, errors: string[] }.
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be an object"] };
  }

  if (config.version !== undefined && typeof config.version !== "number") {
    errors.push("version must be a number");
  }

  if (config.pillars !== undefined) {
    if (typeof config.pillars !== "object" || Array.isArray(config.pillars)) {
      errors.push("pillars must be an object");
    } else {
      const knownPillars = Object.keys(DEFAULT_CONFIG.pillars);
      for (const key of Object.keys(config.pillars)) {
        const pillar = config.pillars[key];
        if (typeof pillar !== "object" || Array.isArray(pillar)) {
          errors.push(`pillars.${key} must be an object`);
        }
        if (pillar?.enabled !== undefined && typeof pillar.enabled !== "boolean") {
          errors.push(`pillars.${key}.enabled must be a boolean`);
        }
      }
      // Unknown pillars are allowed for forward compatibility
    }
  }

  if (config.settings !== undefined) {
    if (typeof config.settings !== "object" || Array.isArray(config.settings)) {
      errors.push("settings must be an object");
    }
    if (config.settings?.dry_run !== undefined && typeof config.settings.dry_run !== "boolean") {
      errors.push("settings.dry_run must be a boolean");
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
