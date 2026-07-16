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
 * Advisory identity is the GHSA url (stable). Meta-vulnerabilities (via is a
 * string referencing another package) are resolved to their underlying advisory
 * url when traversable; if a blocking finding cannot be assigned a stable
 * advisory identity, the evaluator fails (unknown identity).
 */
function extractBlockingFindings(report) {
  const findings = [];
  const vulns = report.vulnerabilities || {};

  for (const [pkgName, entry] of Object.entries(vulns)) {
    if (!BLOCKING_SEVERITIES.has(entry.severity)) continue;

    const viaList = Array.isArray(entry.via) ? entry.via : [];

    // Collect advisory objects from via. String entries are meta-vuln refs to
    // other packages; we only act on advisory-object entries here.
    const advisoryObjs = viaList.filter((v) => v && typeof v === "object" && v.url);

    if (advisoryObjs.length === 0) {
      // A high/critical finding with no advisory-object url — we cannot assign
      // a stable identity. Fail rather than silently skip.
      fail(`blocking finding for '${pkgName}' (severity=${entry.severity}) has no advisory url — cannot assign a stable identity for exception matching`);
    }

    for (const adv of advisoryObjs) {
      // Only consider advisories whose own severity is blocking. A high
      // package entry may chain through a moderate advisory.
      if (!BLOCKING_SEVERITIES.has(adv.severity)) continue;
      findings.push({
        advisory: adv.url,
        pkg: pkgName,
        range: adv.range || entry.range || "*",
        severity: adv.severity,
      });
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
