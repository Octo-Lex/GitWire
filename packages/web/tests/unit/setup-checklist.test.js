// tests/unit/setup-checklist.test.js
// Tests for the first-run setup checklist — pure function logic, route contract,
// and no-secrets assertion.
//
// Covers all four acceptance states:
//   healthy, missing-config, partial-config (action_needed), error (degraded)

import { jest } from "@jest/globals";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

// ── Mock dependencies before importing the service ──────────────────────
// Following the pattern from pure-logic.test.js

jest.unstable_mockModule("../../config/index.js", () => ({
  config: {
    github: {
      appId: "test-app-id",
      privateKey: "test-key",
      webhookSecret: "test",
      clientId: "test",
      clientSecret: "test",
    },
    server: {
      port: 3000,
      env: "test",
      logLevel: "info",
      baseUrl: "http://localhost:3000",
    },
    db: { url: "postgres://test:test@localhost/test" },
    redis: { url: "redis://localhost:6379" },
    anthropic: { apiKey: "test", baseURL: undefined },
  },
}));

jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: jest.fn() },
}));

jest.unstable_mockModule("../../src/lib/queue.js", () => ({
  redis: { ping: jest.fn() },
  createWorker: jest.fn(),
  QUEUES: {},
}));

jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { computeSetupStatus } = await import(
  "../../src/services/setupService.js"
);

// ── Helper: build a full check set with all passing ──────────────────────

function makeChecks(overrides = {}) {
  const defaults = [
    {
      id: "github_app_configured",
      label: "GitHub App configured",
      category: "config",
      status: "pass",
      blocking: true,
      detail: "GitHub App ID and private key are set",
    },
    {
      id: "database_connected",
      label: "Database connected",
      category: "infra",
      status: "pass",
      blocking: true,
      detail: "PostgreSQL is reachable",
    },
    {
      id: "redis_connected",
      label: "Redis connected",
      category: "infra",
      status: "pass",
      blocking: true,
      detail: "Redis is reachable",
    },
    {
      id: "installations_linked",
      label: "GitHub App installed",
      category: "integration",
      status: "pass",
      blocking: true,
      detail: "1 installation(s) linked",
    },
    {
      id: "repos_synced",
      label: "Repositories synced",
      category: "integration",
      status: "pass",
      blocking: true,
      detail: "5 repos synced",
    },
    {
      id: "webhooks_receiving",
      label: "Webhook events received",
      category: "integration",
      status: "pass",
      blocking: false,
      detail: "10 event(s) in last 7 days",
    },
    {
      id: "gitwire_yml_found",
      label: "Policy file configured",
      category: "policy",
      status: "pass",
      blocking: false,
      detail: "3 repo(s) with config overrides",
    },
    {
      id: "dry_run_status",
      label: "Dry-run mode",
      category: "policy",
      status: "pass",
      blocking: false,
      detail: "Dry-run enabled",
    },
  ];
  return defaults.map((d) =>
    overrides[d.id] ? { ...d, ...overrides[d.id] } : d
  );
}

// ── Tests: computeSetupStatus ────────────────────────────────────────────

