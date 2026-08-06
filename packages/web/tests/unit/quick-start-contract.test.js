// tests/unit/quick-start-contract.test.js
// PR-01 regression test: verifies README Quick Start and dev compose are consistent.
// Does not require Docker, network, credentials, or a database.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const README_PATH = join(REPO_ROOT, "README.md");
const COMPOSE_PATH = join(REPO_ROOT, "packages", "web", "docker", "docker-compose.yml");

describe("PR-01: README Quick Start contract", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const compose = readFileSync(COMPOSE_PATH, "utf8");

  it("README references packages/web/docker/docker-compose.yml", () => {
    expect(readme).toContain("packages/web/docker/docker-compose.yml");
  });

  it("the documented compose path exists", () => {
    expect(existsSync(COMPOSE_PATH)).toBe(true);
  });

  it("README no longer instructs 'cd docker'", () => {
    // The old broken Quick Start had "cd docker\ndocker compose up -d"
    expect(readme).not.toMatch(/cd docker\n/);
  });

  it("README uses a health-aware startup command (--wait)", () => {
    expect(readme).toContain("up -d --wait");
  });

  it("README documents backend and dashboard startup separately", () => {
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("npm --workspace=web-dashboard run dev");
  });

  it("README separates external credentials from infrastructure startup", () => {
    expect(readme).toContain("not");
    expect(readme).toMatch(/GitHub App credentials/i);
    expect(readme).toMatch(/Anthropic/i);
  });

  it("README documents the health verification command", () => {
    expect(readme).toContain("curl http://localhost:3000/health");
  });
});

describe("PR-01: development compose contract", () => {
  const compose = readFileSync(COMPOSE_PATH, "utf8");

  it("compose does not reference /docker-entrypoint-initdb.d", () => {
    expect(compose).not.toContain("/docker-entrypoint-initdb.d");
  });

  it("compose defines a PostgreSQL health check", () => {
    expect(compose).toContain("pg_isready");
  });

  it("compose defines a Redis health check", () => {
    expect(compose).toContain("redis-cli");
  });

  it("compose contains only postgres and redis services", () => {
    expect(compose).toMatch(/postgres:/);
    expect(compose).toMatch(/redis:/);
    // Should not contain application/dashboard/executor services
    expect(compose).not.toMatch(/gitwire-app/);
    expect(compose).not.toMatch(/gitwire-dashboard/);
    expect(compose).not.toMatch(/gitwire-executor/);
  });

  it("compose usage comments reference repository-root commands", () => {
    expect(compose).toContain("packages/web/docker/docker-compose.yml");
  });
});

describe("PR-01: README and compose path agreement", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const compose = readFileSync(COMPOSE_PATH, "utf8");

  it("both reference the same compose path", () => {
    const path = "packages/web/docker/docker-compose.yml";
    expect(readme).toContain(path);
    expect(compose).toContain(path);
  });
});
