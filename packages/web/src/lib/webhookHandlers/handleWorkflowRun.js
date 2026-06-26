// src/lib/webhookHandlers/handleWorkflowRun.js
// Handler for "workflow_run" webhook events.
// CI failures → healing queue + repair evidence collection queue,
// all completions → merge queue + rollback eval + test ingestion.

import { ciEvidenceQueue } from "../../lib/queue.js";

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

    // v0.19: queue trusted CI evidence collection for repair proposals
    // Non-blocking: enqueues a dedicated job so the webhook handler returns
    // promptly. The collector worker processes the job with retry + dedup.
    if (payload.installation?.id) {
      await ciEvidenceQueue.add(
        "collect-evidence",
        {
          deliveryId,
          installationId: payload.installation.id,
          repoFullName: payload.repository?.full_name,
          runId: payload.workflow_run?.id,
          headSha: payload.workflow_run?.head_sha,
          workflowPath: payload.workflow_run?.path || payload.workflow?.path || null,
          // Include the full payload for eligibility checks + envelope construction
          action: payload.action,
          conclusion: payload.workflow_run?.conclusion,
        },
        {
          priority: 2,
          // Dedup: same delivery ID = same webhook delivery
          // BullMQ jobIds cannot contain ":" — use "-" as separator.
          jobId: "ci-evidence-" + deliveryId,
        }
      );
      ctx.logger.info(
        { runId: payload.workflow_run?.id, deliveryId },
        "CI evidence collection queued for repair proposal"
      );
    }
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
