#!/usr/bin/env node
// scripts/enforce-production-audit.mjs
//
// Exception-aware production dependency audit evaluator.
//
// Consumes an `npm audit --omit=dev --json` report and a version-controlled
// exception registry. Fails (exit 1) when any high/critical production
// vulnerability is not covered by an exact, active, non-expired exception.
// Also fails on expired/stale/malformed/duplicate exceptions and on unknown
// audit-report schemas.
//
// npm audit exit-code contract (handled by the caller, NOT this script):
//   0 — no vulnerabilities (this script trivially passes)
//   1 — vulnerabilities found (caller passes the JSON report here; this
//       script decides whether all high/critical findings are excepted)
//   2+ / signal — operational error (caller fails directly; does NOT invoke
//       this script, which cannot diagnose npm/registry failures)
//
// Usage:
//   node enforce-production-audit.mjs <audit-report.json> <exceptions.json>
//
// Exit codes:
//   0 — all high/critical findings are actively excepted; no stale/expired/
//       malformed exceptions
//   1 — unexcepted high/critical finding, OR a defective exception registry
//       (expired, stale, duplicate, mismatched, malformed), OR an unknown
//       audit-report schema / unidentifiable advisory
//
// Exception registry schema (audit-exceptions.json):
//   {
//     "schema_version": 1,
//     "exceptions": [
//       {
//         "advisory": "https://github.com/advisories/GHSA-...",
//         "package": "package-name",
//         "range": ">=4.0.0 <4.0.6",
//         "expires": "2026-12-31T23:59:59Z",
//         "justification": "...",
//         "owner": "team-or-individual",
//         "tracking_issue": "https://github.com/Octo-Lex/GitWire/issues/NN"
//       }
//     ]
//   }

import fs from "node:fs";

const SUPPORTED_AUDIT_VERSION = 2;
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GHSA_URL_RE = /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/;

function fail(msg) {
  process.stderr.write(`::error::production-audit: ${msg}\n`);
  process.exit(1);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    fail(`cannot read or parse ${label} (${file}): ${err.message}`);
  }
}

/**
 * Extract blocking advisory findings from an npm audit v2 report.
 * Each finding is { advisory, package, range, severity }.
 *
 * Meta-vulnerabilities (via contains string references to other packages) are
 * resolved by recursively following those references to entries that contain
 * advisory objects. The canonical identity uses the advisory-bearing package
 * (e.g. brace-expansion), not the meta-package (e.g. minimatch).
 *
 * Safety properties:
 *   - String references to absent entries fail closed (unresolved reference).
 *   - Cyclic reference chains that never reach an advisory fail closed.
 *   - A blocking entry that resolves to no blocking advisory remains blocking.
 */
