import { afterEach, describe, expect, it } from "vitest";

import { withParentGroups } from "../src/auth/claims.js";

import {
  alice,
  bob,
  cookiePair,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { TestEnv } from "./helpers/setup.js";

describe("withParentGroups", () => {
  it("adds the parents of Keycloak group paths", () => {
    expect(
      withParentGroups(["/IT/Architektur/Cloud", "/Vertrieb", "/IT"]),
    ).toEqual(["/IT", "/IT/Architektur", "/IT/Architektur/Cloud", "/Vertrieb"]);
  });

  it("keeps plain group names", () => {
    expect(withParentGroups(["Architektur", "IT"])).toEqual([
      "Architektur",
      "IT",
    ]);
  });
});

describeWithDb("authentication", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  it("rejects API calls without a session", async () => {
    env = await createTestEnv();
    const response = await env.built.app.inject({ url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("unauthenticated");
  });

  it("logs in through the identity provider and maps roles and groups", async () => {
    env = await createTestEnv();
    const cookie = await env.login(alice, "/?foo=1");
    const me = await env.built.app.inject({
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user).toMatchObject({
      name: "Alice Admin",
      email: "alice@example.test",
      username: "alice",
      isAdmin: true,
    });
    expect(body.config.maxFileSizeBytes).toBe(25 * 1024 * 1024);
    expect(body.config.maxImageDimension).toBe(3840);

    const user = await env.built.ctx.db
      .selectFrom("users")
      .selectAll()
      .where("oidc_subject", "=", "alice")
      .executeTakeFirstOrThrow();
    expect(user.groups).toEqual(["/IT", "/IT/Architektur"]);
    expect(user.roles).toContain("excalidraw-admin");
  });

  it("redirects back to the requested relative path only", async () => {
    env = await createTestEnv();
    env.oidc.setUser(bob);
    const start = await env.built.app.inject({
      url: `/api/auth/login?returnTo=${encodeURIComponent(
        "https://evil.example/x",
      )}`,
    });
    const row = await env.built.ctx.db
      .selectFrom("login_states")
      .select("return_to")
      .executeTakeFirstOrThrow();
    expect(start.statusCode).toBe(302);
    expect(row.return_to).toBe("/");
  });

  it("denies users without the required role", async () => {
    env = await createTestEnv({ OIDC_REQUIRED_ROLE: "excalidraw-user" });
    // bob has the role
    await expect(env.login(bob)).resolves.toContain("excalidraw_session=");
    // carol has no roles at all
    await expect(env.login({ sub: "carol", name: "Carol" })).rejects.toThrow(
      /403/,
    );
  });

  it("rejects a callback without the browser-bound login cookie", async () => {
    env = await createTestEnv();
    env.oidc.setUser(bob);
    const start = await env.built.app.inject({ url: "/api/auth/login" });
    const idp = await fetch(String(start.headers.location), {
      redirect: "manual",
    });
    const callbackUrl = new URL(idp.headers.get("location")!);
    const callback = await env.built.app.inject({
      url: callbackUrl.pathname + callbackUrl.search,
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain("Anmeldung abgelaufen");
    expect(cookiePair(callback.headers, "excalidraw_session=")).toBeNull();
  });

  it("logs out locally and returns the Keycloak logout URL", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const logout = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: ORIGIN },
    });
    expect(logout.statusCode).toBe(200);
    const redirectUrl = new URL(logout.json().redirectUrl);
    expect(redirectUrl.pathname).toMatch(/\/logout$/);
    expect(redirectUrl.searchParams.get("id_token_hint")).toBeTruthy();
    expect(redirectUrl.searchParams.get("post_logout_redirect_uri")).toBe(
      "http://localhost:3999/",
    );

    const me = await env.built.app.inject({
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it("ends sessions on a valid back-channel logout token only", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const sid = env.oidc.sidOf("bob")!;

    const forged = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `logout_token=${encodeURIComponent("a.b.c")}`,
    });
    expect(forged.statusCode).toBe(400);

    const token = await env.oidc.createLogoutToken({ sid, sub: "bob" });
    const valid = await env.built.app.inject({
      method: "POST",
      url: "/api/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `logout_token=${encodeURIComponent(token)}`,
    });
    expect(valid.statusCode).toBe(200);

    const me = await env.built.app.inject({
      url: "/api/auth/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it("blocks state-changing requests from other origins", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const response = await env.built.app.inject({
      method: "POST",
      url: "/api/v2/post/",
      headers: {
        cookie,
        origin: "https://other-app.example",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("payload"),
    });
    expect(response.statusCode).toBe(403);

    // without any origin information the cookie alone is not enough
    const post = (headers: Record<string, string>) =>
      env.built.app.inject({
        method: "POST",
        url: "/api/v2/post/",
        headers: {
          cookie,
          "content-type": "application/octet-stream",
          ...headers,
        },
        payload: Buffer.from("payload"),
      });
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ "sec-fetch-site": "same-site" })).statusCode).toBe(
      403,
    );
    expect((await post({ "sec-fetch-site": "same-origin" })).statusCode).toBe(
      200,
    );
  });
});

describe("configuration", () => {
  it("names all missing required variables at once", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig({})).toThrow(
      /PUBLIC_URL is required[\s\S]*OIDC_ISSUER_URL is required[\s\S]*DATABASE_URL is required[\s\S]*OIDC_CLIENT_ID is required/,
    );
  });

  it("refuses plain http outside localhost", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() =>
      loadConfig({
        PUBLIC_URL: "http://excalidraw.intranet.example",
        DATABASE_URL: "postgres://x",
        OIDC_ISSUER_URL: "https://sso.example/realms/x",
        OIDC_CLIENT_ID: "excalidraw",
        DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      }),
    ).toThrow(/PUBLIC_URL must use https/);
  });

  it("requires a 32-byte data encryption key", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(() =>
      loadConfig({
        PUBLIC_URL: "https://excalidraw.intranet.example",
        DATABASE_URL: "postgres://x",
        OIDC_ISSUER_URL: "https://sso.example/realms/x",
        OIDC_CLIENT_ID: "excalidraw",
        DATA_ENCRYPTION_KEY: "dG9vIHNob3J0",
      }),
    ).toThrow(/DATA_ENCRYPTION_KEY must be 32 random bytes/);
  });
});
