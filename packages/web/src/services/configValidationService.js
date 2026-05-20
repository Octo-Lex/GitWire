// src/services/configValidationService.js
// Pre-flight config validation for files changed in a push event.
// Adapted for GitWire: octokit.request(), Anthropic proxy, no js-yaml dependency.

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { config } from "../../config/index.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

const CONFIG_PATTERNS = [
  { regex: /^\.github\/workflows\/[^/]+\.ya?ml$/i, type: "github_actions" },
  { regex: /^\.github\/[^/]+\.ya?ml$/i,            type: "github_config"  },
  { regex: /.*\.tf$/i,                              type: "terraform"      },
  { regex: /.*\.tfvars$/i,                          type: "terraform_vars" },
  { regex: /^.*\/?(docker-compose|compose)\.ya?ml$/i, type: "docker_compose" },
  { regex: /^\.?[^/]*\.ya?ml$/i,                   type: "yaml"           },
  { regex: /^.*package\.json$/,                     type: "package_json"   },
  { regex: /^.*tsconfig.*\.json$/,                  type: "tsconfig"       },
];

const CHECK_RUN_NAME = "GitWire Config Validation";

// ════════════════════════════════════════════════════════════════════════════
// Main entry: validate all config files in a push
// ════════════════════════════════════════════════════════════════════════════

