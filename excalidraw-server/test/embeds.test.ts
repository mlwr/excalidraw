/**
 * Embedding scenes in wiki and intranet pages (T3).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};

describeWithDb("embedding", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  const person = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const app = (method: string, url: string, payload?: unknown) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    return { app };
  };
  const anonymous = (url: string) =>
    env.built.app.inject({ method: "GET", url });

  it("shows embedded scenes read-only to the intranet", async () => {
    env = await createTestEnv();
    const admin = await person(alice);
    const owner = await person(bob);
    const colleague = await person(carol);
    const { scene, key } = (
      await owner.app("POST", "/api/scenes", { name: "Architektur" })
    ).json();
    await owner.app("PUT", `/api/scenes/${scene.id}/content`, {
      sceneVersion: 1,
      expectedRevision: 0,
      iv: Buffer.alloc(12, 3).toString("base64"),
      ciphertext: Buffer.from("verschlüsselt").toString("base64"),
    });

    // only who manages the scene creates the link
    expect(
      (await colleague.app("POST", `/api/scenes/${scene.id}/embed`)).statusCode,
    ).toBe(404);
    const created = await owner.app("POST", `/api/scenes/${scene.id}/embed`);
    expect(created.statusCode).toBe(200);
    const url: string = created.json().url;
    expect(url).toMatch(new RegExp(`^${ORIGIN}/embed/[\\w-]{24,}$`));
    const token = url.split("/").pop();
    // asking again gives the same link
    expect(
      (await owner.app("POST", `/api/scenes/${scene.id}/embed`)).json().url,
    ).toBe(url);
    expect(
      (await owner.app("GET", `/api/scenes/${scene.id}/grants`)).json()
        .embedUrl,
    ).toBe(url);

    // logged in, anyone with the link sees it, with the key to decrypt
    const seen = await colleague.app("GET", `/api/embed/${token}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({
      scene: {
        name: "Architektur",
        revision: 1,
        url: `${ORIGIN}/s/${scene.id}`,
      },
      key,
      ciphertext: Buffer.from("verschlüsselt").toString("base64"),
    });
    // polling: nothing new
    expect(
      (await colleague.app("GET", `/api/embed/${token}?since=1`)).statusCode,
    ).toBe(204);

    // without login: only where the workspace allows it
    const refused = await anonymous(`/api/embed/${token}`);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe("login_required");
    const workspace = (await admin.app("GET", "/api/workspace")).json()
      .workspace;
    await admin.app("PATCH", `/api/admin/workspaces/${workspace.id}`, {
      policies: { embedsWithoutLogin: true },
    });
    const open = await anonymous(`/api/embed/${token}`);
    expect(open.statusCode).toBe(200);
    // no way into the app without login
    expect(open.json().scene.url).toBeNull();
    expect((await anonymous(`/api/embed/${token}/files/abc`)).statusCode).toBe(
      404,
    );

    // the page may live in a frame of the intranet; the app may not
    const page = await anonymous(`/embed/${token}`);
    if (page.statusCode === 200) {
      expect(page.headers["content-security-policy"]).toMatch(
        /frame-ancestors 'self'/,
      );
      expect(page.headers["x-frame-options"]).toBeUndefined();
    }

    // switching embedding off ends the link at once
    await admin.app("PATCH", `/api/admin/workspaces/${workspace.id}`, {
      policies: { embeds: false },
    });
    expect((await anonymous(`/api/embed/${token}`)).statusCode).toBe(404);
    expect(
      (await owner.app("GET", `/api/scenes/${scene.id}/grants`)).json()
        .embedUrl,
    ).toBeNull();
    expect(
      (await owner.app("POST", `/api/scenes/${scene.id}/embed`)).statusCode,
    ).toBe(403);

    // deleting the scene ends it as well
    await admin.app("PATCH", `/api/admin/workspaces/${workspace.id}`, {
      policies: { embeds: true },
    });
    const again = (await owner.app("POST", `/api/scenes/${scene.id}/embed`))
      .json()
      .url.split("/")
      .pop();
    expect((await colleague.app("GET", `/api/embed/${again}`)).statusCode).toBe(
      200,
    );
    await owner.app("DELETE", `/api/scenes/${scene.id}`);
    expect((await colleague.app("GET", `/api/embed/${again}`)).statusCode).toBe(
      404,
    );
    expect((await anonymous("/api/embed/kurz")).statusCode).toBe(404);
  });
  it("lets intranet pages frame embedding links and nothing else", async () => {
    const staticDir = await mkdtemp(path.join(tmpdir(), "excalidraw-static-"));
    await writeFile(
      path.join(staticDir, "index.html"),
      '<!doctype html><html><head><script>window.x=1</script></head><body><div id="root"></div></body></html>',
    );
    try {
      env = await createTestEnv({
        STATIC_DIR: staticDir,
        EMBED_FRAME_ANCESTORS: "https://wiki.intranet.example",
      });
      const framing = async (url: string) => {
        const page = await anonymous(url);
        expect(page.statusCode).toBe(200);
        return {
          ancestors: /frame-ancestors [^;]*/.exec(
            String(page.headers["content-security-policy"]),
          )?.[0],
          xfo: page.headers["x-frame-options"],
        };
      };
      const token = "A".repeat(32);
      for (const url of [`/embed/${token}`, `/embed/${token}?x=1`]) {
        expect(await framing(url)).toEqual({
          ancestors: "frame-ancestors 'self' https://wiki.intranet.example",
          xfo: undefined,
        });
      }
      // everything else stays out of frames, also below /embed
      for (const url of [
        "/",
        "/s/abcdefgh",
        "/embed/x",
        "/embed/x?w=hr&c=123",
        `/embed/${token}/more`,
        "/embed-login",
      ]) {
        const result = await framing(url);
        expect(result.ancestors).toBe("frame-ancestors 'self'");
        expect(result.xfo).toBe("SAMEORIGIN");
      }
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  });
});
