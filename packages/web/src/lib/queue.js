// src/lib/queue.js
// Re-exported from @gitwire/runtime for backward compatibility.
// All existing imports continue to work:
//   import { redis, createQueue, createWorker, webhookQueue, ... } from "../lib/queue.js";
//
// D0-01 adds one web-layer consumer-boundary invariant: `heal-run` jobs are
// validated again when a CI-healing worker receives them. Producer validation
// prevents new malformed jobs; consumer validation also makes stale, legacy, or
// otherwise directly-enqueued malformed jobs fail visibly in BullMQ instead of
// being acknowledged as successful no-ops by ciHealWorker.

import {
  redis,
  QUEUES,
  createQueue,
  createWorker as runtimeCreateWorker,
  webhookQueue,
  triageQueue,
  ciHealQueue,
  ciEvidenceQueue,
  diagnosisQueue,
  patchQueue,
  verificationQueue,
  criticQueue,
  syncQueue,
  maintainerQueue,
  issueFixQueue,
  phase2Queue,
  phase3Queue,
  phase4Queue,
} from "@gitwire/runtime/compat/queue";
import { validateCIHealJob } from "../services/ciHealJobService.js";

export {
  redis,
  QUEUES,
  createQueue,
  webhookQueue,
  triageQueue,
  ciHealQueue,
  ciEvidenceQueue,
  diagnosisQueue,
  patchQueue,
  verificationQueue,
  criticQueue,
  syncQueue,
  maintainerQueue,
  issueFixQueue,
  phase2Queue,
  phase3Queue,
  phase4Queue,
};

export function createWorker(name, processor, opts = {}) {
  if (name !== QUEUES.CI_HEALING) {
    return runtimeCreateWorker(name, processor, opts);
  }

  return runtimeCreateWorker(name, async (job) => {
    if (job.name === "heal-run") {
      // Replace job.data with the parsed canonical representation so the
      // downstream worker sees exactly what passed the consumer contract.
      job.data = validateCIHealJob(job.data);
    }
    return processor(job);
  }, opts);
}
