/**
 * Company fonts (E3): uploaded by app admins, in everyone's font menu,
 * embedded in exports.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WOFF2 = path.resolve(
  here,
  "../../packages/excalidraw/fonts/Liberation/LiberationSans-Regular.woff2",
);
const TTF = path.resolve(
  here,
  "../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf",
);

describeWithDb("company fonts", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const app = (
      method: string,
      url: string,
      payload?: unknown,
      contentType?: string,
    ) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: {
          cookie,
          origin: ORIGIN,
          ...(contentType ? { "content-type": contentType } : {}),
        },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const upload = (family: string, file: Buffer) =>
      app(
        "POST",
        `/api/admin/fonts?family=${encodeURIComponent(family)}`,
        file,
        "application/octet-stream",
      );
    return { app, upload, cookie };
  };

  it("lets app admins add fonts that everyone draws and exports with", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const user = await person(bob);
    const woff2 = await readFile(WOFF2);
    const ttf = await readFile(TTF);

    expect((await user.upload("Firma Sans", woff2)).statusCode).toBe(403);

    const added = await admin.upload("Firma Sans", woff2);
    expect(added.statusCode).toBe(201);
    const font = added.json().font;
    expect(font.id).toBeGreaterThanOrEqual(1001);
    expect(font).toMatchObject({
      family: "Firma Sans",
      url: expect.stringMatching(new RegExp(`^/api/fonts/${font.id}\\.woff2`)),
      metrics: { unitsPerEm: 2048, ascender: 1854, descender: -434 },
    });

    // TrueType becomes WOFF2
    const bold = await admin.upload("Firma Sans Bold", ttf);
    expect(bold.statusCode).toBe(201);
    const file = await env.built.app.inject({
      method: "GET",
      url: bold.json().font.url,
    });
    expect(file.headers["content-type"]).toBe("font/woff2");
    expect(file.rawPayload.subarray(0, 4).toString("latin1")).toBe("wOF2");

    for (const family of ["Helvetica", "sans-serif", "1 Sans", "Sans;x", ""]) {
      expect((await admin.upload(family, woff2)).statusCode).toBe(400);
    }
    expect((await admin.upload("firma sans", woff2)).statusCode).toBe(409);
    const broken = await admin.upload("Kaputt", Buffer.from("keine Schrift"));
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toBe("invalid_font");

    // everyone gets them, even without login (embedded scenes)
    const listed = (
      await env.built.app.inject({ method: "GET", url: "/api/fonts" })
    ).json().fonts;
    expect(listed.map((item: { family: string }) => item.family)).toEqual([
      "Firma Sans",
      "Firma Sans Bold",
    ]);
    expect(
      (await user.app("GET", "/api/auth/me")).json().config.fonts,
    ).toHaveLength(2);

    // the server's own renderings embed them
    const token = (
      await user.app("POST", "/api/tokens", {
        name: "Doku",
        scope: "write",
        expiresInDays: 30,
      })
    ).json().token;
    const api = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const scene = (
      await api("POST", "/api/v1/scenes", {
        name: "Mit Firmenschrift",
        elements: [
          {
            type: "text",
            x: 0,
            y: 0,
            text: "Quartalszahlen",
            fontFamily: font.id,
          },
        ],
      })
    ).json().scene;
    const svg = await api("GET", `/api/v1/scenes/${scene.id}/image`);
    expect(svg.statusCode).toBe(200);
    expect(svg.body).toMatch(
      /font-family: Firma Sans; src: url\(data:font\/woff2;base64,/,
    );

    // removed: gone for new drawings, the id is never given out again
    expect(
      (await admin.app("DELETE", `/api/admin/fonts/${font.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await env.built.app.inject({ method: "GET", url: font.url })).statusCode,
    ).toBe(404);
    const again = await admin.upload("Firma Sans", woff2);
    expect(again.statusCode).toBe(201);
    expect(again.json().font.id).toBeGreaterThan(bold.json().font.id);

    const events = await env.built.ctx.db
      .selectFrom("events")
      .select("type")
      .where("type", "like", "admin.font_%")
      .execute();
    expect(events.map((event) => event.type).sort()).toEqual([
      "admin.font_added",
      "admin.font_added",
      "admin.font_added",
      "admin.font_removed",
    ]);
  });
});
