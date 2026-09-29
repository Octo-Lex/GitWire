// tests/unit/w2-04-config-layering.test.js
// W2-04 canonical layering wiring in configService: sparse resolution
// end-to-end (A3 regression, A8 source identity, A10/A11 governed layer,
// A14/A15 safe defaults through the service, A18 coherent cache bundle) and
// quality-gate compatibility surfaces (_meta.layers / _explicitKeys).

import { jest } from "@jest/globals";

const state = {
  files: new Map(),     // "owner/repo@path" -> { content: base64, sha }
  repoRows: [],         // repositories rows by full_name
  orgRows: new Map(),   // full_name -> { installation_id, account_login }
  governedRows: new Map(), // full_name -> row or null
  cache: new Map(),
  cacheWrites: 0,
  transportError: null, // { status, message } — non-404 GitHub failure simulation
};

const mockQuery = jest.fn();
const mockRedis = {
  get: jest.fn(async (key) => (state.cache.has(key) ? state.cache.get(key) : null)),
  set: jest.fn(async (key, value) => {
    state.cache.set(key, value);
    state.cacheWrites += 1;
  }),
  del: jest.fn(async (key) => {
    state.cache.delete(key);
  }),
};

jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
jest.unstable_mockModule("../../src/lib/queue.js", () => ({ redis: mockRedis }));
jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));
jest.unstable_mockModule("../../src/lib/github.js", () => ({
  getInstallationClient: jest.fn(async () => ({ kind: "installation" })),
}));
jest.unstable_mockModule("../../src/lib/githubWrapper.js", () => ({
  wrapOctokit: jest.fn(() => ({
    request: async (route, params) => {
      if (!route.includes("/contents/")) throw new Error("unexpected route " + route);
      if (state.transportError) {
        // Non-404 transport failure (rate limit, 403, 5xx, ECONNREFUSED…)
        const err = new Error(state.transportError.message);
        err.status = state.transportError.status;
        throw err;
      }
      const key = `${params.owner}/${params.repo}@${params.path}`;
      const file = state.files.get(key);
      if (!file) {
        const err = new Error("Not Found");
        err.status = 404;
        throw err;
      }
      return { data: file };
    },
  })),
}));

const { getConfigForRepo, resolveProposedConfig } = await import("../../src/services/configService.js");

function yamlFile(mapping) {
  return {
    content: Buffer.from(mapping, "utf-8").toString("base64"),
    sha: "blob-" + Buffer.from(mapping).toString("hex").slice(0, 12),
  };
}

beforeEach(() => {
  state.files.clear();
  state.orgRows.clear();
  state.governedRows.clear();
  state.cache.clear();
  state.transportError = null;
  state.cacheWrites = 0;
  state.repoRows = [{ full_name: "acme/app", installation_id: 1 }];
  state.orgRows.set("acme/app", { installation_id: 1, account_login: "acme" });

  mockQuery.mockImplementation(async (sql) => {
    const q = String(sql).replace(/\s+/g, " ");
    if (q.includes("SELECT r.installation_id, i.account_login")) {
      const repo = state.orgRows.get(lastRepoArg());
      return { rows: repo ? [repo] : [] };
    }
    if (q.includes("FROM repo_config rc")) {
      const governed = state.governedRows.get(lastRepoArg());
      return { rows: governed ? [governed] : [] };
    }
    if (q.includes("SELECT installation_id FROM repositories")) {
      return { rows: state.repoRows.filter((r) => r.full_name === lastRepoArg()) };
    }
    throw new Error("Unhandled SQL in W2-04 test: " + q.slice(0, 80));
  });
});

// The db mock needs the repo argument of the current call; queries above all
// take the repo full name as $1.
function lastRepoArg() {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1][1]?.[0];
}

