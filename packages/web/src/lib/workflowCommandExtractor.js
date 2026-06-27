// src/lib/workflowCommandExtractor.js
//
// Repo-aware validation command extractor (Task 8D).
//
// PURE — no I/O. Given the textual content of a GitHub Actions workflow YAML
// and the name of the failed job, derives a list of safe, repo-aware command
// descriptors. These descriptors replace the fixed `lint → npm run lint --`
// template that validated the GitWire baseline instead of the healed repo.
//
// Extraction rules (v1 — deliberately narrow):
//   - Only `eslint`, `tsc`, and `node <script>` invocations are extracted.
//   - `npm run <x>` is NEVER extracted as a descriptor — it executes shell
//     strings from package.json and stays a legacy fallback only.
//   - `npx` is normalized to force `--no-install` immediately after the binary
//     (network is disabled in the validator sandbox).
//   - target_paths are the EXPLICIT relative file arguments in the command.
//     Glob patterns (`*`), `.`, absolute paths, and `..` segments cause the
//     command to be REJECTED (returned as a shape-invalid descriptor so the
//     failure is visible, never silently dropped).
//
// Job matching (Amendment 5 — conservative):
//   1. exact YAML job-id match
//   2. exact displayed job-name match
//   3. single-job workflow fallback
//   4. otherwise → no descriptor (caller falls back to legacy)

import { parse as parseYaml } from "yaml";

// semantic_id derived from the tool kind.
const TOOL_SEMANTIC = {
  eslint: "lint_result",
  tsc: "typecheck_result",
  node: "test_or_build_result",
};

// command_id derived from the tool kind (prefixed repo_ to distinguish from
// the legacy fixed `lint`/`test`/`build` IDs).
const TOOL_COMMAND_ID = {
  eslint: "repo_lint",
  tsc: "repo_typecheck",
  node: "repo_node_script",
};

// Maximum number of steps to scan per job (defensive bound).
const MAX_STEPS_PER_JOB = 50;

/**
 * Extract repo-aware validation commands from a workflow YAML.
 *
 * @param {string} yamlContent - raw workflow file content
 * @param {{failedJobName?: string, failedJobId?: string}} [opts]
 * @returns {Array<object>} list of descriptor candidates (valid or shape-invalid).
 *   Empty array when no safe command can be derived.
 */
export function extractValidationCommands(yamlContent, opts = {}) {
  if (typeof yamlContent !== "string" || yamlContent.length === 0) {
    return [];
  }

  let workflow;
  try {
    workflow = parseYaml(yamlContent);
  } catch {
    // Unparseable workflow → cannot derive a safe command.
    return [];
  }
  if (!workflow || typeof workflow !== "object" || !workflow.jobs) {
    return [];
  }

  const jobIds = Object.keys(workflow.jobs);
  if (jobIds.length === 0) {
    return [];
  }

  // ── Conservative job matching (Amendment 5) ────────────────────────────
  let targetJob = null;

  // 1. exact job-id match
  if (opts.failedJobId && workflow.jobs[opts.failedJobId]) {
    targetJob = workflow.jobs[opts.failedJobId];
  }
  // 2. exact displayed job-name match
  if (!targetJob && opts.failedJobName) {
    for (const id of jobIds) {
      if (workflow.jobs[id].name === opts.failedJobName) {
        targetJob = workflow.jobs[id];
        break;
      }
    }
  }
  // 3. single-job workflow fallback
  if (!targetJob && jobIds.length === 1) {
    targetJob = workflow.jobs[jobIds[0]];
  }
  // 4. otherwise → no descriptor
  if (!targetJob) {
    return [];
  }

  const steps = Array.isArray(targetJob.steps) ? targetJob.steps.slice(0, MAX_STEPS_PER_JOB) : [];
  const descriptors = [];

  for (const step of steps) {
    const run = step && typeof step.run === "string" ? step.run.trim() : "";
    if (!run) continue;

    const d = compileStepToDescriptor(run);
    if (d) {
      descriptors.push(d);
    }
  }

  return descriptors;
}

/**
 * Compile a single `run:` step string into a descriptor candidate.
 *
 * Only the first command line of a multi-line `run:` is considered (a `run:`
 * block can chain shell commands; v1 only trusts a single, simple invocation).
 *
 * @param {string} runLine
 * @returns {object|null} descriptor, or null if the line is not a recognized
 *   safe command.
 */
