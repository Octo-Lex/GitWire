// src/services/auth/resourceResolver.js
//
// Server-owned resource resolver (Wave 2 / issue #94).
//
// Takes the job's installation + repository identifiers ONLY as lookup inputs.
// Queries the trusted repositories/installations state in PostgreSQL and
// returns a canonical authorization resource derived from the DB row — NOT
// from the queue payload.
//
// Fails closed for:
//   unknown installation, unknown repository, repo assigned to another
//   installation, ambiguous mapping, DB error.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * Resolve a trusted repository resource from server-owned state.
 *
 * @param {number} installationId - from the job (trusted webhook source)
 * @param {number} repositoryId   - from the job (LOOKUP KEY ONLY, not authoritative)
 * @returns {Promise<{type: string, installationId: number, repositoryId: number, organization: string, repository: string}|null>}
 *   Returns null if the repository does not exist or does not belong to the installation.
 */
export async function resolveRepositoryResource(installationId, repositoryId) {
  if (!installationId || !repositoryId) {
    return null;
  }

  try {
    const { rows } = await db.query(
      `SELECT r.github_id, r.installation_id, r.full_name, r.owner, r.name
         FROM repositories r
        WHERE r.github_id = $1
          AND r.installation_id = $2
        LIMIT 2`, // detect ambiguity (>1 row = error)
      [repositoryId, installationId]
    );

    if (rows.length === 0) {
      // Repository not found OR does not belong to this installation.
      logger.warn({ installationId, repositoryId }, "resourceResolver: repository not found for installation");
      return null;
    }

    if (rows.length > 1) {
      // Ambiguous mapping — multiple rows for the same github_id + installation_id.
      logger.error({ installationId, repositoryId, count: rows.length }, "resourceResolver: ambiguous repository mapping");
      return null;
    }

    const row = rows[0];
    // Double-check: the DB row's installation_id must match the requested one.
    if (Number(row.installation_id) !== Number(installationId)) {
      logger.error({ installationId, repositoryId, actualInstallation: row.installation_id }, "resourceResolver: repository belongs to different installation");
      return null;
    }

    return {
      type: "repository",
      installationId: Number(row.installation_id),
      repositoryId: Number(row.github_id),
      organization: row.owner,
      repository: row.name,
    };
  } catch (err) {
    logger.warn({ err, installationId, repositoryId }, "resourceResolver: DB lookup failed");
    return null;
  }
}

function canonicalCoordinatesFromFullName(fullName) {
  if (typeof fullName !== "string") return null;
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { organization: parts[0], repository: parts[1] };
}

/**
 * Resolve a trusted repository resource from installation + full_name.
 *
 * Maintainer jobs historically carry `repoFullName` instead of a repository
 * id. W1-04 uses that value only as a lookup key and reconstructs the
 * authorization resource from the server-owned repositories row. The row's
 * validated `full_name` is the canonical GitHub coordinate: denormalized
 * `owner` / `name` columns can lag after repository rename or transfer.
 *
 * @param {number} installationId
 * @param {string} fullName
 * @returns {Promise<{type: string, installationId: number, repositoryId: number, organization: string, repository: string}|null>}
 */
export async function resolveRepositoryResourceByFullName(installationId, fullName) {
  if (!installationId || typeof fullName !== "string" || !fullName.trim()) {
    return null;
  }

  try {
    const { rows } = await db.query(
      `SELECT r.github_id, r.installation_id, r.full_name, r.owner, r.name
         FROM repositories r
        WHERE r.full_name = $1
          AND r.installation_id = $2
        LIMIT 2`,
      [fullName, installationId]
    );

    if (rows.length === 0) {
      logger.warn({ installationId, fullName }, "resourceResolver: repository full name not found for installation");
      return null;
    }

    if (rows.length > 1) {
      logger.error({ installationId, fullName, count: rows.length }, "resourceResolver: ambiguous repository full-name mapping");
      return null;
    }

    const row = rows[0];
    if (Number(row.installation_id) !== Number(installationId)) {
      logger.error(
        { installationId, fullName, actualInstallation: row.installation_id },
        "resourceResolver: full-name repository belongs to different installation"
      );
      return null;
    }

    const coordinates = canonicalCoordinatesFromFullName(row.full_name);
    if (!coordinates) {
      logger.error(
        { installationId, fullName, storedFullName: row.full_name },
        "resourceResolver: stored repository full name is invalid"
      );
      return null;
    }

    return {
      type: "repository",
      installationId: Number(row.installation_id),
      repositoryId: Number(row.github_id),
      organization: coordinates.organization,
      repository: coordinates.repository,
    };
  } catch (err) {
    logger.warn({ err, installationId, fullName }, "resourceResolver: DB full-name lookup failed");
    return null;
  }
}
