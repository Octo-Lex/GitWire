// Tests for the ci_workflow_command evidence emission (Task 8D).
//
// Verifies that collectEvidenceRefs fetches the workflow YAML pinned to
// head_sha, extracts a repo-aware command descriptor, and freezes it into a
// ci_workflow_command evidence ref with the required provenance fields.

import { describe, it, expect } from "@jest/globals";
import { setConfig } from "@gitwire/runtime/compat/_init.js";

// collectEvidenceRefs() uses the runtime logger (logger.warn on the non-fatal
// fetch-failure path). setConfig() with LOG_LEVEL silent is the established
// pattern (see tests/unit/sandbox-runner-validator-fields.test.js).
setConfig({
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgresql://localhost/gitops_hub",
  GITHUB_APP_ID: "test",
  GITHUB_PRIVATE_KEY: "test",
});

import { collectEvidenceRefs, CI_EVIDENCE_TYPES } from "../../src/services/ciEvidenceCollectorService.js";

const HEAD_SHA = "8899bb8e5258aabcc1234567";
const WORKFLOW_PATH = ".github/workflows/demo-ci.yml";
const WORKFLOW_BLOB_SHA = "blobsha123";

// MyShell-style workflow: `npx eslint app.js`
const WORKFLOW_YAML = `
name: CI
on: [push]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint
        run: npx eslint app.js
`;

function makeOctokit({ workflowContent = WORKFLOW_YAML, contentsOk = true, jobs = null } = {}) {
  const calls = [];
  const failedJobs = jobs || [
    { id: 901, name: "lint", conclusion: "failure", started_at: "t1", completed_at: "t2" },
  ];
  return {
    _calls: calls,
    async request(route, params) {
      calls.push({ route, params });
      if (route.includes("/actions/runs/{run_id}/jobs")) {
        return { data: { jobs: failedJobs } };
      }
      if (route.includes("/actions/jobs/{job_id}/logs")) {
        return { data: "log body" };
      }
      if (route.includes("/contents/{path}")) {
        if (!contentsOk) {
          const e = new Error("not found");
          e.status = 404;
          throw e;
        }
        return {
          data: {
            content: Buffer.from(workflowContent).toString("base64"),
            sha: WORKFLOW_BLOB_SHA,
          },
        };
      }
      throw new Error("unexpected request: " + route);
    },
  };
}

describe("collectEvidenceRefs — ci_workflow_command emission", () => {
  it("emits a ci_workflow_command ref with descriptor frozen from workflow YAML", async () => {
    const octokit = makeOctokit();
    const { evidence_refs } = await collectEvidenceRefs(octokit, {
      repoFullName: "owner/repo",
      runId: 42,
      headSha: HEAD_SHA,
      workflowPath: WORKFLOW_PATH,
    });

    const cmdRef = evidence_refs.find(r => r.type === "ci_workflow_command");
    expect(cmdRef).toBeDefined();
    expect(cmdRef.workflow_path).toBe(WORKFLOW_PATH);
    expect(cmdRef.workflow_ref).toBe(HEAD_SHA);
    expect(cmdRef.workflow_blob_sha).toBe(WORKFLOW_BLOB_SHA);
    expect(cmdRef.descriptor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cmdRef.descriptor.command_id).toBe("repo_lint");
    expect(cmdRef.descriptor.argv).toEqual(["npx", "--no-install", "eslint", "app.js"]);
    expect(cmdRef.descriptor.target_paths).toEqual(["app.js"]);
  });

  it("fetches the workflow YAML pinned to head_sha (ref param)", async () => {
    const octokit = makeOctokit();
    await collectEvidenceRefs(octokit, {
      repoFullName: "owner/repo",
      runId: 42,
      headSha: HEAD_SHA,
      workflowPath: WORKFLOW_PATH,
    });
    const contentsCall = octokit._calls.find(c => c.route.includes("/contents/{path}"));
    expect(contentsCall).toBeDefined();
    expect(contentsCall.params.ref).toBe(HEAD_SHA);
    expect(contentsCall.params.path).toBe(WORKFLOW_PATH);
  });

  it("does NOT emit ci_workflow_command when the YAML fetch fails (non-fatal)", async () => {
    const octokit = makeOctokit({ contentsOk: false });
    const { evidence_refs } = await collectEvidenceRefs(octokit, {
      repoFullName: "owner/repo",
      runId: 42,
      headSha: HEAD_SHA,
      workflowPath: WORKFLOW_PATH,
    });
    expect(evidence_refs.find(r => r.type === "ci_workflow_command")).toBeUndefined();
    // Other evidence still collected.
    expect(evidence_refs.some(r => r.type === "workflow_file")).toBe(true);
  });

  it("does not emit when no workflowPath is provided", async () => {
    const octokit = makeOctokit();
    const { evidence_refs } = await collectEvidenceRefs(octokit, {
      repoFullName: "owner/repo",
      runId: 42,
      headSha: HEAD_SHA,
      workflowPath: null,
    });
    expect(evidence_refs.find(r => r.type === "ci_workflow_command")).toBeUndefined();
  });

  it("does not emit when the workflow has no extractable safe command", async () => {
    const yaml = `
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`;
    const octokit = makeOctokit({ workflowContent: yaml });
    const { evidence_refs } = await collectEvidenceRefs(octokit, {
      repoFullName: "owner/repo",
      runId: 42,
      headSha: HEAD_SHA,
      workflowPath: WORKFLOW_PATH,
    });
    expect(evidence_refs.find(r => r.type === "ci_workflow_command")).toBeUndefined();
  });

  it("registers ci_workflow_command in CI_EVIDENCE_TYPES", () => {
    expect(CI_EVIDENCE_TYPES.has("ci_workflow_command")).toBe(true);
  });
});
