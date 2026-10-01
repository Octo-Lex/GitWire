// @gitwire/rules — schema.js
// Default config and validation for .gitwire.yml.
//
// W2-04 safe defaults: DEFAULT_CONFIG is enrollment-safe. A repository with
// no organization config, no repository config, and no governed override
// cannot produce a GitWire mutation solely because it was enrolled —
// dry-run is on and every mutation-capable pillar is disabled until a layer
// explicitly enables it.

// Stable identity of the built-in defaults. Part of the configuration
// version vector; change it whenever DEFAULT_CONFIG semantics change.
export const CONFIG_SCHEMA_VERSION = "w2-04.1";

export const DEFAULT_CONFIG = {
  version: 1,

  pillars: {
    triage: {
      // W2-04 safe default: mutation-capable pillars start disabled; a layer
      // (org config, repo config, governed promotion) must explicitly enable.
      enabled: false,
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
      enabled: false,
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
      enabled: false,
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
      enabled: false,
    },

    trust: {
      enabled: false,
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
      enabled: false,
      comment_findings: true,
      // Review engine ("claude" default; future: "codex", "openai")
      engine: "claude",
      // Claude model to use for reviews
      model: "claude-sonnet-4-20250514",
      // Hard timeout for a single review call (seconds)
      max_duration_seconds: 300,
      // Maximum bundle size (chars) before truncation
      bundle_max_chars: 180000,
      // Reject findings about files not in the diff
      require_file_scope: true,
      // Devil's Advocate: second pass to challenge findings (drops false positives)
      adversarial_review: true,
      // Cheaper model for adversarial challenge pass
      adversarial_model: "claude-haiku-4-20250414",
      triggers: {
        branches: [],
        ignore_authors: [],
        paths: [],
      },
    },

    spam_gate: {
      enabled: false,  // opt-in — auto-closes items
      max_open_prs: 10,       // auto-close PR if author has more open
      max_open_issues: 15,    // auto-close issue if author has more open
      exempt_users: [],        // always allow these usernames
      exempt_labels: ["pinned", "security"],  // don't close items with these labels
      close_message: "Automatically closed: too many open items from this author. Contact maintainers if this is a mistake.",
    },
  },

  settings: {
    // W2-04 safe default: dry-run until a layer explicitly goes live.
    dry_run: true,
    // On release.published, close issues that were fixed by GitWire PRs
    // Safe default: issue-close behavior is a mutation — opt in explicitly.
    release_close_fixed_issues: false,
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
//
// Prototype-pollution guard: documents carrying __proto__/constructor/
// prototype keys at ANY depth are invalid.
// Plain-assignment merges treat
// those keys as prototype setters rather than own properties, so accepting
// them would let repository/org YAML mutate Object.prototype process-wide.
// Keys that plain-assignment merges treat as prototype setters rather than
// own properties. Deliberately NOT exported: a mutable exported Set would be
// a public in-process lever to weaken both defenses (the package supports
// subpath imports). Consumers get the immutable predicate below.
const DANGEROUS_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Immutable predicate over the private dangerous-key denylist. */
export function isDangerousConfigKey(key) {
  return DANGEROUS_CONFIG_KEYS.has(key);
}

// Iterative, depth-independent traversal: the validator rejects dangerous
// keys at ANY nesting level (an explicit stack replaces recursion, so deep
// documents cannot slip past a frame limit and cannot overflow the stack).
function containsDangerousKey(root) {
  if (root === null || typeof root !== "object") return false;
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") stack.push(item);
      }
      continue;
    }
    for (const key of Object.keys(value)) {
      if (isDangerousConfigKey(key)) return true;
      const child = value[key];
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
  return false;
}

export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be an object"] };
  }

  if (containsDangerousKey(config)) {
    errors.push("config must not contain __proto__, constructor, or prototype keys");
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

      // Validate ai_review-specific fields
      if (config.pillars.ai_review) {
        const ar = config.pillars.ai_review;
        if (ar.engine !== undefined && typeof ar.engine !== "string") {
          errors.push("pillars.ai_review.engine must be a string");
        }
        if (ar.model !== undefined && typeof ar.model !== "string") {
          errors.push("pillars.ai_review.model must be a string");
        }
        if (ar.max_duration_seconds !== undefined && typeof ar.max_duration_seconds !== "number") {
          errors.push("pillars.ai_review.max_duration_seconds must be a number");
        }
        if (ar.bundle_max_chars !== undefined && typeof ar.bundle_max_chars !== "number") {
          errors.push("pillars.ai_review.bundle_max_chars must be a number");
        }
        if (ar.require_file_scope !== undefined && typeof ar.require_file_scope !== "boolean") {
          errors.push("pillars.ai_review.require_file_scope must be a boolean");
        }
      }
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