describe("Setup Checklist — computeSetupStatus", () => {
  describe("healthy state (ready)", () => {
    it("returns 'ready' when all checks pass", () => {
      const result = computeSetupStatus(makeChecks());
      expect(result.overall).toBe("ready");
      expect(result.completed).toBe(8);
      expect(result.total).toBe(8);
      expect(result.next_step).toBeNull();
    });
  });

  describe("missing config (not_configured)", () => {
    it("returns 'not_configured' when GitHub App is not configured", () => {
      const result = computeSetupStatus(
        makeChecks({
          github_app_configured: {
            status: "fail",
            detail: "Missing GitHub App credentials",
          },
        })
      );
      expect(result.overall).toBe("not_configured");
      expect(result.completed).toBe(7);
    });

    it("returns 'not_configured' when database fails (blocking infra)", () => {
      const result = computeSetupStatus(
        makeChecks({
          database_connected: {
            status: "fail",
            detail: "Cannot connect to PostgreSQL",
          },
        })
      );
      expect(result.overall).toBe("not_configured");
    });

    it("returns 'not_configured' when Redis fails (blocking infra)", () => {
      const result = computeSetupStatus(
        makeChecks({
          redis_connected: {
            status: "fail",
            detail: "Cannot connect to Redis",
          },
        })
      );
      expect(result.overall).toBe("not_configured");
    });

    it("points next_step to the config issue", () => {
      const result = computeSetupStatus(
        makeChecks({
          github_app_configured: {
            status: "fail",
            detail: "Missing credentials",
          },
        })
      );
      expect(result.next_step).not.toBeNull();
      expect(result.next_step.id).toBe("github_app_configured");
      expect(result.next_step.recommendation).toMatch(/GITHUB_APP_ID/);
    });
  });

  describe("partial config (action_needed)", () => {
    it("returns 'action_needed' when no installations linked (blocking integration)", () => {
      const result = computeSetupStatus(
        makeChecks({
          installations_linked: {
            status: "fail",
            detail: "No installations",
          },
        })
      );
      expect(result.overall).toBe("action_needed");
    });

    it("returns 'action_needed' when no repos synced (blocking integration)", () => {
      const result = computeSetupStatus(
        makeChecks({
          repos_synced: { status: "fail", detail: "No repos synced" },
        })
      );
      expect(result.overall).toBe("action_needed");
    });

    it("returns 'action_needed' when dry-run is off (non-blocking warning)", () => {
      const result = computeSetupStatus(
        makeChecks({
          dry_run_status: {
            status: "warn",
            detail: "Live mode active",
          },
        })
      );
      expect(result.overall).toBe("action_needed");
    });

    it("returns 'action_needed' when no webhooks received (non-blocking warning)", () => {
      const result = computeSetupStatus(
        makeChecks({
          webhooks_receiving: {
            status: "warn",
            detail: "No webhook events received yet",
          },
        })
      );
      expect(result.overall).toBe("action_needed");
    });

    it("returns 'action_needed' when no .gitwire.yml (non-blocking warning)", () => {
      const result = computeSetupStatus(
        makeChecks({
          gitwire_yml_found: {
            status: "warn",
            detail: "Using defaults",
          },
        })
      );
      expect(result.overall).toBe("action_needed");
    });
  });

  describe("error state (degraded)", () => {
    it("returns 'degraded' when database check errors", () => {
      const result = computeSetupStatus(
        makeChecks({
          database_connected: {
            status: "error",
            detail: "Connection refused",
          },
        })
      );
      expect(result.overall).toBe("degraded");
    });

    it("returns 'degraded' when any check errors, even non-blocking", () => {
      const result = computeSetupStatus(
        makeChecks({
          webhooks_receiving: {
            status: "error",
            detail: "Query failed",
          },
        })
      );
      expect(result.overall).toBe("degraded");
    });

    it("degraded takes priority over not_configured", () => {
      const result = computeSetupStatus(
        makeChecks({
          github_app_configured: {
            status: "fail",
            detail: "Missing",
          },
          database_connected: {
            status: "error",
            detail: "Connection refused",
          },
        })
      );
      expect(result.overall).toBe("degraded");
    });
  });

  describe("next_step priority ordering", () => {
    it("prioritizes config issues over integration issues", () => {
      const result = computeSetupStatus(
        makeChecks({
          github_app_configured: { status: "fail", detail: "Missing" },
          installations_linked: { status: "fail", detail: "None" },
        })
      );
      expect(result.next_step.id).toBe("github_app_configured");
    });

    it("prioritizes infra issues over integration issues", () => {
      const result = computeSetupStatus(
        makeChecks({
          redis_connected: { status: "fail", detail: "Down" },
          repos_synced: { status: "fail", detail: "None" },
        })
      );
      expect(result.next_step.id).toBe("redis_connected");
    });

    it("prioritizes integration issues over policy warnings", () => {
      const result = computeSetupStatus(
        makeChecks({
          installations_linked: { status: "fail", detail: "None" },
          dry_run_status: { status: "warn", detail: "Live mode" },
        })
      );
      expect(result.next_step.id).toBe("installations_linked");
    });

    it("includes recommendation text for next step", () => {
      const result = computeSetupStatus(
        makeChecks({
          webhooks_receiving: {
            status: "warn",
            detail: "No events",
          },
        })
      );
      expect(result.next_step).not.toBeNull();
      expect(result.next_step.recommendation).toMatch(/webhook/i);
    });
  });

  describe("completed count", () => {
    it("counts only passing checks", () => {
      const result = computeSetupStatus(
        makeChecks({
          database_connected: { status: "error", detail: "Down" },
          dry_run_status: { status: "warn", detail: "Live" },
        })
      );
      expect(result.completed).toBe(6); // 8 - 2 non-pass
      expect(result.total).toBe(8);
    });
  });
});

// ── Tests: service source contract ────────────────────────────────────────

