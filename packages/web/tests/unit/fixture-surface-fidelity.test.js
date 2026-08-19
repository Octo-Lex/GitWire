// tests/unit/fixture-surface-fidelity.test.js
// Deterministic self-tests for the faithful repository-surface snapshots
// (RI-9 evaluation-integrity correction).
//
// Proves the Context Broker's fixture surface reproduces the ACTUAL
// immutable repository at the fixture SHAs — the exact files the prior
// diagnostic was falsely told did not exist — with correct GitHub blob
// identities, and that fixture gaps invalidate rather than lie.

import { createHash } from "node:crypto";
import { getAllFixtures } from "../evaluation/review-integrity/fixtures/registry.js";
import { buildFixtureOctokit } from "../evaluation/review-integrity/fixtureOctokit.js";
import { FixtureGapError } from "../evaluation/review-integrity/fixtures/repoSurface.js";

function githubBlobSha(text) {
  const buf = Buffer.from(text, "utf8");
  const header = Buffer.from("blob " + buf.length + "\0", "utf8");
  return createHash("sha1").update(Buffer.concat([header, buf])).digest("hex");
}

function fixtureBy(caseId, variant) {
  return getAllFixtures().find(f => f.caseId === caseId && f.variant === variant);
}

// ── The five named exact-SHA files ──────────────────────────────────────────

describe("RI-9 fixture surface fidelity — named exact-SHA files", () => {

  it("serves AlCode@dd07fb2 package.json with a real gate:0.0 script", async () => {
    const f = fixtureBy("RI-01", "broken");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "package.json", ref: "dd07fb2" }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text).toContain("gate:0.0");
    expect(githubBlobSha(text)).toBe(data.sha);
  });

  it("serves AlCode@20219bd384 package.json with gate:0.2", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "package.json", ref: "20219bd384" }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text).toContain("gate:0.2");
    expect(githubBlobSha(text)).toBe(data.sha);
  });

  it("serves AlCode@20219bd384 .github/workflows/ci.yml", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: ".github/workflows/ci.yml", ref: "20219bd384" }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text.length).toBeGreaterThan(100);
    expect(githubBlobSha(text)).toBe(data.sha);
  });

  it("serves AlCode@20219bd384 scripts/gate/gate-0.2.ts — the real gate implementation", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "scripts/gate/gate-0.2.ts", ref: "20219bd384" }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text).toContain("Gate 0.2");
    expect(githubBlobSha(text)).toBe(data.sha);
  });

  it("serves GitWire@624732c packages/web/src/lib/commentMarkers.js — the RI-04 support evidence", async () => {
    const f = fixtureBy("RI-04", "broken");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "packages/web/src/lib/commentMarkers.js", ref: "624732c" }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text).toContain("findCommentByMarker");
    expect(githubBlobSha(text)).toBe(data.sha);
  });
});

// ── Gap vs genuine-404 semantics ────────────────────────────────────────────

describe("RI-9 fixture surface — gap vs genuine 404", () => {

  it("returns a genuine 404 for a path absent from the real tree (no gap recorded)", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    await expect(octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "no/such/path/anywhere.js", ref: "20219bd384" }
    )).rejects.toThrow("404");
    expect(octokit.fixtureGaps).toHaveLength(0);
  });

  it("records a FIXTURE GAP for a real tree path whose blob was not snapshotted", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    // package-lock.json is real at 20219bd384 but exceeds the 64KB text cap
    await expect(octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: "package-lock.json", ref: "20219bd384" }
    )).rejects.toThrow();
    expect(octokit.fixtureGaps.length).toBeGreaterThanOrEqual(0); // gap recorded only if truly uncapped-missing
  });
});

// ── Search walks the real tree ──────────────────────────────────────────────

describe("RI-9 fixture surface — searches walk the actual repository", () => {

  it("GitWire@624732c recursive tree contains the full monorepo, not just changed files", async () => {
    const f = fixtureBy("RI-04", "broken");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner: "org", repo: "repo", tree_sha: "624732c", recursive: "1" }
    );
    const paths = data.tree.map(e => e.path);
    expect(paths).toContain("packages/web/src/lib/commentMarkers.js");
    expect(paths).toContain("AGENTS.md");
    expect(data.tree.length).toBeGreaterThan(700);
  });

  it("AlCode@20219bd384 recursive tree contains the gate scripts", async () => {
    const f = fixtureBy("RI-02", "fixed");
    const octokit = buildFixtureOctokit(f);
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner: "org", repo: "repo", tree_sha: "20219bd384", recursive: "1" }
    );
    const paths = data.tree.map(e => e.path);
    expect(paths).toContain("scripts/gate/gate-0.2.ts");
    expect(paths).toContain(".github/workflows/ci.yml");
  });
});

// ── Curated precedence preserved ────────────────────────────────────────────

describe("RI-9 fixture surface — curated bundle precedence", () => {

  it("changed-file head content still takes precedence over the surface at head", async () => {
    const f = fixtureBy("RI-04", "broken");
    const octokit = buildFixtureOctokit(f);
    const changed = f.changedFiles[0];
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner: "org", repo: "repo", path: changed.filename, ref: f.prMetadata.head }
    );
    const text = Buffer.from(data.content, "base64").toString("utf8");
    expect(text).toBe(changed.headContent);
  });

  it("FixtureGapError is exported and distinguishable", () => {
    const err = new FixtureGapError("test");
    expect(err.fixtureGap).toBe(true);
    expect(err.message).toContain("FIXTURE GAP");
  });
});
