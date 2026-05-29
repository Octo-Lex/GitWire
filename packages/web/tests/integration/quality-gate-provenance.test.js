// tests/integration/quality-gate-provenance.test.js
// Integration test: validates that unconfigured repos get no quality gate check run.
// Runs against production at https://gitwire.erlab.uk

import { jest } from "@jest/globals";

const API_BASE = process.env.GITWIRE_API_URL || "https://gitwire.erlab.uk";
const API_KEY = process.env.GITWIRE_API_KEY || "5339e850a33c40f292e9e7ef6a70240fa566b21f38544b6d";

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
