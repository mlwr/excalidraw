/**
 * Findings of the security review of the REST API, the MCP server and the
 * comments, kept as tests.
 */
import { connect } from "node:net";

import { afterEach, expect, it } from "vitest";

import { encodeFile } from "../src/workspace/content.js";

import { bob, createTestEnv, describeWithDb, ORIGIN } from "./helpers/setup.js";

import type { AddressInfo } from "node:net";
import type { FakeUser } from "./helpers/fakeOidc.js";
import type { TestEnv } from "./helpers/setup.js";

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  groups: ["/IT"],
  realmRoles: ["excalidraw-user"],
};

describeWithDb("API hardening", () => {
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
          : Buffer.isBuffer(payload)
          ? {
              payload,
              headers: {
                cookie,
                origin: ORIGIN,
                "content-type": "application/octet-stream",
              },
            }
          : { payload: payload as Record<string, unknown> }),
      });
    const token = (
      await app("POST", "/api/tokens", { name: "Test", scope: "write" })
    ).json().token as string;
    const api = (
      method: string,
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}`, ...headers },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const id = (await app("GET", "/api/auth/me")).json().user.id as string;
    return { app, api, token, id };
  };

  it("keeps text layout cheap: bounded texts, no repeated updates", async () => {
    env = await createTestEnv();
    const bobby = await person(bob);
    const { scene } = (
      await bobby.api("POST", "/api/v1/scenes", { name: "Texte" })
    ).json();
    const url = `/api/v1/scenes/${scene.id}/elements`;

    const started = Date.now();
    const long = await bobby.api("POST", url, {
      elements: [
        {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 99_000,
          height: 50,
          label: { text: "ab ".repeat(30_000) },
        },
      ],
    });
    expect(long.statusCode).toBe(400);
    expect(long.json().error).toBe("text_too_long");
    expect(Date.now() - started).toBeLessThan(2000);

    // many short texts: bounded per request
    const many = await bobby.api("POST", url, {
      elements: Array.from({ length: 40 }, (_, i) => ({
        type: "text",
        x: 0,
        y: i * 30,
        text: "x".repeat(1900),
      })),
    });
    expect(many.json().error).toBe("text_too_long");

    const added = await bobby.api("POST", url, {
      elements: [
        { type: "rectangle", id: "r", x: 0, y: 0, label: { text: "A" } },
      ],
    });
    expect(added.statusCode).toBe(201);
    const twice = await bobby.api("PATCH", url, {
      updates: [
        { id: "r", text: "B" },
        { id: "r", text: "C" },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(
      (
        await bobby.api("PATCH", url, {
          updates: [{ id: "r", width: 1e9 }],
        })
      ).statusCode,
    ).toBe(400);

    // server-side fields of skeletons are ignored, versions stay integers
    const odd = await bobby.api("POST", url, {
      elements: [{ type: "text", x: 0, y: 0, text: "v", version: 1.5 }],
    });
    expect(odd.statusCode).toBe(201);
    const replaced = await bobby.api(
      "PUT",
      `/api/v1/scenes/${scene.id}/content`,
      {
        elements: [
          {
            type: "rectangle",
            id: "x",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            version: 2.5,
          },
        ],
      },
    );
    expect(replaced.statusCode).toBe(200);
  });

  it("does not inflate oversized image files on export", async () => {
    env = await createTestEnv({ MAX_FILE_SIZE_MB: "1" });
    const bobby = await person(bob);
    const opened = (
      await bobby.app("POST", "/api/scenes", { name: "Bilder" })
    ).json();
    // a tiny upload that would inflate to 30 MB
    const bomb = encodeFile(
      opened.key,
      { id: "bomb", mimeType: "image/png", created: 1 },
      `data:image/png;base64,${"A".repeat(30 * 1024 * 1024)}`,
    );
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(
      (
        await bobby.app(
          "PUT",
          `/api/scenes/${opened.scene.id}/files/bomb`,
          bomb,
        )
      ).statusCode,
    ).toBe(201);
    await bobby.api("PUT", `/api/v1/scenes/${opened.scene.id}/content`, {
      elements: [
        {
          type: "image",
          id: "img",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          fileId: "bomb",
          status: "saved",
        },
      ],
    });
    const started = Date.now();
    const exported = await bobby.api(
      "GET",
      `/api/v1/scenes/${opened.scene.id}/content`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.json().files).toEqual({});
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("limits requests per token however the header is spelled", async () => {
    env = await createTestEnv({ API_RATE_LIMIT_PER_MINUTE: "3" });
    const bobby = await person(bob);
    const spellings = [
      `Bearer ${bobby.token}`,
      `bearer ${bobby.token}`,
      `BEARER  ${bobby.token}`,
      `Bearer ${bobby.token} `,
    ];
    const codes = [];
    for (const authorization of spellings) {
      codes.push(
        (
          await env.built.app.inject({
            method: "GET",
            url: "/api/v1/me",
            headers: { authorization },
          })
        ).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it("counts API calls however their address is spelled", async () => {
    env = await createTestEnv({ API_RATE_LIMIT_PER_MINUTE: "4" });
    const bobby = await person(bob);
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = env.built.app.server.address() as AddressInfo;
    // raw requests: no client tidies up the address on the way
    const raw = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              `Authorization: Bearer ${bobby.token}\r\nConnection: close\r\n\r\n`,
          );
        });
        let head = "";
        socket.on("data", (chunk) => {
          head += chunk.toString("latin1");
        });
        socket.on("end", () =>
          resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] || 0)),
        );
        socket.on("error", reject);
      });
    const codes = [];
    for (const target of [
      "/api/v1/me",
      "/%61pi/v1/me",
      "/api/%761/me",
      `http://127.0.0.1:${port}/api/v1/me`,
      "/%61pi/v1/me",
    ]) {
      codes.push(await raw(target));
    }
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });

  it("leaves no scene behind when an import fails", async () => {
    env = await createTestEnv();
    const bobby = await person(bob);
    const failed = await bobby.api("POST", "/api/v1/scenes", {
      name: "Kaputt",
      content: {
        elements: [{ type: "rectangle", id: "a", x: 0, y: 0 }],
        files: { f: { mimeType: "text/html", dataURL: "data:text/html,x" } },
      },
    });
    expect(failed.statusCode).toBe(400);
    expect((await bobby.api("GET", "/api/v1/scenes")).json().total).toBe(0);

    // a replace with an outdated revision stores no files either
    const { scene } = (
      await bobby.api("POST", "/api/v1/scenes", { name: "Ok" })
    ).json();
    const conflict = await bobby.api(
      "PUT",
      `/api/v1/scenes/${scene.id}/content`,
      {
        elements: [],
        files: {
          f1: {
            mimeType: "image/png",
            dataURL: "data:image/png;base64,AAAA",
          },
        },
        expectedRevision: 7,
      },
    );
    expect(conflict.statusCode).toBe(409);
    const blobs = await env.built.ctx.db
      .selectFrom("blobs")
      .select("key")
      .execute();
    expect(blobs).toEqual([]);
  });

  it("ends tokens when Keycloak takes access away or nobody signs in", async () => {
    env = await createTestEnv({
      OIDC_REQUIRED_ROLE: "excalidraw-user",
      API_TOKEN_LOGIN_MAX_AGE_DAYS: "30",
    });
    const bobby = await person({ ...bob, realmRoles: ["excalidraw-user"] });
    expect((await bobby.api("GET", "/api/v1/me")).statusCode).toBe(200);

    // no login for 40 days: the token asks for one
    await env.built.ctx.db
      .updateTable("users")
      .set({ last_login_at: new Date(Date.now() - 40 * 24 * 3600 * 1000) })
      .where("id", "=", bobby.id)
      .execute();
    const stale = await bobby.api("GET", "/api/v1/me");
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toBe("login_required");

    // Keycloak removed the role: the next login is refused, tokens end
    await expect(env.login({ ...bob, realmRoles: [] })).rejects.toThrow(/403/);
    await env.built.ctx.db
      .updateTable("users")
      .set({ last_login_at: new Date() })
      .where("id", "=", bobby.id)
      .execute();
    const revoked = await bobby.api("GET", "/api/v1/me");
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().error).toBe("invalid_token");
  });

  it("keeps comment rights tight: mentions, deleting threads", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const viewer = await person(carol);
    const outsider = await person({ sub: "dave", name: "Dave" });
    const { scene } = (
      await owner.app("POST", "/api/scenes", { name: "Rechte" })
    ).json();
    await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "group", principal: "/IT", role: "viewer" }],
    });

    // mention someone who can't see the scene: refused
    const mention = await viewer.app(
      "POST",
      `/api/scenes/${scene.id}/comments`,
      { text: "Schau mal", x: 0, y: 0, mentions: [outsider.id] },
    );
    expect(mention.statusCode).toBe(400);
    expect(mention.json().error).toBe("mention_without_access");

    const thread = (
      await viewer.app("POST", `/api/scenes/${scene.id}/comments`, {
        text: "Frage",
        x: 0,
        y: 0,
        mentions: [owner.id],
      })
    ).json().thread;
    await owner.app("POST", `/api/comment-threads/${thread.id}/comments`, {
      text: "Antwort",
    });
    // the author can't take the owner's answer down with the thread
    expect(
      (await viewer.app("DELETE", `/api/comment-threads/${thread.id}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await owner.app("DELETE", `/api/comment-threads/${thread.id}`))
        .statusCode,
    ).toBe(204);

    // MCP-style queries with odd characters are cleaned, not errors
    expect((await owner.api("GET", "/api/v1/scenes?q=a%00b")).statusCode).toBe(
      200,
    );
  });
});