describe("W2-04 configService canonical layering", () => {
  test("A14: no sources resolve to safe defaults (dry-run, no mutations)", async () => {
    const config = await getConfigForRepo("acme/app");
    expect(config.settings.dry_run).toBe(true);
    for (const pillar of ["triage", "ci_healing", "maintainer", "issue_fix", "enforcement", "trust", "merge_queue", "ai_review", "spam_gate"]) {
      expect(config.pillars[pillar].enabled).toBe(false);
    }
    expect(config._meta.layers).toEqual({
      defaults: true, org: false, repo: false, governed: false,
    });
    expect(config._meta.version_vector).toMatchObject({
      org: null, repo: null, governed: null,
    });
    expect(config._meta.provenance["/settings/dry_run"]).toBe("defaults");
    expect(config._meta.effective_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("A3 regression: repo YAML omitting a key inherits the org value, not defaults", async () => {
    state.files.set("acme/gitwire-config@.github/.gitwire.yml", yamlFile(`
pillars:
  triage:
    enabled: true
  ai_review:
    model: org-model-x
`));
    state.files.set("acme/app@.github/.gitwire.yml", yamlFile(`
pillars:
  triage:
    auto_label: false
`));

    const config = await getConfigForRepo("acme/app");
    // The baseline defect reset these to built-in defaults.
    expect(config.pillars.triage.enabled).toBe(true);
    expect(config.pillars.triage.auto_label).toBe(false);
    expect(config.pillars.ai_review.model).toBe("org-model-x");
    expect(config._meta.provenance["/pillars/triage/enabled"]).toBe("org");
    expect(config._meta.provenance["/pillars/ai_review/model"]).toBe("org");
    expect(config._meta.provenance["/pillars/triage/auto_label"]).toBe("repo");
    expect(config._meta.layers).toMatchObject({ org: true, repo: true });
  });

  test("A8: org/repo provenance identifies the stable source revision (blob sha)", async () => {
    const file = yamlFile("pillars:\n  triage:\n    enabled: true\n");
    state.files.set("acme/app@.gitwire.yml", file);

    const config = await getConfigForRepo("acme/app");
    expect(config._meta.version_vector.repo).toBe(`acme/app@.gitwire.yml#${file.sha}`);
    expect(config._meta.provenance_sources.repo).toBe(`acme/app@.gitwire.yml#${file.sha}`);
    expect(config._meta.layers.repo).toBe(true);
  });

  test("repo path precedence: .github/.gitwire.yml wins over .gitwire.yml", async () => {
    state.files.set("acme/app@.github/.gitwire.yml", yamlFile("pillars:\n  triage:\n    enabled: true\n"));
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  trust:\n    enabled: true\n"));

    const config = await getConfigForRepo("acme/app");
    expect(config._meta.version_vector.repo).toContain(".github/.gitwire.yml#");
    expect(config.pillars.triage.enabled).toBe(true);
    // The losing path was never consulted as a separate layer.
    expect(config._meta.provenance["/pillars/trust/enabled"]).toBe("defaults");
  });

  test("A10: governed override wins and identifies immutable promotion identity", async () => {
    state.governedRows.set("acme/app", {
      config: { pillars: { trust: { enabled: true } }, settings: { dry_run: true } },
      updated_at: new Date("2026-09-29T00:00:00Z"),
      policy_version_id: "11111111-1111-4111-8111-111111111111",
      promotion_record_id: "22222222-2222-4222-8222-222222222222",
    });

    const config = await getConfigForRepo("acme/app");
    expect(config.pillars.trust.enabled).toBe(true);
    expect(config._meta.provenance["/pillars/trust/enabled"]).toBe("governed");
    expect(config._meta.version_vector.governed).toBe(
      "policy_version:11111111-1111-4111-8111-111111111111:promotion:22222222-2222-4222-8222-222222222222",
    );
  });

  test("A11/§8: legacy repo_config row is labeled legacy, never an immutable governed version", async () => {
    state.governedRows.set("acme/app", {
      config: { pillars: { trust: { enabled: true } } },
      updated_at: new Date("2026-08-01T00:00:00Z"),
      policy_version_id: null,
      promotion_record_id: null,
    });

    const config = await getConfigForRepo("acme/app");
    expect(config._meta.version_vector.governed).toMatch(/^legacy:repo_config:2026-08-01T00:00:00\.000Z$/);
    expect(config._meta.version_vector.governed).not.toContain("policy_version");
  });

  test("A15: explicit layers enable behavior through normal precedence", async () => {
    state.files.set("acme/app@.gitwire.yml", yamlFile(`
pillars:
  triage:
    enabled: true
settings:
  dry_run: false
`));
    const config = await getConfigForRepo("acme/app");
    expect(config.pillars.triage.enabled).toBe(true);
    expect(config.settings.dry_run).toBe(false);
    expect(config._explicitKeys).toEqual(["pillars", "settings"]);
  });

  test("A18: cache stores config and metadata as one coherent bundle", async () => {
    const file = yamlFile("pillars:\n  triage:\n    enabled: true\n");
    state.files.set("acme/app@.gitwire.yml", file);

    const first = await getConfigForRepo("acme/app");
    expect(state.cacheWrites).toBe(1);

    // Source changes underneath — a cache hit must return the SAME bundle
    // (config plus its resolution evidence), never mixed state.
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  trust:\n    enabled: true\n"));
    const second = await getConfigForRepo("acme/app");

    expect(second._meta.effective_hash).toBe(first._meta.effective_hash);
    expect(second._meta.version_vector.repo).toBe(first._meta.version_vector.repo);
    expect(second.pillars.triage.enabled).toBe(true);
    expect(state.cacheWrites).toBe(1);

    const { invalidateConfigCache } = await import("../../src/services/configService.js");
    await invalidateConfigCache("acme/app");
    const third = await getConfigForRepo("acme/app");
    expect(third.pillars.triage.enabled).toBe(false);
    expect(third.pillars.trust.enabled).toBe(true);
    expect(third._meta.effective_hash).not.toBe(first._meta.effective_hash);
  });

  test("A19: repeated resolution over identical sources is hash-stable", async () => {
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  triage:\n    enabled: true\n"));
    const { invalidateConfigCache } = await import("../../src/services/configService.js");

    const first = await getConfigForRepo("acme/app");
    await invalidateConfigCache("acme/app");
    const second = await getConfigForRepo("acme/app");

    // resolved_at is observational only: whatever it happens to be (two
    // resolutions can even share a millisecond), identity does not move.
    expect(second._meta.effective_hash).toBe(first._meta.effective_hash);
    expect(second._meta.version_vector).toEqual(first._meta.version_vector);
    expect(second._meta.provenance).toEqual(first._meta.provenance);
    expect(second._meta.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Attaching arbitrary observational metadata cannot change a hash that
    // was computed before the metadata existed.
    const mutated = JSON.parse(JSON.stringify(first));
    mutated._meta.resolved_at = "1999-01-01T00:00:00.000Z";
    expect(mutated._meta.effective_hash).toBe(first._meta.effective_hash);
  });

  test("quality-gate compatibility: _meta.layers.org/repo booleans survive", async () => {
    state.files.set("acme/app@.gitwire.yml", yamlFile("quality_gates:\n  strict:\n    conditions: [{ metric: readiness_score, operator: \">=\", threshold: 70 }]\n"));
    const config = await getConfigForRepo("acme/app");
    // qualityGateService reads exactly these two surfaces.
    expect(typeof config._meta.layers.repo).toBe("boolean");
    expect(config._meta.layers.repo).toBe(true);
    expect(config._explicitKeys).toContain("quality_gates");
    // Explicit gate set replaced the built-in default gate.
    expect(config.quality_gates.default).toBeUndefined();
    expect(config.quality_gates.strict).toBeDefined();
  });

  test("invalid YAML source is rejected without partial application", async () => {
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  triage:\n    enabled: not-a-boolean\n"));
    await expect(getConfigForRepo("acme/app")).rejects.toThrow(/must be a boolean/);
    // Nothing cached from a failed resolution.
    expect(state.cache.size).toBe(0);
  });

  test("a YAML SYNTAX error in a present file is rejected, not treated as absent", async () => {
    // A present-but-unparseable document is an invalid source under the
    // sparse contract — it must never silently fall back to defaults.
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  triage:\n   enabled: [unclosed"));
    await expect(getConfigForRepo("acme/app")).rejects.toThrow(/Invalid \.gitwire\.yml: YAML syntax error:/);
    expect(state.cache.size).toBe(0);
  });

  test("the three-way classification is pinned: validation throws, 404 absent, transport absent", async () => {
    // (a) validation error → reject (proven above); (b) 404 → absent: a
    // missing file leaves the layer out without failing resolution (proven
    // by every defaults-only test); (c) non-404 transport failure → the
    // layer is treated as absent per the frozen contract row "Layer
    // unavailable → Treat layer as absent", resolution continues, and the
    // failure direction is safe (dry-run defaults).
    state.files.set("acme/app@.gitwire.yml", yamlFile("pillars:\n  triage:\n    enabled: true\n"));
    state.transportError = { status: 403, message: "Resource not accessible by integration" };

    const config = await getConfigForRepo("acme/app");
    expect(config._meta.layers.repo).toBe(false);
    expect(config._meta.layers.org).toBe(false);
    expect(config.pillars.triage.enabled).toBe(false);
    expect(config.settings.dry_run).toBe(true);
    expect(config._meta.version_vector.repo).toBeNull();
  });

  test("preview helper: proposed YAML resolves as a repo layer over the live org layer", async () => {
    state.files.set("acme/gitwire-config@.gitwire.yml", yamlFile(`
pillars:
  triage:
    enabled: true
  ai_review:
    model: org-model-x
`));
    const proposed = await resolveProposedConfig("acme/app", "pillars:\n  triage:\n    auto_label: false\n");
    expect(proposed.pillars.triage.enabled).toBe(true);
    expect(proposed.pillars.triage.auto_label).toBe(false);
    expect(proposed.pillars.ai_review.model).toBe("org-model-x");
  });

  test("preview parity: a governed value survives a proposal that omits it", async () => {
    // The invariant the exact-head review demanded: for a repo with governed
    // dry_run=false, a repo-layer proposal that omits dry_run must preview
    // dry_run=false — the proposal cannot flip a promoted value to defaults.
    state.governedRows.set("acme/app", {
      config: { settings: { dry_run: false } },
      updated_at: new Date("2026-09-29T00:00:00Z"),
      policy_version_id: "33333333-3333-4333-8333-333333333333",
      promotion_record_id: "44444444-4444-4444-8444-444444444444",
    });
    const proposed = await resolveProposedConfig("acme/app", "pillars:\n  triage:\n    enabled: true\n");
    expect(proposed.settings.dry_run).toBe(false);
    // And the live stack agrees.
    const live = await getConfigForRepo("acme/app");
    expect(live.settings.dry_run).toBe(false);
  });

  test("a governed-supplied 'default' gate survives YAML gate-set stripping", async () => {
    state.governedRows.set("acme/app", {
      config: {
        quality_gates: {
          default: {
            conditions: [{ metric: "readiness_score", operator: ">=", threshold: 95 }],
            block_on_fail: false,
          },
        },
      },
      updated_at: new Date("2026-09-29T00:00:00Z"),
      policy_version_id: "33333333-3333-4333-8333-333333333333",
      promotion_record_id: "44444444-4444-4444-8444-444444444444",
    });
    state.files.set("acme/app@.gitwire.yml", yamlFile(`
quality_gates:
  strict:
    conditions: [{ metric: readiness_score, operator: ">=", threshold: 70 }]
`));
    const config = await getConfigForRepo("acme/app");
    // The YAML gate set stripped nothing governed: the promoted 'default'
    // gate keeps its promoted threshold, and the YAML gate is present.
    expect(config.quality_gates.default.conditions[0].threshold).toBe(95);
    expect(config.quality_gates.strict).toBeDefined();
  });
});
