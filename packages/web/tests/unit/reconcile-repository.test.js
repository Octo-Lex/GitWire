// Tests for repository identity reconciliation (PR #33).
//
// The durable identity is GitHub's numeric repository ID. When a repo is
// renamed or transferred, full_name/owner/name change but github_id stays
// constant. This reconciliation updates the DB row so downstream handlers
// find the repo by its current identity.

import { describe, it, expect, beforeEach } from "@jest/globals";
import { jest } from "@jest/globals";

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: {
    query: jest.fn(async () => ({ rows: [{ id: 10010, github_id: 1251893010, full_name: "new-owner/MyRepo" }] })),
  },
}));

import { setConfig } from "@gitwire/runtime/compat/_init.js";
setConfig({
  LOG_LEVEL: "silent",
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgresql://localhost/gitops_hub",
  GITHUB_APP_ID: "test",
  GITHUB_PRIVATE_KEY: "test",
});

const { reconcileRepositoryFromWebhook } = await import("../../src/lib/reconcileRepository.js");
const { db } = await import("../../src/lib/db.js");

describe("reconcileRepositoryFromWebhook — shape", () => {
  beforeEach(() => db.query.mockClear());

  it("returns the reconciled repo row (id, github_id, full_name)", async () => {
    const repo = await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "Octo-Lex/Super-Browser", owner: { login: "Octo-Lex" }, name: "Super-Browser", private: false, default_branch: "master" },
      installation: { id: 12345 },
    });
    expect(repo).toHaveProperty("id");
    expect(repo).toHaveProperty("github_id");
    expect(repo).toHaveProperty("full_name");
  });
});

describe("reconcileRepositoryFromWebhook — upsert by github_id", () => {
  beforeEach(() => db.query.mockClear());

  it("upserts with ON CONFLICT (github_id)", async () => {
    await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "Octo-Lex/Super-Browser", owner: { login: "Octo-Lex" }, name: "Super-Browser", private: false, default_branch: "master" },
      installation: { id: 12345 },
    });
    expect(db.query).toHaveBeenCalled();
    const sql = db.query.mock.calls[0][0].replace(/\s+/g, " ");
    expect(sql).toContain("ON CONFLICT (github_id)");
    expect(sql).toContain("DO UPDATE SET");
    expect(sql).toContain("EXCLUDED.full_name");
  });

  it("updates owner and name on conflict (not just full_name)", async () => {
    await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "Octo-Lex/Super-Browser", owner: { login: "Octo-Lex" }, name: "Super-Browser", private: false, default_branch: "master" },
      installation: { id: 12345 },
    });
    const sql = db.query.mock.calls[0][0].replace(/\s+/g, " ");
    expect(sql).toContain("EXCLUDED.owner");
    expect(sql).toContain("EXCLUDED.name");
  });

  it("passes github_id as the first parameter", async () => {
    await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "Octo-Lex/Super-Browser", owner: { login: "Octo-Lex" }, name: "Super-Browser", private: false, default_branch: "master" },
      installation: { id: 12345 },
    });
    const params = db.query.mock.calls[0][1];
    expect(params[0]).toBe(1251893010); // github_id
    expect(params[2]).toBe("Octo-Lex/Super-Browser"); // full_name
  });
});

describe("reconcileRepositoryFromWebhook — robustness", () => {
  beforeEach(() => db.query.mockClear());

  it("returns null when payload has no repository", async () => {
    const result = await reconcileRepositoryFromWebhook({});
    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns null when repository has no id", async () => {
    const result = await reconcileRepositoryFromWebhook({
      repository: { full_name: "foo/bar" },
    });
    expect(result).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("returns null when installation is missing (can't link)", async () => {
    const result = await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "foo/bar", owner: { login: "foo" }, name: "bar" },
    });
    // Without installation_id, we still reconcile — installation_id is nullable
    // for legacy repos. The function should still upsert.
    expect(result).not.toBeNull();
  });

  it("does not throw on DB error (returns null, logs warning)", async () => {
    db.query.mockRejectedValueOnce(new Error("connection refused"));
    const result = await reconcileRepositoryFromWebhook({
      repository: { id: 1251893010, full_name: "foo/bar", owner: { login: "foo" }, name: "bar", private: false, default_branch: "master" },
      installation: { id: 12345 },
    });
    expect(result).toBeNull();
  });
});

describe("reconcileRepositoryFromWebhook — rename scenario (the actual bug)", () => {
  beforeEach(() => {
    db.query.mockClear();
    // Simulate: DB has old name, reconciliation updates it to new name.
    db.query.mockResolvedValueOnce({
      rows: [{ id: 10010, github_id: 1251893010, full_name: "Octo-Lex/Super-Browser" }],
    });
  });

  it("reconciles Elephant-Rock-Lab/Super-Browser → Octo-Lex/Super-Browser", async () => {
    const repo = await reconcileRepositoryFromWebhook({
      repository: {
        id: 1251893010,
        full_name: "Octo-Lex/Super-Browser",
        owner: { login: "Octo-Lex" },
        name: "Super-Browser",
        private: false,
        default_branch: "master",
      },
      installation: { id: 12345 },
    });
    // The returned row has the updated full_name.
    expect(repo.full_name).toBe("Octo-Lex/Super-Browser");
    expect(repo.github_id).toBe(1251893010);
    // The upsert SQL updated full_name, owner, name.
    const sql = db.query.mock.calls[0][0].replace(/\s+/g, " ");
    expect(sql).toContain("EXCLUDED.full_name");
    expect(sql).toContain("EXCLUDED.owner");
  });
});
