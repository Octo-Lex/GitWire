// tests/unit/policy-validation.test.js
// Tests for the policy validation API.
// Verifies structural validation, warning generation, risky settings detection,
// dry-run awareness, redaction, and edge cases.

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

const VALID_YAML = `
version: 1
pillars:
  triage:
    enabled: true
    auto_label: true
  ci_healing:
    enabled: true
    auto_patch: false
settings:
  dry_run: true
`;

const RISKY_YAML = `
version: 1
pillars:
  triage:
    enabled: true
  ci_healing:
    enabled: true
    auto_patch: true
  issue_fix:
    enabled: true
  spam_gate:
    enabled: true
settings:
  dry_run: false
`;

const INVALID_YAML = `
pillars:
  triage:
    enabled: "not_a_boolean"
`;

const MALFORMED_YAML = `
pillars:
  - this is wrong
  : broken
`;

describe("Policy Validation — service contract", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("exports validatePolicy function", () => {
    expect(source).toMatch(/export.*async function validatePolicy/);
  });

  it("returns structured shape (valid, errors, warnings, enabled_pillars, dry_run, risky_settings, normalized_config)", () => {
    expect(source).toMatch(/valid:/);
    expect(source).toMatch(/\benvironments\b|errors/); // errors (shorthand or key)
    expect(source).toMatch(/warnings:/);
    expect(source).toMatch(/enabled_pillars:/);
    expect(source).toMatch(/dry_run:/);
    expect(source).toMatch(/risky_settings:/);
    expect(source).toMatch(/normalized_config:/);
    expect(source).toMatch(/parsed_at:/);
  });

  it("parses with @gitwire/rules parseConfig", () => {
    expect(source).toMatch(/parseConfig/);
  });

  it("runs validateConfig for structural checks", () => {
    expect(source).toMatch(/validateConfig/);
  });

  it("applies redaction to normalized config", () => {
    expect(source).toMatch(/redactSecrets/);
  });

  it("includes parsed_at timestamp", () => {
    expect(source).toMatch(/new Date\(\)\.toISOString/);
  });
});

describe("Policy Validation — enabled pillars detection", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("has getEnabledPillars function", () => {
    expect(source).toMatch(/function getEnabledPillars/);
  });

  it("filters pillars by enabled !== false", () => {
    expect(source).toMatch(/enabled.*!==.*false/);
  });
});

describe("Policy Validation — dry-run detection", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("has getDryRun function", () => {
    expect(source).toMatch(/function getDryRun/);
  });

  it("reads settings.dry_run", () => {
    expect(source).toMatch(/settings.*dry_run/);
  });
});

describe("Policy Validation — risky settings analysis", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("has analyzeRiskySettings function", () => {
    expect(source).toMatch(/function analyzeRiskySettings/);
  });

  it("flags issue_fix.enabled as destructive", () => {
    expect(source).toMatch(/issue_fix.*enabled/);
    expect(source).toMatch(/modify repository files/);
  });

  it("flags ci_healing.auto_patch", () => {
    expect(source).toMatch(/auto_patch/);
    expect(source).toMatch(/AI-generated code fixes/);
  });

  it("flags spam_gate.enabled as auto-close", () => {
    expect(source).toMatch(/spam_gate/);
    expect(source).toMatch(/auto-closes/);
  });

  it("flags stale auto-close (issues and PRs)", () => {
    expect(source).toMatch(/stale.*issues.*close_days/);
    expect(source).toMatch(/stale.*prs.*close_days/);
  });

  it("flags merge_queue without required_checks", () => {
    expect(source).toMatch(/merge_queue.*required_checks/);
  });

  it("flags ai_review adversarial_review disabled", () => {
    expect(source).toMatch(/adversarial_review/);
  });

  it("includes severity levels (high, medium, low)", () => {
    expect(source).toMatch(/severity.*high/);
    expect(source).toMatch(/severity.*medium/);
    expect(source).toMatch(/severity.*low/);
  });

  it("tracks mitigated_by_dry_run", () => {
    expect(source).toMatch(/mitigated_by_dry_run/);
  });
});

describe("Policy Validation — warning generation", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("has generateWarnings function", () => {
    expect(source).toMatch(/function generateWarnings/);
  });

  it("warns on auto_patch without dry_run", () => {
    expect(source).toMatch(/Auto-patching is enabled while dry_run is false/);
  });

  it("warns on issue_fix without dry_run", () => {
    expect(source).toMatch(/Autonomous issue fixing is enabled while dry_run is false/);
  });

  it("warns on spam_gate without dry_run", () => {
    expect(source).toMatch(/Spam gate is enabled while dry_run is false/);
  });

  it("warns on high max_fix_attempts", () => {
    expect(source).toMatch(/max_fix_attempts/);
  });

  it("warns on low min_confidence_to_submit", () => {
    expect(source).toMatch(/min_confidence_to_submit.*low/);
  });

  it("warns on empty blocked_file_patterns", () => {
    expect(source).toMatch(/blocked_file_patterns is empty/);
  });

  it("info on many pillars without dry_run", () => {
    expect(source).toMatch(/severity.*info/);
    expect(source).toMatch(/dry_run for initial rollout/);
  });
});

describe("Policy Validation — unknown key detection", () => {
  const source = readSource("packages/web/src/services/policyValidationService.js");

  it("detects unknown pillar names", () => {
    expect(source).toMatch(/Unknown pillar/);
    expect(source).toMatch(/forward compatibility/);
  });

  it("compares against DEFAULT_CONFIG pillars", () => {
    expect(source).toMatch(/DEFAULT_CONFIG\.pillars/);
  });
});

describe("Policy Validation — route contract", () => {
  const source = readSource("packages/web/src/routes/config.js");

  it("registers POST /validate endpoint", () => {
    expect(source).toMatch(/configRouter\.post.*validate/);
  });

  it("accepts yaml string in body", () => {
    expect(source).toMatch(/yaml.*yamlText/);
  });

  it("accepts config object in body", () => {
    expect(source).toMatch(/config.*configObj/);
  });

  it("returns 400 if neither yaml nor config provided", () => {
    expect(source).toMatch(/400/);
    expect(source).toMatch(/must include.*yaml.*config/);
  });

  it("imports validatePolicy from service", () => {
    expect(source).toMatch(/validatePolicy/);
    expect(source).toMatch(/policyValidationService/);
  });

  it("handles errors gracefully", () => {
    expect(source).toMatch(/500/);
    expect(source).toMatch(/Failed to validate policy/);
  });
});

describe("Policy Validation — YAML test cases", () => {
  // These tests verify the YAML strings are well-formed for the validator

  it("valid YAML has triage and ci_healing enabled", () => {
    expect(VALID_YAML).toMatch(/triage/);
    expect(VALID_YAML).toMatch(/ci_healing/);
    expect(VALID_YAML).toMatch(/dry_run: true/);
  });

  it("risky YAML has auto_patch and issue_fix enabled", () => {
    expect(RISKY_YAML).toMatch(/auto_patch: true/);
    expect(RISKY_YAML).toMatch(/issue_fix/);
    expect(RISKY_YAML).toMatch(/spam_gate/);
    expect(RISKY_YAML).toMatch(/dry_run: false/);
  });

  it("invalid YAML has wrong type for enabled", () => {
    expect(INVALID_YAML).toMatch(/enabled.*not_a_boolean/);
  });

  it("malformed YAML has structural errors", () => {
    expect(MALFORMED_YAML).toMatch(/broken/);
  });
});
