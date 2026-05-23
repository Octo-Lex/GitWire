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
      triggers: {
        branches: [],           // empty = all branches
        ignore_authors: [],     // glob patterns for authors to skip
        paths: [],              // empty = all paths
      },
    },

    ci_healing: {
      enabled: true,
      auto_patch: true,
      max_fix_attempts: 3,
      min_confidence_to_patch: "medium", // low | medium | high — patches below this are comment-only
      allowed_file_patterns: ["**"],
      blocked_file_patterns: [".env*", "secrets/**", "*.pem", "*.key"],
      triggers: {
        branches: [],
        ignore_authors: [],
      },
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
      min_confidence_to_submit: "medium", // low | medium | high — PRs below this are rejected
      allowed_labels: [
        "bug",
        "good first issue",
        "help wanted",
        "enhancement",
        "documentation",
      ],
      blocked_paths: ["migrations/**", ".github/**", "db/**"],
      triggers: {
        branches: [],
        ignore_authors: [],
      },
    },

    enforcement: {
      enabled: true,
    },

    trust: {
      enabled: true,
      flaky_test_detection: true,
      dependency_scanning: true,
    },

    merge_queue: {
      enabled: false,
      required_checks: [],
      triggers: {
        branches: [],
        ignore_authors: [],
      },
    },

    ai_review: {
      enabled: true,
      comment_findings: true,
      triggers: {
        branches: [],
        ignore_authors: [],
        paths: [],
      },
    },
  },

  settings: {
    dry_run: false,
  },

  // Named reusable expressions
  expressions: {},

  // Custom automation rules
  custom_rules: {},

  // Quality gates — metric thresholds evaluated on PRs
  quality_gates: {
    default: {
      conditions: [
        { metric: "ci_failure_rate_7d", operator: "<", threshold: 0.3 },
        { metric: "triage_coverage", operator: ">=", threshold: 0.5 },
        { metric: "readiness_score", operator: ">=", threshold: 40 },
      ],
      block_on_fail: true,
    },
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

  // Validate custom_rules if present
  if (config.custom_rules !== undefined) {
    if (typeof config.custom_rules !== "object" || Array.isArray(config.custom_rules)) {
      errors.push("custom_rules must be an object");
    } else {
      for (const [ruleName, rule] of Object.entries(config.custom_rules)) {
        if (typeof rule !== "object" || Array.isArray(rule)) {
          errors.push(`custom_rules.${ruleName} must be an object`);
          continue;
        }
        if (typeof rule.if !== "string") {
          errors.push(`custom_rules.${ruleName}.if must be a string expression`);
        }
        if (!Array.isArray(rule.run)) {
          errors.push(`custom_rules.${ruleName}.run must be an array of actions`);
        }
      }
    }
  }

  // Validate expressions if present
  if (config.expressions !== undefined) {
    if (typeof config.expressions !== "object" || Array.isArray(config.expressions)) {
      errors.push("expressions must be an object");
    }
  }

  // Validate quality_gates if present
  if (config.quality_gates !== undefined) {
    if (typeof config.quality_gates !== "object" || Array.isArray(config.quality_gates)) {
      errors.push("quality_gates must be an object");
    } else {
      const VALID_OPERATORS = ["<", "<=", ">", ">=", "==", "!="];
      for (const [gateName, gate] of Object.entries(config.quality_gates)) {
        if (typeof gate !== "object" || Array.isArray(gate)) {
          errors.push("quality_gates." + gateName + " must be an object");
          continue;
        }
        if (!Array.isArray(gate.conditions)) {
          errors.push("quality_gates." + gateName + ".conditions must be an array");
        } else {
          for (let i = 0; i < gate.conditions.length; i++) {
            const cond = gate.conditions[i];
            if (typeof cond.metric !== "string") {
              errors.push("quality_gates." + gateName + ".conditions[" + i + "].metric must be a string");
            }
            if (!VALID_OPERATORS.includes(cond.operator)) {
              errors.push("quality_gates." + gateName + ".conditions[" + i + "].operator must be one of: " + VALID_OPERATORS.join(", "));
            }
            if (typeof cond.threshold !== "number") {
              errors.push("quality_gates." + gateName + ".conditions[" + i + "].threshold must be a number");
            }
          }
        }
        if (gate.block_on_fail !== undefined && typeof gate.block_on_fail !== "boolean") {
          errors.push("quality_gates." + gateName + ".block_on_fail must be a boolean");
        }
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
