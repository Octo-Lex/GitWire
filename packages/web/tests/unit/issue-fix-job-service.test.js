// D0-02 — canonical Autonomous Contributor queue contract.

import { describe, it, expect, jest } from "@jest/globals";
import {
  ISSUE_FIX_JOB_SCHEMA_VERSION,
  InvalidIssueFixJobError,
  buildIssueFixJob,
  parseIssueNumber,
  validateIssueFixJob,
  enqueueIssueFixJob,
} from "../../src/services/issueFixJobService.js";

const repository = {
  github_id: "9007199254740991",
  installation_id: "77",
  full_name: "octo/repo",
  owner: "octo",
  name: "repo",
};

describe("IssueFixJobV1", () => {
  it("carries stable repository identity but never installation authority", () => {
    const job = buildIssueFixJob({
      repository,
      issueNumber: 42,
      triggerKind: "api",
      requestedByPrincipalId: "principal-1",
      requestedAt: 0,
    });

    expect(job).toEqual({
      schema_version: ISSUE_FIX_JOB_SCHEMA_VERSION,
      repository: { github_id: "9007199254740991", full_name: "octo/repo" },
      issue_number: 42,
      trigger: {
        kind: "api",
        requested_at: new Date(0).toISOString(),
        requested_by_principal_id: "principal-1",
      },
    });
    expect(JSON.stringify(job)).not.toContain("installation");
  });

  it("rejects legacy caller-selected installation fields", () => {
    expect(() => validateIssueFixJob({
      schema_version: 1,
      repository: { github_id: "42", full_name: "octo/repo" },
      issue_number: 7,
      trigger: { kind: "api", requested_at: new Date(0).toISOString() },
      installationId: 123,
    })).toThrow(InvalidIssueFixJobError);
  });

  it("fails closed above the current auth substrate safe-integer range", () => {
    expect(() => validateIssueFixJob({
      schema_version: 1,
      repository: { github_id: "9007199254740992", full_name: "octo/repo" },
      issue_number: 7,
      trigger: { kind: "comment_command", requested_at: new Date(0).toISOString() },
    })).toThrow(InvalidIssueFixJobError);
  });

  it("validates issue numbers strictly", () => {
    expect(parseIssueNumber("42")).toBe(42);
    for (const value of ["0", "-1", "1x", "", "9007199254740992"]) {
      expect(parseIssueNumber(value)).toBeNull();
    }
  });

  it("validates again at enqueue boundary", async () => {
    const queue = { add: jest.fn().mockResolvedValue({ id: "j1" }) };
    const valid = buildIssueFixJob({ repository, issueNumber: 42, triggerKind: "api", requestedAt: 0 });
    await enqueueIssueFixJob(queue, valid, { priority: 1 });
    expect(queue.add).toHaveBeenCalledWith("fix-issue", valid, { priority: 1 });

    await expect(enqueueIssueFixJob(queue, { repo: "octo/repo", installationId: 5 }, {}))
      .rejects.toThrow(InvalidIssueFixJobError);
  });
});
