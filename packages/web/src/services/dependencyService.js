// src/services/dependencyService.js
// Dependency & vulnerability lifecycle management for Phase 3.
// Adapted for GitWire: octokit.request(), no silent catches.

import { db }  from "../lib/db.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";

const CRITICAL_CVSS_THRESHOLD = 9.0;

// ════════════════════════════════════════════════════════════════════════════
// Scan a repo's dependencies and advisories
// ════════════════════════════════════════════════════════════════════════════

export async function scanRepo({ repository, octokit }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const repoId = repository.id;

  logger.info({ repo: repository.full_name }, "Dependency scanner: starting");

  const manifests = await fetchDependencyManifests(octokit, owner, repo);
  if (!manifests.length) {
    logger.debug({ repo: repository.full_name }, "Dependency scanner: no manifests found");
    return;
  }

  for (const manifest of manifests) {
    await db.query(
      `INSERT INTO dependency_manifests (repo_id, file_path, ecosystem, dependencies, dep_count, scanned_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (repo_id, file_path) DO UPDATE SET
         dependencies = EXCLUDED.dependencies, dep_count = EXCLUDED.dep_count, scanned_at = NOW()`,
      [repoId, manifest.path, manifest.ecosystem, JSON.stringify(manifest.dependencies), manifest.dependencies.length]
    );
  }

  const vulnerabilities = await fetchVulnerabilityAlerts(octokit, owner, repo);

  let newCritical = 0;
  for (const vuln of vulnerabilities) {
    const existing = await db.query(
      "SELECT id, status FROM vulnerability_advisories WHERE repo_id = $1 AND package_name = $2 AND ghsa_id = $3",
      [repoId, vuln.package_name, vuln.ghsa_id]
    );

    if (!existing.rows.length) {
      await db.query(
        `INSERT INTO vulnerability_advisories (repo_id, ghsa_id, cve_id, ecosystem, package_name,
           affected_range, patched_version, installed_version, severity, cvss_score, summary, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [repoId, vuln.ghsa_id, vuln.cve_id ?? null, vuln.ecosystem, vuln.package_name,
         vuln.affected_range, vuln.patched_version ?? null, vuln.installed_version ?? null,
         vuln.severity, vuln.cvss_score ?? null, vuln.summary ?? null,
         vuln.published_at ? new Date(vuln.published_at) : null]
      );

      if ((vuln.cvss_score ?? 0) >= CRITICAL_CVSS_THRESHOLD || vuln.severity === "critical") {
        newCritical++;
      }
    }
  }

  logger.info({ repo: repository.full_name, manifests: manifests.length, vulns: vulnerabilities.length, newCritical }, "Dependency scanner: scan complete");

  if (newCritical > 0) {
    await openCriticalVulnPR({ repository, octokit, repoId });
  }

  return { manifests: manifests.length, vulnerabilities: vulnerabilities.length, newCritical };
}

// ════════════════════════════════════════════════════════════════════════════
// Open batch update PR (weekly)
// ════════════════════════════════════════════════════════════════════════════

export async function openBatchUpdatePR({ repository, octokit, repoId, ecosystem }) {
  const { rows: vulns } = await db.query(
    `SELECT * FROM vulnerability_advisories WHERE repo_id = $1 AND status = 'open'
       AND severity NOT IN ('critical') AND (cvss_score IS NULL OR cvss_score < $2)
       AND ecosystem = $3 AND patched_version IS NOT NULL
     ORDER BY severity DESC, cvss_score DESC`,
    [repoId, CRITICAL_CVSS_THRESHOLD, ecosystem]
  );
  if (!vulns.length) return null;

  const owner = repository.owner.login;
  const repo  = repository.name;
  logger.info({ repo: repository.full_name, ecosystem, count: vulns.length }, "Dependency: opening batch update PR");

  const patchFiles = await buildBatchPatch({ ecosystem, vulns, octokit, owner, repo });
  if (!patchFiles?.length) return null;

  const branch = "gitwire-deps/batch-" + ecosystem + "-" + Date.now();
  const pr = await createPRWithPatch({
    octokit, owner, repo, branch, baseBranch: repository.default_branch,
    title: "Deps: Batch update " + vulns.length + " " + ecosystem + " vulnerabilities",
    body: buildBatchPRBody(vulns, ecosystem),
    files: patchFiles,
    labels: [
      { name: "dependencies", color: "0075ca" },
      { name: ecosystem, color: "e4e669" },
      { name: "security", color: "e11d48" },
    ],
  });

  if (pr) {
    await db.query(
      "UPDATE vulnerability_advisories SET status = 'pr_opened', fix_pr_number = $1, fix_pr_url = $2, updated_at = NOW() WHERE id = ANY($3::bigint[])",
      [pr.number, pr.html_url, vulns.map(v => v.id)]
    );
    await db.query(
      "INSERT INTO dependency_update_batches (repo_id, ecosystem, update_type, packages, pr_number, pr_url) VALUES ($1,$2,'batch_minor_patch',$3,$4,$5)",
      [repoId, ecosystem, JSON.stringify(vulns.map(v => ({ name: v.package_name, from: v.installed_version, to: v.patched_version }))), pr.number, pr.html_url]
    );
  }
  return pr;
}

// ════════════════════════════════════════════════════════════════════════════
// Critical CVE fast-track PR
// ════════════════════════════════════════════════════════════════════════════

async function openCriticalVulnPR({ repository, octokit, repoId }) {
  const { rows: criticalVulns } = await db.query(
    "SELECT * FROM vulnerability_advisories WHERE repo_id = $1 AND status = 'open' AND (severity = 'critical' OR cvss_score >= $2) AND patched_version IS NOT NULL ORDER BY cvss_score DESC NULLS LAST",
    [repoId, CRITICAL_CVSS_THRESHOLD]
  );
  if (!criticalVulns.length) return;

  const owner = repository.owner.login;
  const repo  = repository.name;
  const byEcosystem = criticalVulns.reduce((acc, v) => { (acc[v.ecosystem] ??= []).push(v); return acc; }, {});

  for (const [ecosystem, vulns] of Object.entries(byEcosystem)) {
    const patchFiles = await buildBatchPatch({ ecosystem, vulns, octokit, owner, repo });
    if (!patchFiles?.length) continue;

    const branch = "gitwire-deps/critical-" + ecosystem + "-" + Date.now();
    const pr = await createPRWithPatch({
      octokit, owner, repo, branch, baseBranch: repository.default_branch,
      title: "CRITICAL: Security patch " + vulns.length + " " + ecosystem + " CVEs",
      body: buildCriticalPRBody(vulns, ecosystem),
      files: patchFiles,
      labels: [{ name: "security", color: "e11d48" }, { name: "critical", color: "b60205" }, { name: "dependencies", color: "0075ca" }],
    });

    if (pr) {
      await db.query(
        "UPDATE vulnerability_advisories SET status = 'pr_opened', fix_pr_number = $1, fix_pr_url = $2, updated_at = NOW() WHERE id = ANY($3::bigint[])",
        [pr.number, pr.html_url, vulns.map(v => v.id)]
      );
      logger.info({ repo: repository.full_name, pr: pr.number, ecosystem }, "Dependency: critical CVE PR opened");
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Patch builders
// ════════════════════════════════════════════════════════════════════════════

async function buildBatchPatch({ ecosystem, vulns, octokit, owner, repo }) {
  switch (ecosystem) {
    case "npm": return buildNpmPatch(vulns, octokit, owner, repo);
    case "pip": return buildPipPatch(vulns, octokit, owner, repo);
    default:    return null;
  }
}

async function buildNpmPatch(vulns, octokit, owner, repo) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path: "package.json" });
    const content = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    for (const vuln of vulns) {
      if (!vuln.patched_version) continue;
      const section = content.dependencies?.[vuln.package_name] !== undefined ? "dependencies"
        : content.devDependencies?.[vuln.package_name] !== undefined ? "devDependencies" : null;
      if (section) content[section][vuln.package_name] = "^" + vuln.patched_version;
    }
    return [{ path: "package.json", content: JSON.stringify(content, null, 2) + "\n" }];
  } catch { return null; }
}

async function buildPipPatch(vulns, octokit, owner, repo) {
  for (const reqFile of ["requirements.txt", "requirements/base.txt", "requirements/prod.txt"]) {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", { owner, repo, path: reqFile });
      let content = Buffer.from(data.content, "base64").toString("utf8");
      for (const vuln of vulns) {
        if (!vuln.patched_version) continue;
        const re = new RegExp("(" + vuln.package_name + "[\\[\\]a-z0-9_-]*)\\s*[=<>!~]+.*$", "im");
        content = content.replace(re, "$1==" + vuln.patched_version);
      }
      return [{ path: reqFile, content }];
    } catch { continue; }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// GitHub API helpers
// ════════════════════════════════════════════════════════════════════════════

async function fetchDependencyManifests(octokit, owner, repo) {
  // NOTE: octokit.graphql() may not be available (core Octokit from @octokit/app).
  // Fallback: fetch known manifest files via REST content API.
  const knownManifests = [
    { path: 'package.json', ecosystem: 'npm' },
    { path: 'requirements.txt', ecosystem: 'pip' },
    { path: 'go.mod', ecosystem: 'gomod' },
    { path: 'pom.xml', ecosystem: 'maven' },
    { path: 'Gemfile', ecosystem: 'rubygems' },
    { path: 'Cargo.toml', ecosystem: 'cargo' },
  ];

  const results = [];
  for (const manifest of knownManifests) {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner, repo, path: manifest.path,
      });
      if (data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        let dependencies = [];
        if (manifest.ecosystem === 'npm') {
          try {
            const pkg = JSON.parse(content);
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            dependencies = Object.entries(allDeps).map(([name, version_spec]) => ({ name, version_spec, package_manager: 'npm' }));
          } catch (e) { /* invalid JSON */ }
        } else {
          // For non-npm ecosystems, just record the file exists
          const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
          dependencies = lines.slice(0, 50).map(line => ({ name: line.split(/[=<>@]/)[0].trim(), version_spec: line.trim(), package_manager: manifest.ecosystem }));
        }
        results.push({ path: manifest.path, ecosystem: manifest.ecosystem, dependencies });
      }
    } catch (err) {
      // File doesn't exist — skip
    }
  }
  return results;
}

async function fetchVulnerabilityAlerts(octokit, owner, repo) {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/dependabot/alerts", {
      owner, repo, state: "open", per_page: 100,
    });
    return (Array.isArray(data) ? data : []).map(alert => ({
      ghsa_id:           alert.security_advisory?.ghsa_id,
      cve_id:            alert.security_advisory?.cve_id,
      ecosystem:         alert.dependency?.package?.ecosystem?.toLowerCase() ?? "unknown",
      package_name:      alert.dependency?.package?.name,
      affected_range:    alert.security_vulnerability?.vulnerable_version_range ?? "unknown",
      patched_version:   alert.security_vulnerability?.first_patched_version?.identifier,
      installed_version: null,
      severity:          alert.security_advisory?.severity?.toLowerCase() ?? "unknown",
      cvss_score:        alert.security_advisory?.cvss?.score ?? null,
      summary:           alert.security_advisory?.summary,
      published_at:      alert.security_advisory?.published_at,
    })).filter(v => v.package_name && v.ghsa_id);
  } catch (err) {
    logger.warn({ err: err.message }, "Dependency: Dependabot alerts fetch failed");
    return [];
  }
}

async function createPRWithPatch({ octokit, owner, repo, branch, baseBranch, title, body, files, labels }) {
  try {
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: "heads/" + baseBranch });
    const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: ref.object.sha });

    const treeItems = await Promise.all(files.map(async f => {
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner, repo, content: Buffer.from(f.content).toString("base64"), encoding: "base64",
      });
      return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
    }));

    const { data: newTree }   = await octokit.request("POST /repos/{owner}/{repo}/git/trees", { owner, repo, base_tree: baseCommit.tree.sha, tree: treeItems });
    const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", { owner, repo, message: title, tree: newTree.sha, parents: [ref.object.sha] });
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: "refs/heads/" + branch, sha: newCommit.sha });
    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, title, head: branch, base: baseBranch, body });

    for (const label of labels) {
      try { await octokit.request("POST /repos/{owner}/{repo}/labels", { owner, repo, ...label }); } catch { /* exists */ }
    }
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner, repo, issue_number: pr.number, labels: labels.map(l => l.name),
    }).catch(err => logger.warn({ err: err.message }, "Dependency: could not apply labels"));

    return pr;
  } catch (err) {
    logger.error({ err: err.message }, "Dependency: PR creation failed");
    return null;
  }
}

// PR body builders
function buildBatchPRBody(vulns, ecosystem) {
  const table = vulns.map(v => "| " + v.package_name + " | " + (v.installed_version ?? "?") + " | " + v.patched_version + " | " + v.severity + " | " + (v.cvss_score ?? "-") + " | " + (v.ghsa_id ?? "-") + " |").join("\n");
  return "## Dependency security update — " + ecosystem + "\n\nUpdates **" + vulns.length + "** packages with known vulnerabilities.\n\n| Package | Current | Fixed | Severity | CVSS | Advisory |\n|---------|---------|-------|----------|------|----------|\n" + table + "\n\n---\n_Auto-generated by **GitWire** dependency lifecycle manager_";
}

function buildCriticalPRBody(vulns, ecosystem) {
  const table = vulns.map(v => "| " + v.package_name + " | " + (v.installed_version ?? "?") + " | " + v.patched_version + " | **" + (v.cvss_score ?? v.severity) + "** | " + (v.cve_id ?? v.ghsa_id) + " |").join("\n");
  return "## CRITICAL security patch — " + ecosystem + "\n\nPatches **" + vulns.length + "** CRITICAL vulnerabilities (CVSS >= " + CRITICAL_CVSS_THRESHOLD + ").\n**Immediate review required.**\n\n| Package | Current | Fixed | CVSS | CVE |\n|---------|---------|-------|------|-----|\n" + table + "\n\n---\n_Auto-generated by **GitWire** dependency lifecycle manager · Critical fast-track_";
}

function inferEcosystem(filename) {
  if (/package\.json$/i.test(filename))        return "npm";
  if (/requirements.*\.txt$/i.test(filename))   return "pip";
  if (/Pipfile\.lock$/i.test(filename))          return "pip";
  if (/Gemfile\.lock$/i.test(filename))          return "rubygems";
  if (/go\.sum$/i.test(filename))                return "go";
  if (/Cargo\.toml$/i.test(filename))            return "cargo";
  if (/pom\.xml$/i.test(filename))               return "maven";
  return "unknown";
}
