/**
 * Editor settings of the app admins: pages scenes may embed (E2).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseHostPattern } from "../src/editor/settings.js";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

describe("host patterns for embeds", () => {
  it("accepts https hosts and wildcards, nothing else", () => {
    expect(parseHostPattern("https://Wiki.Intranet.example/")).toBe(
      "wiki.intranet.example",
    );
    expect(parseHostPattern("*.intranet.example")).toBe("*.intranet.example");
    expect(parseHostPattern("grafana.intranet.example:8443")).toBe(
      "grafana.intranet.example:8443",
    );
    for (const bad of [
      "*",
      "*.com",
      "http://wiki.intranet.example",
      "wiki.intranet.example/space",
      "wiki intranet",
      // eslint-disable-next-line no-script-url
      "javascript:alert(1)",
      "'self'",
      "wiki.intranet.example:99999",
      "",
    ]) {
      expect(parseHostPattern(bad)).toBeNull();
    }
  });
});

describeWithDb("editor settings", () => {
  let env: TestEnv;
  let staticDir: string | null = null;

  afterEach(async () => {
    await env?.close();
    if (staticDir) {
      await rm(staticDir, { recursive: true, force: true });
      staticDir = null;
    }
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    return (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
  };

  it("lets app admins allow intranet pages and switch external services", async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), "excalidraw-static-"));
    await writeFile(
      path.join(staticDir, "index.html"),
      '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    );
    env = await createTestEnv({
      STATIC_DIR: staticDir,
      CSP_FRAME_SRC: "https://grafana.intranet.example",
    });
    const admin = await person(alice);
    const user = await person(bob);
    const frameSrc = async () =>
      /frame-src [^;]*/.exec(
        String(
          (await env.built.app.inject({ method: "GET", url: "/" })).headers[
            "content-security-policy"
          ],
        ),
      )?.[0];

    // nothing but the app itself and what the operators configured
    expect(await frameSrc()).toBe(
      "frame-src 'self' https://grafana.intranet.example",
    );
    expect((await user("GET", "/api/auth/me")).json().config.embeds).toEqual({
      allowedHosts: [],
      external: false,
    });

    expect((await user("GET", "/api/admin/embeds")).statusCode).toBe(403);
    expect(
      (await user("PUT", "/api/admin/embeds", { external: true })).statusCode,
    ).toBe(403);
    const bad = await admin("PUT", "/api/admin/embeds", {
      allowedHosts: ["wiki.intranet.example", "http://alt.intranet.example"],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/alt\.intranet\.example/);

    const saved = await admin("PUT", "/api/admin/embeds", {
      allowedHosts: [
        "https://wiki.intranet.example/",
        "*.dashboards.intranet.example",
        "wiki.intranet.example",
      ],
    });
    expect(saved.json().settings).toEqual({
      allowedHosts: ["wiki.intranet.example", "*.dashboards.intranet.example"],
      external: false,
    });
    expect((await user("GET", "/api/auth/me")).json().config.embeds).toEqual({
      allowedHosts: ["wiki.intranet.example", "*.dashboards.intranet.example"],
      external: false,
    });
    expect(await frameSrc()).toBe(
      "frame-src 'self' https://grafana.intranet.example https://wiki.intranet.example https://*.dashboards.intranet.example",
    );

    await admin("PUT", "/api/admin/embeds", { external: true });
    expect(await frameSrc()).toContain("https://www.youtube.com");
    expect((await admin("GET", "/api/admin/embeds")).json()).toEqual({
      settings: {
        allowedHosts: [
          "wiki.intranet.example",
          "*.dashboards.intranet.example",
        ],
        external: true,
      },
      configured: ["https://grafana.intranet.example"],
    });

    const events = await env.built.ctx.db
      .selectFrom("events")
      .select("type")
      .where("type", "=", "admin.embed_settings")
      .execute();
    expect(events).toHaveLength(2);
  });
});
