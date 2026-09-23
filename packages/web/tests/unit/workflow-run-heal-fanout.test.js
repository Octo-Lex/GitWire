// D0-01 — workflow_run fanout isolation around the CI-heal contract.

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const ciEvidenceAdd = jest.fn();
jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  ciEvidenceQueue: { add: ciEvidenceAdd },
}));

const { handleWorkflowRun } = await import("../../src/lib/webhookHandlers/handleWorkflowRun.js");

function payload(overrides = {}) {
  return {
    action: "completed",
    workflow_run: {
      id: 30123456789,
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      head_sha: "0123456789abcdef0123456789abcdef01234567",
      ...overrides.workflow_run,
    },
    repository: {
      id: 123456,
      full_name: "owner/repo",
      name: "repo",
      owner: { login: "owner" },
      ...overrides.repository,
    },
    installation: { id: 987654, ...overrides.installation },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["workflow_run", "repository", "installation"].includes(key))),
  };
}

function context() {
  return {
    ciHealQueue: { add: jest.fn(async () => ({ id: "heal-job" })) },
    phase2Queue: { add: jest.fn(async () => ({ id: "phase2-job" })) },
    phase3Queue: { add: jest.fn(async () => ({ id: "phase3-job" })) },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
}

beforeEach(() => {
  ciEvidenceAdd.mockReset();
  ciEvidenceAdd.mockResolvedValue({ id: "evidence-job" });
});

describe("workflow_run CI-heal dispatch isolation", () => {
  it("contains a heal-contract rejection and continues independent event consumers", async () => {
    const ctx = context();
    const invalid = payload({ workflow_run: { head_branch: undefined } });

    await expect(handleWorkflowRun(invalid, "delivery-invalid", ctx)).resolves.toBeUndefined();

    expect(ctx.ciHealQueue.add).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INVALID_CI_HEAL_JOB",
        runId: 30123456789,
        repo: "owner/repo",
        deliveryId: "delivery-invalid",
      }),
      "CI heal dispatch rejected invalid workflow_run contract",
    );
    expect(ciEvidenceAdd).toHaveBeenCalledTimes(1);
    expect(ctx.phase2Queue.add.mock.calls.map(([name]) => name)).toEqual(["checks-updated", "eval-rollback"]);
    expect(ctx.phase3Queue.add).toHaveBeenCalledWith(
      "ingest-test-results",
      expect.objectContaining({ run: invalid.workflow_run, repository: invalid.repository }),
      { priority: 3 },
    );
  });

  it("does not swallow queue/infrastructure failure as a contract rejection", async () => {
    const ctx = context();
    const queueFailure = new Error("queue unavailable");
    ctx.ciHealQueue.add.mockRejectedValueOnce(queueFailure);

    await expect(handleWorkflowRun(payload(), "delivery-queue-fail", ctx)).rejects.toBe(queueFailure);

    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_CI_HEAL_JOB" }),
      expect.any(String),
    );
    expect(ciEvidenceAdd).not.toHaveBeenCalled();
    expect(ctx.phase2Queue.add).not.toHaveBeenCalled();
    expect(ctx.phase3Queue.add).not.toHaveBeenCalled();
  });

  it("keeps the valid failure path on the canonical heal contract before normal fanout", async () => {
    const ctx = context();
    const event = payload();

    await handleWorkflowRun(event, "delivery-valid", ctx);

    expect(ctx.ciHealQueue.add).toHaveBeenCalledTimes(1);
    expect(ctx.ciHealQueue.add.mock.calls[0][0]).toBe("heal-run");
    expect(ctx.ciHealQueue.add.mock.calls[0][1]).toEqual(expect.objectContaining({
      schema_version: 1,
      eventName: "workflow_run",
      payload: event,
      trigger: expect.objectContaining({ kind: "webhook", delivery_id: "delivery-valid" }),
    }));
    expect(ciEvidenceAdd).toHaveBeenCalledTimes(1);
    expect(ctx.phase2Queue.add).toHaveBeenCalledTimes(2);
    expect(ctx.phase3Queue.add).toHaveBeenCalledTimes(1);
  });
});
