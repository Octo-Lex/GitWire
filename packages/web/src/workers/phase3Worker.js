// src/workers/phase3Worker.js
// BullMQ worker + scheduler for Phase 3.
// Handles: test result ingestion, graduation checks, policy reconciliation, dep scans.

import { createWorker, phase3Queue } from "../lib/queue.js";
import { getInstallationClient, forEachInstallation } from "../lib/github.js";
import { ingestTestResults, checkGraduation } from "../services/flakyTestService.js";
import { runFleetReconciliation } from "../services/policyReconcilerService.js";
import { scanRepo } from "../services/dependencyService.js";
import { logger } from "../lib/logger.js";
import { db }     from "../lib/db.js";

// ── Worker ────────────────────────────────────────────────────────────────────
export function startPhase3Worker() {
  return createWorker("phase3", async (job) => {
    switch (job.name) {

      case "ingest-test-results": {
        const { run, repository, installation } = job.data;
        if (!run || !repository || !installation) return;
        const octokit = await getInstallationClient(installation.id);
        await ingestTestResults({ run, repository, octokit });
        break;
      }

      case "graduation-check": {
        const { rows: repos } = await db.query("SELECT DISTINCT repo_id FROM flaky_tests WHERE quarantined = TRUE");
        for (const { repo_id } of repos) {
          await checkGraduation(repo_id).catch(err =>
            logger.warn({ repo_id, err: err.message }, "Phase3: graduation check failed")
          );
        }
        break;
      }

      case "policy-reconcile-fleet": {
        await runFleetReconciliation("scheduler");
        break;
      }

      case "dependency-scan-fleet": {
        await forEachInstallation(async (octokit, installation) => {
          const { rows: repos } = await db.query(
            "SELECT github_id, full_name, owner, name, default_branch, installation_id FROM repositories WHERE installation_id = $1",
            [installation.id]
          );
          for (const repo of repos) {
            await scanRepo({
              repository: { ...repo, id: repo.github_id, owner: { login: repo.owner } },
              octokit,
            }).catch(err =>
              logger.warn({ repo: repo.full_name, err: err.message }, "Phase3: dep scan failed")
            );
            await new Promise(r => setTimeout(r, 200));
          }
        });
        break;
      }

      case "dependency-scan-repo": {
        const { repoId, installationId } = job.data;
        const { rows: [repo] } = await db.query(
          "SELECT github_id, full_name, owner, name, default_branch, installation_id FROM repositories WHERE github_id = $1",
          [repoId]
        );
        if (!repo) return;
        const octokit = await getInstallationClient(installationId);
        await scanRepo({
          repository: { ...repo, id: repo.github_id, owner: { login: repo.owner } },
          octokit,
        });
        break;
      }

      default:
        logger.debug({ jobName: job.name }, "Phase3 worker: unknown job");
    }
  }, { concurrency: 3 });
}

// ── Scheduler: enqueue recurring Phase 3 jobs ─────────────────────────────────
export async function schedulePhase3Jobs() {
  // Policy reconciliation: nightly at 02:00 UTC
  await phase3Queue.add("policy-reconcile-fleet", {}, {
    repeat: { cron: "0 2 * * *" }, jobId: "policy-reconcile-fleet-cron",
  });

  // Dependency scan: weekly Sunday at 03:00 UTC
  await phase3Queue.add("dependency-scan-fleet", {}, {
    repeat: { cron: "0 3 * * 0" }, jobId: "dependency-scan-fleet-cron",
  });

  // Graduation check: weekly Monday at 07:00 UTC
  await phase3Queue.add("graduation-check", {}, {
    repeat: { cron: "0 7 * * 1" }, jobId: "graduation-check-cron",
  });

  logger.info("Phase3: recurring jobs scheduled (reconcile nightly, dep scan weekly, graduation weekly)");
}
