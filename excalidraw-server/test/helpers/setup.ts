import pg from "pg";
import { describe } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

import { startFakeOidc } from "./fakeOidc.js";

import type { BuiltApp } from "../../src/app.js";
import type { FakeOidc, FakeUser } from "./fakeOidc.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "";

export const PUBLIC_URL = "http://localhost:3999";
export const ORIGIN = PUBLIC_URL;

/** run the database tests only where a throwaway database is configured */
export const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

export const resetDatabase = async () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query(
    "drop schema if exists public cascade; create schema public;",
  );
  await client.end();
};

export interface TestEnv {
  built: BuiltApp;
  oidc: FakeOidc;
  login: (user: FakeUser, returnTo?: string) => Promise<string>;
  close: () => Promise<void>;
}

const getSetCookie = (headers: Record<string, unknown>): string[] => {
  const value = headers["set-cookie"];
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [String(value)];
};

/** "name=value" for the cookie with the given name prefix */
export const cookiePair = (
  headers: Record<string, unknown>,
  prefix: string,
) => {
  const cookie = getSetCookie(headers).find((c) => c.startsWith(prefix));
  return cookie ? cookie.split(";")[0] : null;
};

export const createTestEnv = async (
  env: Record<string, string> = {},
): Promise<TestEnv> => {
  await resetDatabase();
  const oidc = await startFakeOidc();
  const config = loadConfig({
    PUBLIC_URL,
    DATABASE_URL: TEST_DATABASE_URL,
    OIDC_ISSUER_URL: oidc.issuer,
    OIDC_CLIENT_ID: oidc.clientId,
    OIDC_CLIENT_SECRET: oidc.clientSecret,
    OIDC_ALLOW_INSECURE_HTTP: "true",
    LOG_LEVEL: "warn",
    ...env,
  });
  const built = await buildApp(config, { logger: false });

  const login = async (user: FakeUser, returnTo = "/") => {
    oidc.setUser(user);
    const start = await built.app.inject({
      method: "GET",
      url: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    if (start.statusCode !== 302) {
      throw new Error(`login start failed: ${start.statusCode} ${start.body}`);
    }
    const loginCookie = cookiePair(start.headers, "excalidraw_login_");
    const idpResponse = await fetch(String(start.headers.location), {
      redirect: "manual",
    });
    const callbackUrl = new URL(idpResponse.headers.get("location")!);
    const callback = await built.app.inject({
      method: "GET",
      url: callbackUrl.pathname + callbackUrl.search,
      headers: loginCookie ? { cookie: loginCookie } : {},
    });
    if (callback.statusCode !== 302) {
      throw new Error(
        `login callback failed: ${callback.statusCode} ${callback.body}`,
      );
    }
    const session = cookiePair(callback.headers, "excalidraw_session=");
    if (!session) {
      throw new Error("no session cookie after login");
    }
    return session;
  };

  return {
    built,
    oidc,
    login,
    close: async () => {
      await built.close();
      await oidc.close();
    },
  };
};

export const alice: FakeUser = {
  sub: "alice",
  name: "Alice Admin",
  email: "alice@example.test",
  preferred_username: "alice",
  clientRoles: ["excalidraw-admin"],
  groups: ["/IT", "/IT/Architektur"],
};

export const bob: FakeUser = {
  sub: "bob",
  name: "Bob Beispiel",
  email: "bob@example.test",
  preferred_username: "bob",
  realmRoles: ["excalidraw-user"],
};
