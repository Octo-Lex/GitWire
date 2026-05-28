// tests/unit/lib-github-sanitize.test.js
// Unit tests for the GitHub webhook payload sanitizer.

import {
  sanitizeWebhookPayload,
  isGitHubRepoObject,
  sanitizeRepoView,
} from "../../src/lib/githubSanitize.js";

describe("githubSanitize", function () {
  // ── isGitHubRepoObject ──────────────────────────────────────────────────

  describe("isGitHubRepoObject()", function () {
    it("identifies repo objects", function () {
      expect(isGitHubRepoObject({
        full_name: "acme/app",
        html_url:  "https://github.com/acme/app",
        private:   false,
      })).toBe(true);
    });

    it("rejects non-repo objects", function () {
      expect(isGitHubRepoObject({ login: "user" })).toBe(false);
      expect(isGitHubRepoObject(null)).toBe(false);
      expect(isGitHubRepoObject([])).toBe(false);
    });
  });

  // ── sanitizeWebhookPayload ──────────────────────────────────────────────

  describe("sanitizeWebhookPayload()", function () {
    it("strips permissions and role_name from repo objects", function () {
      const payload = {
        action: "opened",
        repository: {
          id:         123,
          full_name:  "acme/app",
          html_url:   "https://github.com/acme/app",
          private:    false,
          name:       "app",
          permissions: { admin: true, push: true },
          role_name:  "admin",
        },
      };

      const sanitized = sanitizeWebhookPayload(payload);

      expect(sanitized.repository.id).toBe(123);
      expect(sanitized.repository.name).toBe("app");
      expect(sanitized.repository.permissions).toBeUndefined();
      expect(sanitized.repository.role_name).toBeUndefined();
    });

    it("strips temp_clone_token", function () {
      const payload = {
        repository: {
          id:            123,
          full_name:     "acme/app",
          html_url:      "https://github.com/acme/app",
          private:       true,
          temp_clone_token: "secret-token-123",
        },
      };

      const sanitized = sanitizeWebhookPayload(payload);
      expect(sanitized.repository.temp_clone_token).toBeUndefined();
    });

    it("strips token fields at any depth", function () {
      const payload = {
        repository: {
          id:        123,
          full_name: "acme/app",
          html_url:  "https://github.com/acme/app",
          private:   false,
          nested: {
            token: "secret",
            safe:  "value",
          },
        },
      };

      const sanitized = sanitizeWebhookPayload(payload);
      expect(sanitized.repository.nested.token).toBeUndefined();
      expect(sanitized.repository.nested.safe).toBe("value");
    });

    it("preserves safe fields", function () {
      const payload = {
        action: "opened",
        sender: { login: "alice", id: 42 },
        repository: {
          id:        123,
          full_name: "acme/app",
          html_url:  "https://github.com/acme/app",
          private:   false,
          name:      "app",
          owner:     { login: "acme", id: 99 },
        },
      };

      const sanitized = sanitizeWebhookPayload(payload);
      expect(sanitized.action).toBe("opened");
      expect(sanitized.sender.login).toBe("alice");
      expect(sanitized.repository.name).toBe("app");
      expect(sanitized.repository.owner.login).toBe("acme");
    });

    it("handles non-object inputs gracefully", function () {
      expect(sanitizeWebhookPayload(null)).toBeNull();
      expect(sanitizeWebhookPayload("string")).toBe("string");
      expect(sanitizeWebhookPayload(42)).toBe(42);
    });

    it("handles arrays in payload", function () {
      const payload = {
        repositories: [
          {
            id:        1,
            full_name: "a/b",
            html_url:  "https://github.com/a/b",
            private:   false,
            permissions: { admin: true },
          },
          {
            id:        2,
            full_name: "c/d",
            html_url:  "https://github.com/c/d",
            private:   true,
            permissions: { push: true },
          },
        ],
      };

      const sanitized = sanitizeWebhookPayload(payload);
      expect(sanitized.repositories[0].permissions).toBeUndefined();
      expect(sanitized.repositories[1].permissions).toBeUndefined();
      expect(sanitized.repositories[0].id).toBe(1);
    });

    it("does not mutate the original payload", function () {
      const payload = {
        repository: {
          id:        123,
          full_name: "acme/app",
          html_url:  "https://github.com/acme/app",
          private:   false,
          permissions: { admin: true },
        },
      };

      sanitizeWebhookPayload(payload);
      expect(payload.repository.permissions).toEqual({ admin: true });
    });
  });

  // ── sanitizeRepoView ─────────────────────────────────────────────────────

  describe("sanitizeRepoView()", function () {
    it("only keeps allowlisted fields", function () {
      const repo = {
        id:            123,
        full_name:     "acme/app",
        html_url:      "https://github.com/acme/app",
        private:       false,
        name:          "app",
        description:   "An app",
        permissions:   { admin: true },
        role_name:     "admin",
        temp_clone_token: "secret",
        source:        { full_name: "orig/app", html_url: "https://github.com/orig/app", private: false },
      };

      const sanitized = sanitizeRepoView(repo);
      expect(sanitized.id).toBe(123);
      expect(sanitized.name).toBe("app");
      expect(sanitized.description).toBe("An app");
      expect(sanitized.permissions).toBeUndefined();
      expect(sanitized.role_name).toBeUndefined();
      expect(sanitized.temp_clone_token).toBeUndefined();
      expect(sanitized.source).toBeUndefined(); // not in allowlist
    });
  });
});
