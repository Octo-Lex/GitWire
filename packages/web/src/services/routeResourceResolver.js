// Trusted route-resource resolution for the declaration-driven Wave-2 observer.
// D0-04 requires every declared route resolver to be executable rather than
// descriptive-only. Failures are handled non-fatally by routeAuthObserver.

import { db } from "../lib/db.js";
import { resolveStoredCIRunIdentifier } from "./ciRunResolver.js";

export const SUPPORTED_ROUTE_RESOURCE_RESOLVERS = Object.freeze([
  "all active installations",
  "owner/repo -> repositories",
  "request repo -> policy definition scope",
  "rollout id -> rollout plan",
  "runId -> ci_runs -> repository",
  "owner/repo -> repositories -> installation",
  "action id -> managed_actions -> repository",
  "body orphan/live repository names",
  "body orphan repository name",
  "jobId -> retained triage payload repository",
  "body installation_id or repo_filter -> installation",
  "feedback rule id -> installation",
  "policy id -> policy_definitions.installation_id",
  "violation id -> enforcement_violations.repo_id",
  "optional body.repo -> repository; otherwise fleet",
  "body.repo -> repositories",
  "waiver id -> waivers.repo_id -> repositories",
  "duplicate signal id -> repository",
  "flaky test id -> flaky_tests.repo_id",
  "vulnerability id -> vulnerability_advisories.repo_id",
  "requested export date -> audit trail",
  "requested report period -> audit trail",
]);

const SUPPORTED = new Set(SUPPORTED_ROUTE_RESOURCE_RESOLVERS);
const UNKNOWN_REPOSITORY = Object.freeze({ type: "repository", organization: null, repository: null });
const UNKNOWN_INSTALLATION = Object.freeze({ type: "installation" });

const REPOSITORY_LOOKUPS = Object.freeze({
  "action id -> managed_actions -> repository": {
    parse: (value) => parseInt(value),
    from: "managed_actions x",
    join: "x.repo_id",
  },
  "waiver id -> waivers.repo_id -> repositories": {
    parse: (value) => parseInt(value, 10),
    from: "policy_waivers x",
    join: "x.repo_id",
  },
  "violation id -> enforcement_violations.repo_id": {
    parse: (value) => value,
    from: "enforcement_violations x",
    join: "x.repo_id",
  },
  "duplicate signal id -> repository": {
    parse: (value) => value,
    from: "duplicate_signals x",
    join: "x.repo_id",
  },
  "flaky test id -> flaky_tests.repo_id": {
    parse: (value) => value,
    from: "flaky_tests x",
    join: "x.repo_id",
  },
  "vulnerability id -> vulnerability_advisories.repo_id": {
    parse: (value) => value,
    from: "vulnerability_advisories x",
    join: "x.repo_id",
  },
});

const INSTALLATION_LOOKUPS = Object.freeze({
  "feedback rule id -> installation": "feedback_rules x",
  "policy id -> policy_definitions.installation_id": "policy_definitions x",
});

async function uniqueRow(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows.length === 1 ? rows[0] : null;
}

function repositoryResource(row) {
  if (!row) return { ...UNKNOWN_REPOSITORY };
  return {
    type: "repository",
    installationId: row.installation_id,
    repositoryId: row.github_id,
    organization: row.owner,
    repository: row.name,
  };
}

function installationResource(row) {
  if (!row) return { ...UNKNOWN_INSTALLATION };
  return {
    type: "installation",
    installationId: row.installation_id ?? row.github_id,
    organization: row.account_login ?? row.owner ?? null,
    repository: row.name ?? null,
  };
}

async function repositoryByFullName(fullName) {
  if (typeof fullName !== "string" || !fullName.includes("/")) return null;
  return uniqueRow(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM repositories r
       JOIN installations i ON i.github_id = r.installation_id AND i.deleted_at IS NULL
      WHERE r.full_name = $1 AND r.deleted_at IS NULL
      LIMIT 2`,
    [fullName],
  );
}

async function repositoryByOwnerRepo(owner, repo) {
  return repositoryByFullName(`${owner}/${repo}`);
}

async function repositoryByDeclaredId(resolver, rawId) {
  const cfg = REPOSITORY_LOOKUPS[resolver];
  if (!cfg || rawId === undefined || rawId === null || rawId === "") return null;
  const id = cfg.parse(rawId);
  if (resolver.startsWith("action id") || resolver.startsWith("waiver id")) {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
  }
  return uniqueRow(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM ${cfg.from}
       JOIN repositories r ON r.github_id = ${cfg.join}
       JOIN installations i ON i.github_id = r.installation_id AND i.deleted_at IS NULL
      WHERE x.id = $1 AND r.deleted_at IS NULL
      LIMIT 2`,
    [id],
  );
}

async function activeInstallation(installationId) {
  if (installationId === undefined || installationId === null || installationId === "") return null;
  return uniqueRow(
    `SELECT i.github_id, i.account_login
       FROM installations i
      WHERE i.github_id = $1 AND i.deleted_at IS NULL
      LIMIT 2`,
    [installationId],
  );
}

async function installationByDeclaredId(resolver, id) {
  const from = INSTALLATION_LOOKUPS[resolver];
  if (!from || id === undefined || id === null || id === "") return null;
  return uniqueRow(
    `SELECT i.github_id, i.account_login
       FROM ${from}
       JOIN installations i ON i.github_id = x.installation_id AND i.deleted_at IS NULL
      WHERE x.id = $1
      LIMIT 2`,
    [id],
  );
}