describe("Setup Checklist — service source contract", () => {
  const service = readSource("packages/web/src/services/setupService.js");

  it("exports computeSetupStatus as a pure function", () => {
    expect(service).toMatch(/export function computeSetupStatus/);
  });

  it("exports getSetupStatus as async gatherer", () => {
    expect(service).toMatch(/export async function getSetupStatus/);
  });

  it("uses parameterized queries (no string interpolation)", () => {
    expect(service).toMatch(/db\.query\(/);
    expect(service).not.toMatch(/db\.query\(.*\$\{.*\}/);
  });

  it("never returns secret values (only boolean presence for github app)", () => {
    // The checkGithubApp function should reference appId/privateKey as booleans
    expect(service).toMatch(/!!config\.github\?\.appId/);
    expect(service).toMatch(/!!config\.github\?\.privateKey/);
    // Should NOT return the actual values
    expect(service).not.toMatch(/return.*appId.*config/);
    expect(service).not.toMatch(/return.*privateKey.*config/);
  });

  it("marks github_app_configured as blocking", () => {
    expect(service).toMatch(/id:\s*"github_app_configured"[\s\S]*?blocking:\s*true/);
  });

  it("marks dry_run_status as non-blocking", () => {
    expect(service).toMatch(/id:\s*"dry_run_status"[\s\S]*?blocking:\s*false/);
  });

  it("marks webhooks_receiving as non-blocking", () => {
    expect(service).toMatch(/id:\s*"webhooks_receiving"[\s\S]*?blocking:\s*false/);
  });

  it("marks gitwire_yml_found as non-blocking", () => {
    expect(service).toMatch(/id:\s*"gitwire_yml_found"[\s\S]*?blocking:\s*false/);
  });

  it("uses warn (not fail) for quiet webhooks", () => {
    const webhooksSection = service.match(
      /async function checkWebhooks[\s\S]*?^}/m
    );
    expect(webhooksSection).toBeTruthy();
    expect(webhooksSection[0]).toMatch(/status:\s*cnt > 0 \? "pass" : "warn"/);
  });
});

// ── Tests: route source contract ───────────────────────────────────────────

describe("Setup Checklist — route source contract", () => {
  const route = readSource("packages/web/src/routes/setup.js");
  const app = readSource("packages/web/src/app.js");

  it("route file exists and exports default router", () => {
    expect(route).toMatch(/export default router/);
  });

  it("defines GET / handler", () => {
    expect(route).toMatch(/router\.get\("\/"/);
  });

  it("calls getSetupStatus from the service", () => {
    expect(route).toMatch(/getSetupStatus/);
  });

  it("handles errors with 500 response", () => {
    expect(route).toMatch(/status\(500\)/);
  });

  it("is mounted at /api/setup in app.js", () => {
    expect(app).toMatch(/\/api\/setup/);
    expect(app).toMatch(/setupRouter/);
  });
});

// ── Tests: no secrets in response shape ────────────────────────────────────

describe("Setup Checklist — no secrets exposed", () => {
  const service = readSource("packages/web/src/services/setupService.js");

  it("does not reference ANTHROPIC_API_KEY in any detail string", () => {
    expect(service).not.toMatch(/detail.*ANTHROPIC_API_KEY/i);
  });

  it("does not include clientSecret in any return value", () => {
    expect(service).not.toMatch(/return.*clientSecret/i);
  });

  it("does not include webhookSecret in any return value", () => {
    expect(service).not.toMatch(/return.*webhookSecret/i);
  });

  it("GitHub App check uses boolean coercion only", () => {
    expect(service).toMatch(/!!config\.github\?\.appId/);
    expect(service).toMatch(/!!config\.github\?\.privateKey/);
  });
});

// ── Tests: dashboard integration ──────────────────────────────────────────

describe("Setup Checklist — dashboard integration", () => {
  const apiSource = readSource(
    "packages/web-dashboard/src/lib/api.ts"
  );
  const pageSource = readSource(
    "packages/web-dashboard/src/app/page.tsx"
  );
  const componentSource = readSource(
    "packages/web-dashboard/src/components/SetupChecklist.tsx"
  );

  it("API client has setup() endpoint", () => {
    expect(apiSource).toMatch(/setup:\s*\(\)\s*=>\s*`\/api\/setup`/);
  });

  it("home page imports SetupChecklist", () => {
    expect(pageSource).toMatch(/import SetupChecklist/);
  });

  it("home page renders SetupChecklist component", () => {
    expect(pageSource).toMatch(/<SetupChecklist/);
  });

  it("component auto-hides when overall is ready", () => {
    expect(componentSource).toMatch(
      /setup\.overall === "ready".*return null/
    );
  });

  it("component fetches from setup endpoint with SWR", () => {
    expect(componentSource).toMatch(/useSWR/);
    expect(componentSource).toMatch(/API\.setup\(\)/);
  });

  it("component shows next step recommendation", () => {
    expect(componentSource).toMatch(/next_step/);
    expect(componentSource).toMatch(/recommendation/);
  });
});
