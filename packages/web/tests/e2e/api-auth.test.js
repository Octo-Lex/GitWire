// tests/e2e/api-auth.test.js
// A1: Dashboard Auth. Tests login, session check, and logout.

import { jest } from "@jest/globals";
import { API_BASE, API_KEY } from "./helpers.js";

describe("A1: Auth API", function () {
  jest.setTimeout(30000);

  it("login with valid API key returns session cookie", async function () {
    const res = await fetch(API_BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: API_KEY }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("gitwire-session");
  });

  it("login with invalid API key returns 401", async function () {
    const res = await fetch(API_BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "invalid-key" }),
    });
    expect(res.status).toBe(401);
  });

  it("check endpoint without cookie returns 200 with authenticated=false", async function () {
    const res = await fetch(API_BASE + "/api/auth/check");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("full auth flow: login → check → logout", async function () {
    const loginRes = await fetch(API_BASE + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: API_KEY }),
    });
    const cookie = loginRes.headers.get("set-cookie");

    const checkRes = await fetch(API_BASE + "/api/auth/check", {
      headers: { Cookie: cookie },
    });
    expect(checkRes.status).toBe(200);

    const logoutRes = await fetch(API_BASE + "/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);
  });
});