async function rolloutRepository(rawId) {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return uniqueRow(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM policy_rollout_plans p
       JOIN repositories r ON r.github_id = p.repo_id
       JOIN installations i ON i.github_id = r.installation_id AND i.deleted_at IS NULL
      WHERE p.id = $1 AND r.deleted_at IS NULL
      LIMIT 2`,
    [id],
  );
}

async function triageJobRepository(jobId) {
  const { triageQueue } = await import("../lib/queue.js");
  const job = await triageQueue.getJob(jobId);
  if (!job || (job.queueName !== "triage" && job.queueName !== undefined)) return null;
  const repositoryId = job.data?.payload?.repository?.id;
  const installationId = job.data?.payload?.installation?.id;
  if (!repositoryId || !installationId) return null;
  return uniqueRow(
    `SELECT r.github_id, r.installation_id, r.owner, r.name
       FROM repositories r
       JOIN installations i ON i.github_id = r.installation_id AND i.deleted_at IS NULL
      WHERE r.github_id = $1 AND r.installation_id = $2 AND r.deleted_at IS NULL
      LIMIT 2`,
    [repositoryId, installationId],
  );
}

async function ciRunRepository(runId) {
  const resolution = await resolveStoredCIRunIdentifier(runId);
  if (resolution.status !== "resolved") return null;
  return {
    github_id: resolution.run.repo_github_id,
    installation_id: resolution.run.installation_id,
    owner: resolution.run.owner,
    name: resolution.run.name,
  };
}

async function bodyInstallation(body) {
  if (body?.installation_id) return activeInstallation(body.installation_id);
  if (!body?.repo_filter) return null;
  const repo = await repositoryByFullName(body.repo_filter);
  return repo ? { github_id: repo.installation_id, owner: repo.owner, name: repo.name } : null;
}

function policyScopedResource(type, row, resourceId = null) {
  if (!row) return resourceId ? { type, resourceId } : { type };
  return {
    type,
    ...(resourceId ? { resourceId } : {}),
    installationId: row.installation_id,
    repositoryId: row.github_id,
    organization: row.owner,
    repository: row.name,
  };
}

/** Resolve trusted resource identity for one protected route declaration. */
export async function resolveRouteResource(resourceType, params = {}, resolver = null, body = {}) {
  // Protected reads predate D0-04 resolver metadata; retain their old trusted path/fleet behavior.
  if (!resolver) {
    if (resourceType === "repository" && params.owner && params.repo) {
      return repositoryResource(await repositoryByOwnerRepo(params.owner, params.repo));
    }
    if (resourceType === "installation" && params.owner && params.repo) {
      return installationResource(await repositoryByOwnerRepo(params.owner, params.repo));
    }
    if (resourceType === "fleet") return { type: "fleet" };
    if (resourceType === "policy_rollout_plan" && params.id) {
      return { type: "policy_rollout_plan", resourceId: params.id };
    }
    return { type: resourceType || "unknown" };
  }

  if (!SUPPORTED.has(resolver)) throw new Error(`Unsupported route resource resolver: ${resolver}`);

  if (
    resolver === "all active installations" ||
    resolver === "body orphan/live repository names" ||
    resolver === "body orphan repository name" ||
    resolver === "requested export date -> audit trail" ||
    resolver === "requested report period -> audit trail"
  ) return { type: "fleet" };

  if (resolver === "owner/repo -> repositories") {
    return repositoryResource(params.owner && params.repo ? await repositoryByOwnerRepo(params.owner, params.repo) : null);
  }
  if (resolver === "owner/repo -> repositories -> installation") {
    return installationResource(params.owner && params.repo ? await repositoryByOwnerRepo(params.owner, params.repo) : null);
  }
  if (resolver === "runId -> ci_runs -> repository") {
    return repositoryResource(params.runId ? await ciRunRepository(params.runId) : null);
  }
  if (resolver === "jobId -> retained triage payload repository") {
    return repositoryResource(params.jobId ? await triageJobRepository(params.jobId) : null);
  }
  if (REPOSITORY_LOOKUPS[resolver]) {
    return repositoryResource(await repositoryByDeclaredId(resolver, params.id));
  }
  if (resolver === "body.repo -> repositories") {
    return repositoryResource(body?.repo ? await repositoryByFullName(body.repo) : null);
  }
  if (resolver === "optional body.repo -> repository; otherwise fleet") {
    return body?.repo ? repositoryResource(await repositoryByFullName(body.repo)) : { type: "fleet" };
  }
  if (resolver === "body installation_id or repo_filter -> installation") {
    return installationResource(await bodyInstallation(body));
  }
  if (INSTALLATION_LOOKUPS[resolver]) {
    return installationResource(await installationByDeclaredId(resolver, params.id));
  }
  if (resolver === "request repo -> policy definition scope") {
    return policyScopedResource("policy_definition", body?.repo ? await repositoryByFullName(body.repo) : null);
  }
  if (resolver === "rollout id -> rollout plan") {
    const id = Number(params.id);
    const resourceId = Number.isSafeInteger(id) && id > 0 ? String(id) : null;
    return policyScopedResource("policy_rollout_plan", resourceId ? await rolloutRepository(params.id) : null, resourceId);
  }

  throw new Error(`Unhandled route resource resolver: ${resolver}`);
}
