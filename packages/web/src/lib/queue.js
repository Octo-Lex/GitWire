// src/lib/queue.js
// Re-exported from @gitwire/runtime for backward compatibility.
// All existing imports continue to work:
//   import { redis, createQueue, createWorker, webhookQueue, ... } from "../lib/queue.js";

export {
  redis,
  QUEUES,
  createQueue,
  createWorker,
  webhookQueue,
  triageQueue,
  ciHealQueue,
  ciEvidenceQueue,
  diagnosisQueue,
  syncQueue,
  maintainerQueue,
  issueFixQueue,
  phase2Queue,
  phase3Queue,
  phase4Queue,
} from "@gitwire/runtime/compat/queue";
