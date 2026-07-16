// tests/integration/quality-gate-provenance.test.js
// Integration test: validates that unconfigured repos get no quality gate check run.
// Requires GITWIRE_API_URL and GITWIRE_API_KEY environment variables (no defaults).

import { jest } from "@jest/globals";

const API_BASE = process.env.GITWIRE_API_URL || (() => { throw new Error("GITWIRE_API_URL is required"); })();
const API_KEY = process.env.GITWIRE_API_KEY || (() => { throw new Error("GITWIRE_API_KEY is required"); })();

async function apiFetch(path) {
  const res = await fetch(API_BASE + path, {
    headers: {
      Authorization: "Bearer " + API_KEY,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("API " + res.status + ": " + await res.text());
  return res.json();
}

describe("Quality gate provenance — integration", function () {
  jest.setTimeout(30000);

  // ── Unconfigured repo: no quality gates ──────────────────────────────────

  it("Super-Browser has no quality gates (never opted in)", async function () {
    const res = await apiFetch("/api/gates/Elephant-Rock-Lab/Super-Browser");

    expect(res.gates).toEqual([]);
    expect(res.total).toBe(0);
  });

  // ── Repo with config: may or may not have gates ──────────────────────────

  it("fleet summary returns valid response shape", async function () {
    const res = await apiFetch("/api/gates");

    expect(res).toHaveProperty("total_repos");
    expect(res).toHaveProperty("repos");
    expect(Array.isArray(res.repos)).toBe(true);
  });
});