export async function validatePushConfigs({ push, repository, octokit }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const sha    = push.after;
  const repoId = repository.id;

  const changedFiles = collectChangedFiles(push);
  const configFiles  = changedFiles.filter((f) => getFileType(f) !== null);

  if (!configFiles.length) {
    logger.debug({ repo: repository.full_name, sha: sha.slice(0,7) }, "Config validation: no config files changed");
    return { skipped: true };
  }

  logger.info({ repo: repository.full_name, sha: sha.slice(0,7), files: configFiles.length }, "Config validation: starting");

  // Create a pending GitHub Check Run
  const { data: checkRun } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner, repo,
    name:       CHECK_RUN_NAME,
    head_sha:   sha,
    status:     "in_progress",
    started_at: new Date().toISOString(),
  });

  const results = [];

  for (const filePath of configFiles) {
    const fileType = getFileType(filePath);
    let content = null;

    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner, repo, path: filePath, ref: sha,
      });
      if (data.encoding === "base64") {
        content = Buffer.from(data.content, "base64").toString("utf8");
      }
    } catch {
      logger.debug({ filePath }, "Config validation: file not readable, skipping");
      continue;
    }

    const result = await validateFile({ filePath, fileType, content });
    results.push(result);

    await db.query(
      `INSERT INTO config_validation_results
         (repo_id, commit_sha, file_path, file_type, valid, errors, warnings, check_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [repoId, sha, filePath, fileType, result.valid,
       JSON.stringify(result.errors), JSON.stringify(result.warnings), checkRun.id]
    );
  }

  // Update Check Run with final results
  const allValid    = results.every((r) => r.valid);
  const errorCount  = results.reduce((n, r) => n + r.errors.length, 0);
  const warnCount   = results.reduce((n, r) => n + r.warnings.length, 0);
  const invalidFiles = results.filter((r) => !r.valid);

  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner, repo,
    check_run_id:  checkRun.id,
    status:        "completed",
    conclusion:    allValid ? "success" : "failure",
    completed_at:  new Date().toISOString(),
    output: {
      title:   allValid
        ? "All " + results.length + " config files valid"
        : invalidFiles.length + " file" + (invalidFiles.length > 1 ? "s" : "") + " failed validation",
      summary: buildCheckSummary(results, errorCount, warnCount),
      text:    buildCheckDetails(results),
    },
  });

  if (!allValid) {
    await Events.configFailed(repoId, { metadata: { errorCount, warnCount, files: configFiles } });
  }

  logger.info(
    { repo: repository.full_name, sha: sha.slice(0,7), valid: allValid, errors: errorCount },
    "Config validation: complete"
  );

  return { results, valid: allValid, errorCount, warnCount };
}

// ════════════════════════════════════════════════════════════════════════════
// Per-file validation
// ════════════════════════════════════════════════════════════════════════════

async function validateFile({ filePath, fileType, content }) {
  switch (fileType) {
    case "github_actions": return validateGitHubActions(filePath, content);
    case "github_config":  return validateYAMLSyntax(filePath, content, "github_config");
    case "terraform":      return validateWithClaude(filePath, content, "terraform");
    case "docker_compose": return validateDockerCompose(filePath, content);
    case "package_json":   return validatePackageJson(filePath, content);
    case "tsconfig":       return validateJson(filePath, content, "tsconfig");
    default:               return validateYAMLSyntax(filePath, content, fileType);
  }
}

async function validateGitHubActions(filePath, content) {
  const errors   = [];
  const warnings = [];

  // Structural checks without parsing
  const lines = content.split("\n");

  // Basic YAML structure check
  const hasOn = /^on:/m.test(content) || /^on\s*:$/m.test(content) || /true:/m.test(content);
  const hasJobs = /^jobs:/m.test(content);

  if (!hasOn) {
    errors.push({ line: 1, col: 0, rule: "missing_trigger", message: "Workflow must have an 'on' trigger" });
  }
  if (!hasJobs) {
    errors.push({ line: 1, col: 0, rule: "missing_jobs", message: "Workflow must have a 'jobs' section" });
  }

  // Check for runs-on in job definitions
  const jobBlocks = content.match(/^\s{2}\S+:[\s\S]*?(?=^\s{2}\S+:|$)/gm) || [];
  for (const block of jobBlocks) {
    const jobMatch = block.match(/^\s{2}(\S+):/);
    if (!jobMatch) continue;
    const jobId = jobMatch[1];
    if (!/runs-on:/m.test(block) && !/uses:/m.test(block)) {
      errors.push({ rule: "missing_runs_on", message: "Job '" + jobId + "' is missing 'runs-on'" });
    }
    if (!/steps:/m.test(block)) {
      errors.push({ rule: "empty_steps", message: "Job '" + jobId + "' has no steps" });
    }
  }

  // Dangerous patterns
  if (/permissions:\s*write-all/m.test(content)) {
    warnings.push({ rule: "broad_permissions", message: "Workflow uses 'write-all' permissions - prefer minimal permissions" });
  }

  // Check for unpinned action refs
  const actionRefs = content.matchAll(/uses:\s*['"]?([^'"}\s]+@(\S+))['"]?/g) || [];
  for (const match of actionRefs) {
    const ref = match[2];
    if (/^(main|master|latest)$/i.test(ref)) {
      warnings.push({ rule: "unpinned_action", message: "Action '" + match[1] + "' uses a mutable ref '" + ref + "' - pin to a SHA or tag" });
    }
  }

  // Claude AI review if structural checks pass
  if (!errors.length && content.length < 6000) {
    const aiIssues = await reviewWithClaude(filePath, content, "github_actions");
    for (const issue of aiIssues) {
      if (issue.severity === "error") errors.push(issue);
      else                             warnings.push(issue);
    }
  }

  return { filePath, fileType: "github_actions", valid: errors.length === 0, errors, warnings };
}

async function validateDockerCompose(filePath, content) {
  const errors   = [];
  const warnings = [];
  const hasServices = /^services:/m.test(content);

  if (!hasServices) {
    errors.push({ rule: "missing_services", message: "docker-compose file must have a 'services' section" });
  }

  const imageMatches = content.matchAll(/(\w+):\s*\n[\s\S]*?image:\s*['"]?([^'"\n]+)['"]?/g) || [];
  for (const match of imageMatches) {
    if (match[2].endsWith(":latest")) {
      warnings.push({ rule: "latest_tag", message: "Service '" + match[1] + "' uses ':latest' tag - pin to a specific version" });
    }
  }

  return { filePath, fileType: "docker_compose", valid: errors.length === 0, errors, warnings };
}

async function validatePackageJson(filePath, content) {
  const errors   = [];
  const warnings = [];

  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) {
    return { filePath, fileType: "package_json", valid: false, errors: [{ rule: "json_syntax", message: e.message }], warnings: [] };
  }

  if (!parsed.name)    warnings.push({ rule: "missing_name",    message: "package.json is missing 'name'" });
  if (!parsed.version) warnings.push({ rule: "missing_version", message: "package.json is missing 'version'" });

  const allDeps = { ...parsed.dependencies, ...parsed.devDependencies };
  for (const [pkg, ver] of Object.entries(allDeps)) {
    if (ver === "*" || ver === "latest") {
      warnings.push({ rule: "unpinned_dependency", message: "Dependency '" + pkg + "' is unpinned ('" + ver + "')" });
    }
  }

  return { filePath, fileType: "package_json", valid: errors.length === 0, errors, warnings };
}

async function validateYAMLSyntax(filePath, content, fileType) {
  // Basic structural checks (no js-yaml dependency)
  if (/^\t/m.test(content)) {
    const line = content.split("\n").findIndex((l) => l.startsWith("\t")) + 1;
    return {
      filePath, fileType, valid: false,
      errors: [{ line, rule: "yaml_syntax", message: "YAML files must use spaces for indentation, not tabs" }],
      warnings: [],
    };
  }
  return { filePath, fileType, valid: true, errors: [], warnings: [] };
}

async function validateJson(filePath, content, fileType) {
  try { JSON.parse(content); return { filePath, fileType, valid: true, errors: [], warnings: [] }; }
  catch (e) { return { filePath, fileType, valid: false, errors: [{ rule: "json_syntax", message: e.message }], warnings: [] }; }
}

async function validateWithClaude(filePath, content, fileType) {
  const errors = [];
  const warnings = [];
  const aiIssues = await reviewWithClaude(filePath, content, fileType);
  for (const issue of aiIssues) {
    if (issue.severity === "error") errors.push(issue);
    else                             warnings.push(issue);
  }
  return { filePath, fileType, valid: errors.length === 0, errors, warnings };
}

// ── Claude AI review ──────────────────────────────────────────────────────────
async function reviewWithClaude(filePath, content, fileType) {
  const typeDescriptions = {
    github_actions: "GitHub Actions workflow YAML",
    terraform:      "Terraform HCL configuration",
    docker_compose: "Docker Compose file",
  };

  try {
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system:     "You are a DevOps config validation expert. Return ONLY a JSON array of issues, no explanation.",
      messages: [{
        role: "user",
        content: "Review this " + (typeDescriptions[fileType] ?? fileType) + " file for errors, anti-patterns, and security issues.\n\nFile: " + filePath + "\n```\n" + content.slice(0, 4000) + "\n```\n\nReturn a JSON array of issues (empty array if none):\n[\n  {\n    \"severity\": \"error\" | \"warning\",\n    \"rule\": \"short_rule_id\",\n    \"line\": <number or null>,\n    \"message\": \"concise description of the problem\"\n  }\n]\n\nFocus on: syntax errors, missing required fields, security anti-patterns, deprecated syntax, logic errors.\nDo NOT report style preferences or minor formatting issues.",
      }],
    });

    const text  = message.content[0].text.trim();
    const clean = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.debug({ filePath, err: err.message }, "Config validation: Claude review failed, skipping");
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Check run output builders
// ════════════════════════════════════════════════════════════════════════════

function buildCheckSummary(results, errorCount, warnCount) {
  const lines = ["Validated **" + results.length + "** config file" + (results.length !== 1 ? "s" : "") + ".", ""];
  if (errorCount)  lines.push("**" + errorCount + "** error" + (errorCount !== 1 ? "s" : "") + " found");
  if (warnCount)   lines.push("**" + warnCount + "** warning" + (warnCount !== 1 ? "s" : ""));
  if (!errorCount && !warnCount) lines.push("No issues found");
  return lines.join("\n");
}

function buildCheckDetails(results) {
  const sections = [];
  for (const r of results) {
    if (!r.errors.length && !r.warnings.length) continue;
    sections.push("### `" + r.filePath + "`");
    for (const e of r.errors) {
      sections.push("- **[" + e.rule + "]** " + e.message + (e.line ? " _(line " + e.line + ")_" : ""));
    }
    for (const w of r.warnings) {
      sections.push("- **[" + w.rule + "]** " + w.message + (w.line ? " _(line " + w.line + ")_" : ""));
    }
    sections.push("");
  }
  return sections.join("\n") || "All config files passed validation.";
}

// ════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════

function collectChangedFiles(push) {
  const files = new Set();
  for (const commit of push.commits ?? []) {
    (commit.added    ?? []).forEach((f) => files.add(f));
    (commit.modified ?? []).forEach((f) => files.add(f));
  }
  return [...files];
}

export function getFileType(filePath) {
  for (const { regex, type } of CONFIG_PATTERNS) {
    if (regex.test(filePath)) return type;
  }
  return null;
}