function extractBlockingFindings(report) {
  const findings = [];
  const vulns = report.vulnerabilities || {};

  /**
   * Recursively resolve advisory objects from a package's via list.
   * Follows string references to other vulnerability entries.
   * Returns an array of { url, severity, range, pkg } advisory objects.
   */
  function resolveAdvisories(pkgName, entry, visited) {
    if (visited.has(pkgName)) {
      fail(`cyclic meta-vulnerability reference chain detected at '${pkgName}' — cannot resolve to a stable advisory identity`);
    }
    visited.add(pkgName);

    const viaList = Array.isArray(entry.via) ? entry.via : [];
    const advisories = [];

    for (const v of viaList) {
      if (v && typeof v === "object" && v.url) {
        // Direct advisory object — validate canonical identity fields.
        if (typeof v.severity !== "string" || v.severity.length === 0) {
          fail(`advisory for '${pkgName}' has no exact severity`);
        }
        if (typeof v.range !== "string" || v.range.length === 0) {
          fail(`advisory for '${pkgName}' has no exact affected range`);
        }
        if (typeof v.name === "string" && v.name.length > 0 && v.name !== pkgName) {
          fail(`advisory package identity '${v.name}' conflicts with vulnerability entry '${pkgName}'`);
        }
        advisories.push({
          url: v.url,
          severity: v.severity,
          range: v.range,
          pkg: pkgName,
        });
      } else if (typeof v === "string") {
        // String reference to another package — recursively resolve.
        const refEntry = vulns[v];
        if (!refEntry) {
          fail(`blocking finding for '${pkgName}' references '${v}' which is absent from the audit report — cannot resolve to a stable advisory identity`);
        }
        const subAdvisories = resolveAdvisories(v, refEntry, new Set(visited));
        advisories.push(...subAdvisories);
      }
    }

    return advisories;
  }

  const seenKeys = new Set();

  for (const [pkgName, entry] of Object.entries(vulns)) {
    if (!BLOCKING_SEVERITIES.has(entry.severity)) continue;

    const advisories = resolveAdvisories(pkgName, entry, new Set());

    if (advisories.length === 0) {
      // A high/critical finding with no resolvable advisory — fail closed.
      fail(`blocking finding for '${pkgName}' (severity=${entry.severity}) resolves to no advisory object — cannot assign a stable identity for exception matching`);
    }

    let foundBlocking = false;
    for (const adv of advisories) {
      // Only consider advisories whose own severity is blocking.
      if (!BLOCKING_SEVERITIES.has(adv.severity)) continue;
      foundBlocking = true;

      const finding = {
        advisory: adv.url,
        pkg: adv.pkg,
        range: adv.range,
        severity: adv.severity,
      };

      // Deduplicate by advisory URL | advisory-bearing package | range.
      const key = `${finding.advisory}|${finding.pkg}|${finding.range}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        findings.push(finding);
      }
    }

    // If the entry is blocking but none of its resolved advisories are blocking,
    // it must remain blocking — fail closed.
    if (!foundBlocking) {
      fail(`blocking finding for '${pkgName}' (severity=${entry.severity}) resolves to no blocking advisory — cannot assign a stable identity for exception matching`);
    }
  }
  return findings;
}

function validateExceptionRegistry(registry) {
  if (!registry || typeof registry !== "object") {
    fail("exception registry is not an object");
  }
  if (registry.schema_version !== 1) {
    fail(`exception registry schema_version is ${registry.schema_version}, expected 1`);
  }
  const list = Array.isArray(registry.exceptions) ? registry.exceptions : null;
  if (!list) fail("exception registry 'exceptions' is not an array");

  const seen = new Set();
  list.forEach((exc, i) => {
    const ctx = `exceptions[${i}]`;

    for (const field of ["advisory", "package", "range", "expires", "justification", "owner", "tracking_issue"]) {
      if (typeof exc[field] !== "string" || exc[field].length === 0) {
        fail(`${ctx}.${field} is missing or not a non-empty string`);
      }
    }

    // Advisory must be an exact GHSA url (no wildcards).
    if (!GHSA_URL_RE.test(exc.advisory)) {
      fail(`${ctx}.advisory '${exc.advisory}' is not an exact GHSA advisory url`);
    }
    // No wildcard package or range.
    if (exc.package.includes("*")) {
      fail(`${ctx}.package must not contain wildcards`);
    }
    if (exc.range.includes("*")) {
      fail(`${ctx}.range must not contain wildcards`);
    }
    // Expiry must be a valid ISO timestamp (no indefinite).
    if (!ISO_TIMESTAMP_RE.test(exc.expires)) {
      fail(`${ctx}.expires '${exc.expires}' is not a valid ISO 8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ). Indefinite expirations are not permitted.`);
    }
    // Tracking issue must be a url.
    if (!exc.tracking_issue.startsWith("http")) {
      fail(`${ctx}.tracking_issue must be a URL`);
    }
    // No duplicates (same advisory + package + range).
    const key = `${exc.advisory}|${exc.package}|${exc.range}`;
    if (seen.has(key)) {
      fail(`${ctx} duplicates a previous exception (advisory+package+range)`);
    }
    seen.add(key);
  });

  return list;
}

function evaluateExceptions(list) {
  // Returns { expired: [...], active: [...] } partitioned by expiry.
  const now = Date.now();
  const expired = [];
  const active = [];
  for (const exc of list) {
    const exp = Date.parse(exc.expires);
    if (!Number.isFinite(exp)) {
      fail(`exception for ${exc.advisory} has an unparseable expires timestamp`);
    }
    if (exp <= now) {
      expired.push(exc);
    } else {
      active.push(exc);
    }
  }
  return { expired, active };
}

function matchException(finding, exceptions) {
  // Exact match on advisory + package + range.
  return exceptions.find(
    (e) => e.advisory === finding.advisory && e.package === finding.pkg && e.range === finding.range,
  );
}

function main() {
  const [auditPath, exceptionsPath] = process.argv.slice(2);
  if (!auditPath || !exceptionsPath) {
    fail("usage: enforce-production-audit.mjs <audit-report.json> <exceptions.json>");
  }

  const report = readJson(auditPath, "audit report");

  // Unknown schema → fail (cannot reliably interpret findings).
  if (report.auditReportVersion !== SUPPORTED_AUDIT_VERSION) {
    fail(`audit report version is ${report.auditReportVersion}, expected ${SUPPORTED_AUDIT_VERSION} (unknown schema — cannot assign stable advisory identities)`);
  }

  const registry = readJson(exceptionsPath, "exception registry");
  const list = validateExceptionRegistry(registry);

  const { expired, active } = evaluateExceptions(list);

  // Expired exceptions MUST be removed — they fail even if no finding matches.
  if (expired.length > 0) {
    for (const e of expired) {
      process.stderr.write(`::error::production-audit: expired exception for ${e.advisory} (${e.package}) expired ${e.expires} — remove it from the registry\n`);
    }
    fail(`${expired.length} expired exception(s) present — remove expired entries before proceeding`);
  }

  const findings = extractBlockingFindings(report);

  // Stale exceptions: active exceptions that match NO current finding must be
  // removed (they no longer correspond to a reported vulnerability).
  const matchedAdvisoryKeys = new Set(findings.map((f) => `${f.advisory}|${f.pkg}|${f.range}`));
  const stale = active.filter((e) => !matchedAdvisoryKeys.has(`${e.advisory}|${e.package}|${e.range}`));
  if (stale.length > 0) {
    for (const e of stale) {
      process.stderr.write(`::error::production-audit: stale exception for ${e.advisory} (${e.package}) — no matching finding in the current audit report; remove it\n`);
    }
    fail(`${stale.length} stale exception(s) — remove entries that no longer match a reported finding`);
  }

  // Every blocking finding must be covered by an exact active exception.
  const unexcepted = findings.filter((f) => !matchException(f, active));
  if (unexcepted.length > 0) {
    for (const f of unexcepted) {
      process.stderr.write(`::error::production-audit: unexcepted ${f.severity} finding: ${f.advisory} affects ${f.pkg} (${f.range})\n`);
    }
    fail(`${unexcepted.length} unexcepted high/critical production finding(s)`);
  }

  // Success.
  const counts = report.metadata?.vulnerabilities || {};
  console.log("✓ production dependency audit passed");
  console.log(`  blocking findings: ${findings.length} (all excepted)`);
  console.log(`  active exceptions: ${active.length}`);
  console.log(`  audit totals — high: ${counts.high || 0}, critical: ${counts.critical || 0}, moderate: ${counts.moderate || 0}, low: ${counts.low || 0}`);
}

main();
