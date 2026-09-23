// src/services/issueFixJobService.js
// Canonical queue contract for Autonomous Contributor issue-fix work.
//
// D0-02 invariant: callers identify the target repository and issue; they never
// select the GitHub App installation used to execute the work. The command does
// carry the server-resolved installation id as an EXPECTED BINDING FENCE so a
// queued request cannot silently follow a repository transfer/reinstall. The
// worker always re-resolves the current installation from PostgreSQL and never
// uses this queued value as execution authority.
//
// Wave-2 auth infrastructure currently converts GitHub identifiers through
// JavaScript Number. This contract therefore accepts only positive safe-integer
// ids and fails closed above that range until W1 makes the substrate string-safe.

import { z } from "zod";

export const ISSUE_FIX_JOB_SCHEMA_VERSION = 1;
const JS_SAFE_ID_MAX = BigInt(Number.MAX_SAFE_INTEGER);

function isPositiveSafeIdString(value) {
  if (!/^[1-9]\d*$/.test(value)) return false;
  try {
    return BigInt(value) <= JS_SAFE_ID_MAX;
  } catch {
    return false;
  }
}

const githubIdSchema = z.union([
  z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
  z.string().refine(isPositiveSafeIdString, "must be a positive safe-integer identifier"),
]);

const repositoryTargetSchema = z.object({
  github_id: githubIdSchema,
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  // Non-authoritative snapshot used only to detect binding drift after enqueue.
  expected_installation_id: githubIdSchema,
}).strict();

const triggerSchema = z.object({
  kind: z.enum(["api", "comment_command"]),
  requested_at: z.string().min(1),
  requested_by_principal_id: z.string().min(1).optional(),
  requested_by_login: z.string().min(1).optional(),
}).strict();

export const issueFixJobSchema = z.object({
  schema_version: z.literal(ISSUE_FIX_JOB_SCHEMA_VERSION),
  repository: repositoryTargetSchema,
  issue_number: z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
  trigger: triggerSchema,
}).strict();

export class InvalidIssueFixJobError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "InvalidIssueFixJobError";
    this.code = "INVALID_ISSUE_FIX_JOB";
    this.issues = issues;
  }
}

export function validateIssueFixJob(jobData) {
  const parsed = issueFixJobSchema.safeParse(jobData);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new InvalidIssueFixJobError(
      "Invalid issue-fix job: " + issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      issues,
    );
  }
  return parsed.data;
}

export function parseIssueNumber(value) {
  const raw = String(value ?? "");
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function buildIssueFixJob({ repository, issueNumber, triggerKind, requestedByPrincipalId, requestedByLogin, requestedAt = Date.now() }) {
  return validateIssueFixJob({
    schema_version: ISSUE_FIX_JOB_SCHEMA_VERSION,
    repository: {
      github_id: repository.github_id,
      full_name: repository.full_name,
      expected_installation_id: repository.installation_id,
    },
    issue_number: issueNumber,
    trigger: {
      kind: triggerKind,
      requested_at: new Date(requestedAt).toISOString(),
      ...(requestedByPrincipalId ? { requested_by_principal_id: requestedByPrincipalId } : {}),
      ...(requestedByLogin ? { requested_by_login: requestedByLogin } : {}),
    },
  });
}

export async function enqueueIssueFixJob(queue, jobData, options = {}) {
  const validated = validateIssueFixJob(jobData);
  return queue.add("fix-issue", validated, options);
}
