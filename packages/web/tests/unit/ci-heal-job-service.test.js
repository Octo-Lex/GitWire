// D0-01 — canonical CI-heal producer contract.

import { describe, it, expect, jest } from "@jest/globals";
import {
  CI_HEAL_JOB_SCHEMA_VERSION,
  InvalidCIHealJobError,
  buildCIHealJobFromWebhook,
  buildCIHealJobFromManualRun,
  enqueueCIHealJob,
  validateCIHealJob,
} from "../../src/services/ciHealJobService.js";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");

function workflowRun(overrides = {}) {
  return {
    id: 30123456789,
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    head_commit: {
      message: "test commit",
      author: { username: "developer", name: "Developer" },
    },
    ...overrides,
  };
}

function repository(overrides = {}) {
  return {
    id: 123456,
    full_name: "owner/repo",
    name: "repo",
    owner: { login: "owner" },
    ...overrides,
  };
}

function webhookPayload(overrides = {}) {
  return {
    action: "completed",
    workflow_run: workflowRun(),
    repository: repository(),
    installation: { id: 987654 },
    sender: { login: "developer" },
    ...overrides,
  };
}

describe("CI heal job contract", () => {
  it("builds a canonical v1 job from a workflow_run webhook", () => {
    const payload = webhookPayload();
    const job = buildCIHealJobFromWebhook({
      payload,
      deliveryId: "delivery-123",
      receivedAt: NOW,
    });

    expect(job.schema_version).toBe(CI_HEAL_JOB_SCHEMA_VERSION);
    expect(job.eventName).toBe("workflow_run");
    expect(job.payload.workflow_run.id).toBe(payload.workflow_run.id);
    expect(job.payload.repository.full_name).toBe("owner/repo");
    expect(job.payload.installation.id).toBe(987654);
    expect(job.trigger).toMatchObject({
      kind: "webhook",
      delivery_id: "delivery-123",
      requested_at: "2026-09-23T12:00:00.000Z",
    });
  });

  it("builds the same worker payload shape for manual/API triggers", () => {
    const automatic = buildCIHealJobFromWebhook({
      payload: webhookPayload(),
      deliveryId: "delivery-123",
      receivedAt: NOW,
    });
    const manual = buildCIHealJobFromManualRun({
      workflowRun: workflowRun(),
      repository: repository(),
      installationId: 987654,
      receivedAt: NOW,
    });

    expect(Object.keys(manual.payload).sort()).toEqual(
      expect.arrayContaining(["action", "workflow_run", "repository", "installation"]),
    );
    expect(manual.payload.workflow_run).toEqual(automatic.payload.workflow_run);
    expect(manual.payload.repository).toEqual(automatic.payload.repository);
    expect(manual.payload.installation).toEqual(automatic.payload.installation);
    expect(manual.trigger.kind).toBe("manual_api");
  });

  it("accepts and preserves decimal-string IDs returned for PostgreSQL BIGINT columns", () => {
    const manual = buildCIHealJobFromManualRun({
      workflowRun: workflowRun(),
      repository: repository({ id: "123456" }),
      installationId: "987654",
      receivedAt: NOW,
    });

    expect(manual.payload.repository.id).toBe("123456");
    expect(manual.payload.installation.id).toBe("987654");
  });

  it("rejects unsafe numeric IDs instead of accepting precision-lost authority identifiers", () => {
    expect(() => buildCIHealJobFromManualRun({
      workflowRun: workflowRun(),
      repository: repository({ id: Number.MAX_SAFE_INTEGER + 1 }),
      installationId: 987654,
      receivedAt: NOW,
    })).toThrow(InvalidCIHealJobError);
  });

  it("rejects decimal-string IDs outside PostgreSQL BIGINT range", () => {
    expect(() => buildCIHealJobFromManualRun({
      workflowRun: workflowRun(),
      repository: repository({ id: "9223372036854775808" }),
      installationId: "987654",
      receivedAt: NOW,
    })).toThrow(InvalidCIHealJobError);
  });

  it("rejects a non-failed run instead of queueing work the healer must skip", () => {
    expect(() => buildCIHealJobFromManualRun({
      workflowRun: workflowRun({ conclusion: "success" }),
      repository: repository(),
      installationId: 987654,
      receivedAt: NOW,
    })).toThrow(InvalidCIHealJobError);
  });

  it("rejects malformed jobs with structured field paths", () => {
    try {
      validateCIHealJob({
        schema_version: 1,
        eventName: "workflow_run",
        payload: {
          action: "completed",
          workflow_run: workflowRun({ head_branch: undefined }),
          repository: repository(),
          installation: {},
        },
        receivedAt: NOW,
        trigger: { kind: "manual_api", requested_at: "2026-09-23T12:00:00.000Z" },
      });
      throw new Error("expected validation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidCIHealJobError);
      expect(err.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["payload.workflow_run.head_branch", "payload.installation.id"]),
      );
    }
  });

  it("validates at the queue producer boundary before adding heal-run", async () => {
    const queue = { add: jest.fn(async () => ({ id: "job-1" })) };
    const job = buildCIHealJobFromManualRun({
      workflowRun: workflowRun(),
      repository: repository(),
      installationId: 987654,
      receivedAt: NOW,
    });

    const result = await enqueueCIHealJob(queue, job, { priority: 1 });

    expect(result).toEqual({ id: "job-1" });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith("heal-run", job, { priority: 1 });
  });

  it("does not touch the queue when validation fails", async () => {
    const queue = { add: jest.fn() };

    await expect(enqueueCIHealJob(queue, { schema_version: 1 })).rejects.toBeInstanceOf(InvalidCIHealJobError);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
