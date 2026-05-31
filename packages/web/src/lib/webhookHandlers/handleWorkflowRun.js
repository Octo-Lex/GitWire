// src/lib/webhookHandlers/handleWorkflowRun.js
// Handler for "workflow_run" webhook events.
// CI failures → healing queue, all completions → merge queue + rollback eval + test ingestion.

export async function handleWorkflowRun(payload, deliveryId, ctx) {
  if (payload.action !== "completed") return;

  const jobData = { eventName: "workflow_run", payload, deliveryId, receivedAt: Date.now() };

  // Failed CI → heal queue
  if (payload.workflow_run?.conclusion === "failure") {
    await ctx.ciHealQueue.add("heal-run", jobData, { priority: 1 });
    ctx.logger.info(
      { runId: payload.workflow_run?.id, repo: payload.repository?.full_name },
      "Failed CI run queued for healing"
    );
  }

  // Phase 2: notify merge queue of check completion
  await ctx.phase2Queue.add("checks-updated", jobData, { priority: 1 });

  // Phase 2: post-merge deploy failure → rollback evaluation
  await ctx.phase2Queue.add("eval-rollback", jobData, { priority: 1 });

  // Phase 3: ingest test results for flakiness detection
  if (payload.workflow_run?.conclusion === "success" || payload.workflow_run?.conclusion === "failure") {
    await ctx.phase3Queue.add("ingest-test-results", {
      run: payload.workflow_run,
      repository: payload.repository,
      installation: payload.installation,
    }, { priority: 3 });
  }
}