function compileStepToDescriptor(runLine) {
  // Take the first non-empty, non-comment line.
  const firstLine = runLine.split(/\r?\n/)[0].trim();
  if (!firstLine || firstLine.startsWith("#")) return null;

  // Reject anything containing shell control operators — only a single simple
  // invocation is allowed. This catches `cmd && cmd`, pipes, redirects, etc.
  if (/[;&|<>]/.test(firstLine)) return null;

  // Tokenize on whitespace. (No shell quoting support in v1 — only simple
  // space-separated argv. Quoted arguments with spaces are out of scope.)
  const tokens = firstLine.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const binary = tokens[0];

  // Resolve the actual tool + rest-of-argv for the recognized forms.
  let tool = null;
  let argv = [];

  if (binary === "npx") {
    // npx <pkg> [args...]  → force --no-install right after npx.
    // Find the package name (skip flags like --yes/-y).
    let i = 1;
    let pkgName = null;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === "--yes" || t === "-y") { i++; continue; }
      pkgName = t; i++; break;
    }
    if (!pkgName) return null;
    if (!TOOL_SEMANTIC[pkgName]) return null; // only eslint/tsc via npx
    tool = pkgName;
    const rest = tokens.slice(i);
    argv = ["npx", "--no-install", pkgName, ...rest];
  } else if (binary === "eslint" || binary === "tsc" || binary === "node") {
    tool = binary;
    argv = [binary, ...tokens.slice(1)];
  } else {
    // Unrecognized binary (includes `npm`) → not a descriptor.
    return null;
  }

  // ── Derive target_paths from the file arguments ───────────────────────
  // For eslint/tsc/node, file arguments are the non-flag tokens after the
  // binary (and after the package name for npx).
  const fileArgs = extractFileArgs(argv, tool);

  // Validate target paths: explicit relative files only.
  const pathCheck = validateTargetPaths(fileArgs);
  if (!pathCheck.ok) {
    // Return a shape-invalid descriptor so the failure is VISIBLE (never
    // silently dropped). The executor-service will reject it.
    return {
      command_id: TOOL_COMMAND_ID[tool],
      semantic_id: TOOL_SEMANTIC[tool],
      source: "ci_workflow",
      policy_status: "shape_invalid",
      shape_reasons: pathCheck.reasons,
    };
  }

  return {
    command_id: TOOL_COMMAND_ID[tool],
    semantic_id: TOOL_SEMANTIC[tool],
    source: "ci_workflow",
    argv,
    target_paths: fileArgs,
    network: "disabled",
    requires_shell: false,
    policy_status: "pending_executor_validation",
  };
}

/**
 * Extract explicit file-path arguments from an argv, skipping flags.
 * @param {string[]} argv
 * @param {string} tool
 * @returns {string[]}
 */
function extractFileArgs(argv, tool) {
  // Start scanning AFTER the tool invocation prefix.
  // For npx: ["npx","--no-install",<pkg>, ...args]
  // For eslint/tsc/node: [binary, ...args]
  let start;
  if (argv[0] === "npx") {
    // npx --no-install <pkg> → args start at index 3
    start = 3;
  } else {
    start = 1;
  }
  const files = [];
  for (let i = start; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("-")) continue; // flag
    files.push(t);
  }
  return files;
}

/**
 * Validate that target paths are explicit relative files.
 * Rejects: empty, `.`, `..` segments, glob `*`, absolute paths.
 *
 * @param {string[]} paths
 * @returns {{ok: boolean, reasons: string[]}}
 */
function validateTargetPaths(paths) {
  const reasons = [];
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, reasons: ["target_paths must be non-empty (no file arguments)"] };
  }
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0) {
      reasons.push(`target_path must be a non-empty string: ${JSON.stringify(p)}`);
      continue;
    }
    if (p === "." || p === "..") {
      reasons.push(`target_path must be an explicit file, not "${p}"`);
    }
    if (p.includes("*") || p.includes("?")) {
      reasons.push(`target_path must not contain glob characters: ${p}`);
    }
    if (p.startsWith("/")) {
      reasons.push(`target_path must be relative, not absolute: ${p}`);
    }
    if (p.includes("..")) {
      reasons.push(`target_path must not contain traversal (..): ${p}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
