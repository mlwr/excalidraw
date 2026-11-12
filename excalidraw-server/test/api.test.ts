import { createDecipheriv } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { io as connect } from "socket.io-client";
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
import type { Socket } from "socket.io-client";

const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** bytes as socket.io and base64 decoding hand them over */
const bytesOf = (value: ArrayBuffer | Uint8Array) =>
  value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value);

const decrypt = (
  key: string,
  data: ArrayBuffer | Uint8Array,
  iv: ArrayBuffer | Uint8Array,
) => {
  const bytes = bytesOf(data);
  const decipher = createDecipheriv(
    "aes-128-gcm",
    Buffer.from(key, "base64url"),
    bytesOf(iv),
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - 16)),
      decipher.final(),
    ]).toString("utf8"),
  );
};

describeWithDb("REST API, comments and MCP", () => {
  let env: TestEnv;
  const sockets: Socket[] = [];
  const mcpClients: Client[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await Promise.all(mcpClients.splice(0).map((client) => client.close()));
    await env?.close();
  });

  /** a logged-in person with the app's API (cookie) and a token for /api/v1 */
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
    const createToken = async (scope: "read" | "write" = "write") => {
      const response = await app("POST", "/api/tokens", {
        name: `Test ${scope}`,
        scope,
        expiresInDays: 30,
      });
      expect(response.statusCode).toBe(201);
      return response.json() as { token: string; id: string };
    };
    const api = (
      token: string,
      method: string,
      url: string,
      payload?: unknown,
    ) =>
      env.built.app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined
          ? {}
          : { payload: payload as Record<string, unknown> }),
      });
    const me = (await app("GET", "/api/auth/me")).json().user;
    return { cookie, app, api, createToken, id: me.id as string };
  };

  const listen = async () => {
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = env.built.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("not listening");
    }
    return `http://127.0.0.1:${address.port}`;
  };

  it("issues, checks and revokes personal API tokens", async () => {
    env = await createTestEnv({ API_TOKEN_MAX_DAYS: "90" });
    const bobby = await person(bob);

    // the cookie alone opens nothing under /api/v1
    expect((await bobby.app("GET", "/api/v1/me")).statusCode).toBe(401);
    expect(
      (
        await bobby.app("POST", "/api/tokens", {
          name: "Zu lang",
          scope: "write",
          expiresInDays: 365,
        })
      ).statusCode,
    ).toBe(400);

    const { token, id } = await bobby.createToken("read");
    expect(token).toMatch(/^exc_[\w-]{43}$/);
    const listed = (await bobby.app("GET", "/api/tokens")).json();
    expect(listed.allowed).toBe(true);
    expect(listed.tokens).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);

    const me = await bobby.api(token, "GET", "/api/v1/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user.name).toBe("Bob Beispiel");
    // tokens are no session: the app's own routes don't take them
    expect((await bobby.api(token, "GET", "/api/auth/me")).statusCode).toBe(
      401,
    );
    // read tokens can't write
    const denied = await bobby.api(token, "POST", "/api/v1/scenes", {
      name: "Nein",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("insufficient_scope");

    // stored as a hash only
    const row = await env.built.ctx.db
      .selectFrom("api_tokens")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.last_used_at).not.toBeNull();

    // expired and revoked tokens stop working
    await env.built.ctx.db
      .updateTable("api_tokens")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect((await bobby.api(token, "GET", "/api/v1/me")).statusCode).toBe(401);
    const fresh = await bobby.createToken("write");
    expect(
      (await bobby.app("DELETE", `/api/tokens/${fresh.id}`)).statusCode,
    ).toBe(204);
    expect((await bobby.api(fresh.token, "GET", "/api/v1/me")).statusCode).toBe(
      401,
    );
    // someone else's token can't be revoked
    const other = await person(carol);
    expect((await other.app("DELETE", `/api/tokens/${id}`)).statusCode).toBe(
      404,
    );
  });

  it("only lets people with the API role hold tokens", async () => {
    env = await createTestEnv({ API_REQUIRED_ROLE: "excalidraw-api" });
    const bobby = await person(bob);
    expect((await bobby.app("GET", "/api/tokens")).json().allowed).toBe(false);
    expect(
      (
        await bobby.app("POST", "/api/tokens", {
          name: "x",
          scope: "read",
        })
      ).statusCode,
    ).toBe(403);
    // admins may
    const admin = await person(alice);
    await admin.createToken("read");
  });

  it("creates, reads, changes and replaces scenes through the API", async () => {
    env = await createTestEnv();
    const bobby = await person(bob);
    const { token } = await bobby.createToken("write");

    const created = await bobby.api(token, "POST", "/api/v1/scenes", {
      name: "Ablauf",
      elements: [
        {
          type: "rectangle",
          id: "a",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          label: { text: "Antrag" },
        },
        {
          type: "diamond",
          id: "b",
          x: 0,
          y: 250,
          width: 200,
          height: 120,
          label: { text: "Prüfung" },
        },
        { type: "arrow", start: { id: "a" }, end: { id: "b" } },
      ],
    });
    expect(created.statusCode).toBe(201);
    const { scene } = created.json();
    expect(scene.url).toBe(`${ORIGIN}/s/${scene.id}`);
    expect(scene.revision).toBe(1);

    const content = (
      await bobby.api(token, "GET", `/api/v1/scenes/${scene.id}/content`)
    ).json();
    expect(content.type).toBe("excalidraw");
    const arrow = content.elements.find(
      (el: { type: string }) => el.type === "arrow",
    );
    expect(arrow.startBinding.elementId).toBe("a");
    expect(arrow.endBinding.elementId).toBe("b");
    const labels = content.elements
      .filter((el: { type: string }) => el.type === "text")
      .map((el: { text: string }) => el.text)
      .sort();
    expect(labels).toEqual(["Antrag", "Prüfung"]);

    // the browser can read what the API wrote (same encryption, same key)
    const opened = (await bobby.app("GET", `/api/scenes/${scene.id}`)).json();
    const stored = (
      await bobby.app("GET", `/api/scenes/${scene.id}/content`)
    ).json();
    const elements = decrypt(
      opened.key,
      Buffer.from(stored.ciphertext, "base64"),
      Buffer.from(stored.iv, "base64"),
    );
    expect(elements).toHaveLength(content.elements.length);

    // add an element connected to one already there, change and delete
    const added = (
      await bobby.api(token, "POST", `/api/v1/scenes/${scene.id}/elements`, {
        elements: [
          {
            type: "rectangle",
            id: "c",
            x: 400,
            y: 250,
            width: 160,
            height: 80,
            label: { text: "Ablehnung" },
          },
          { type: "arrow", start: { id: "b" }, end: { id: "c" } },
        ],
      })
    ).json();
    const newArrow = added.created.find(
      (el: { type: string }) => el.type === "arrow",
    );
    expect(newArrow).toMatchObject({ start: "b", end: "c" });

    const updated = await bobby.api(
      token,
      "PATCH",
      `/api/v1/scenes/${scene.id}/elements`,
      { updates: [{ id: "a", text: "Antrag eingegangen", x: 20 }] },
    );
    expect(updated.statusCode).toBe(200);
    expect(
      updated
        .json()
        .changed.some(
          (el: { text?: string }) => el.text === "Antrag eingegangen",
        ),
    ).toBe(true);
    expect(
      (
        await bobby.api(token, "PATCH", `/api/v1/scenes/${scene.id}/elements`, {
          updates: [{ id: "gibt-es-nicht", text: "x" }],
        })
      ).statusCode,
    ).toBe(404);
    const removed = await bobby.api(
      token,
      "DELETE",
      `/api/v1/scenes/${scene.id}/elements?ids=c`,
    );
    expect(removed.statusCode).toBe(200);

    // a laid out diagram lands next to the drawing
    const diagram = await bobby.api(
      token,
      "POST",
      `/api/v1/scenes/${scene.id}/diagram`,
      {
        nodes: [
          { id: "x", label: "Start", shape: "ellipse" },
          { id: "y", label: "Ende" },
        ],
        edges: [{ from: "x", to: "y", label: "dann" }],
      },
    );
    expect(diagram.statusCode).toBe(201);
    expect(Object.keys(diagram.json().nodes)).toEqual(["x", "y"]);

    // replacing: with the right revision only
    const now = (
      await bobby.api(token, "GET", `/api/v1/scenes/${scene.id}/content`)
    ).json();
    const conflict = await bobby.api(
      token,
      "PUT",
      `/api/v1/scenes/${scene.id}/content`,
      { elements: [], expectedRevision: now.revision - 1 },
    );
    expect(conflict.statusCode).toBe(409);
    const replaced = await bobby.api(
      token,
      "PUT",
      `/api/v1/scenes/${scene.id}/content`,
      {
        elements: [
          {
            type: "image",
            id: "img",
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            fileId: "file1",
            status: "saved",
          },
        ],
        files: {
          file1: { id: "file1", mimeType: "image/png", dataURL: PNG_DATA_URL },
        },
        expectedRevision: now.revision,
      },
    );
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().storedFiles).toBe(1);
    const after = (
      await bobby.api(token, "GET", `/api/v1/scenes/${scene.id}/content`)
    ).json();
    expect(after.elements.map((el: { id: string }) => el.id)).toEqual(["img"]);
    expect(after.files.file1.dataURL).toBe(PNG_DATA_URL);

    // listing, renaming
    const list = (await bobby.api(token, "GET", "/api/v1/scenes?q=Abl")).json();
    expect(list.total).toBe(1);
    const renamed = await bobby.api(
      token,
      "PATCH",
      `/api/v1/scenes/${scene.id}`,
      {
        name: "Neuer Ablauf",
      },
    );
    expect(renamed.json().scene.name).toBe("Neuer Ablauf");

    // others see nothing without access
    const other = await person(carol);
    const { token: otherToken } = await other.createToken("write");
    expect(
      (await other.api(otherToken, "GET", `/api/v1/scenes/${scene.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await other.api(otherToken, "GET", "/api/v1/scenes")).json().total,
    ).toBe(0);
  });

  it("shows API changes live in open editors", async () => {
    env = await createTestEnv();
    const url = await listen();
    const bobby = await person(bob);
    const { token } = await bobby.createToken("write");
    const { scene } = (
      await bobby.api(token, "POST", "/api/v1/scenes", { name: "Live" })
    ).json();
    const { key } = (await bobby.app("GET", `/api/scenes/${scene.id}`)).json();

    const socket = connect(url, {
      transports: ["websocket"],
      extraHeaders: { origin: ORIGIN, cookie: bobby.cookie },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    await new Promise((resolve) => socket.once("init-room", resolve));
    const joined = new Promise((resolve) =>
      socket.once("first-in-room", resolve),
    );
    socket.emit("join-room", `scene-${scene.id}`);
    await joined;

    const update = new Promise<{ type: string; payload: { elements: any[] } }>(
      (resolve) =>
        socket.once("client-broadcast", (data: ArrayBuffer, iv: ArrayBuffer) =>
          resolve(decrypt(key, data, iv)),
        ),
    );
    await bobby.api(token, "POST", `/api/v1/scenes/${scene.id}/elements`, {
      elements: [{ type: "text", x: 0, y: 0, text: "Hallo aus der API" }],
    });
    const message = await update;
    expect(message.type).toBe("SCENE_UPDATE");
    expect(message.payload.elements[0].text).toBe("Hallo aus der API");

    // comments: open editors hear about them
    const commentsChanged = new Promise((resolve) =>
      socket.once("comments-changed", resolve),
    );
    await bobby.api(token, "POST", `/api/v1/scenes/${scene.id}/comments`, {
      text: "Bitte prüfen",
      x: 10,
      y: 10,
    });
    await commentsChanged;
  });

  it("keeps comment threads per scene, encrypted, with rights", async () => {
    env = await createTestEnv();
    const owner = await person(bob);
    const viewer = await person(carol);
    const { scene } = (
      await owner.app("POST", "/api/scenes", { name: "Kommentiert" })
    ).json();
    await owner.app("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "group", principal: "/IT", role: "viewer" }],
    });

    // viewers comment too
    const created = await viewer.app(
      "POST",
      `/api/scenes/${scene.id}/comments`,
      {
        text: "Hier fehlt ein Schritt",
        x: 12.5,
        y: -4,
        elementId: "abc",
        mentions: [owner.id],
      },
    );
    expect(created.statusCode).toBe(201);
    const thread = created.json().thread;
    expect(thread.comments[0]).toMatchObject({
      text: "Hier fehlt ein Schritt",
      author: { name: "Carol IT" },
      mentions: [{ id: owner.id, name: "Bob Beispiel" }],
      canEdit: true,
    });

    // not readable in the database
    const rows = await env.built.ctx.db
      .selectFrom("comments")
      .select("body")
      .execute();
    expect(rows[0].body.toString("utf8")).not.toContain("fehlt");

    const reply = await owner.app(
      "POST",
      `/api/comment-threads/${thread.id}/comments`,
      { text: "Stimmt, ergänze ich." },
    );
    expect(reply.json().thread.comments).toHaveLength(2);

    // the viewer may resolve the own thread, others may not edit her comment
    expect(
      (
        await owner.app("PATCH", `/api/comments/${thread.comments[0].id}`, {
          text: "geändert",
        })
      ).statusCode,
    ).toBe(403);
    const resolved = await viewer.app(
      "PATCH",
      `/api/comment-threads/${thread.id}`,
      { resolved: true },
    );
    expect(resolved.json().thread.resolved).toBe(true);
    expect(
      (
        await viewer.app("GET", `/api/scenes/${scene.id}/comments?status=open`)
      ).json().threads,
    ).toEqual([]);

    // a stranger sees no comments and can't reply
    const stranger = await person({ sub: "dave", name: "Dave" });
    expect(
      (await stranger.app("GET", `/api/scenes/${scene.id}/comments`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await stranger.app(
          "POST",
          `/api/comment-threads/${thread.id}/comments`,
          { text: "Hallo" },
        )
      ).statusCode,
    ).toBe(404);

    // the owner manages the scene and may delete any comment
    for (const comment of reply.json().thread.comments) {
      expect(
        (await owner.app("DELETE", `/api/comments/${comment.id}`)).statusCode,
      ).toBe(204);
    }
    expect(
      (await owner.app("GET", `/api/scenes/${scene.id}/comments`)).json()
        .threads,
    ).toEqual([]);
    expect(
      (
        await owner.app("POST", `/api/scenes/${scene.id}/comments`, {
          text: "",
          x: 0,
          y: 0,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("serves MCP tools to AI assistants with the token's rights", async () => {
    env = await createTestEnv();
    const url = await listen();
    const bobby = await person(bob);
    const write = await bobby.createToken("write");
    const read = await bobby.createToken("read");

    const mcp = async (token: string) => {
      const client = new Client({ name: "test", version: "1.0.0" });
      mcpClients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };
    const text = (result: any) => JSON.parse(result.content[0].text);

    const client = await mcp(write.token);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "search_scenes",
        "get_scene",
        "create_diagram",
        "add_elements",
        "update_elements",
        "delete_elements",
        "list_comments",
        "add_comment",
      ]),
    );

    const diagram = text(
      await client.callTool({
        name: "create_diagram",
        arguments: {
          name: "Urlaubsantrag",
          nodes: [
            { id: "antrag", label: "Antrag stellen", shape: "ellipse" },
            { id: "pruefen", label: "Genehmigt?", shape: "diamond" },
            { id: "ja", label: "Urlaub eintragen" },
            { id: "nein", label: "Ablehnung mitteilen" },
          ],
          edges: [
            { from: "antrag", to: "pruefen" },
            { from: "pruefen", to: "ja", label: "ja" },
            { from: "pruefen", to: "nein", label: "nein" },
          ],
        },
      }),
    );
    expect(diagram.scene.url).toMatch(/\/s\/[\w-]+$/);

    const read1 = text(
      await client.callTool({
        name: "get_scene",
        arguments: { sceneId: diagram.scene.id },
      }),
    );
    const shapes = read1.drawing.elements.filter(
      (el: { type: string }) => el.type !== "arrow",
    );
    expect(shapes.map((el: { label: string }) => el.label).sort()).toEqual(
      [
        "Ablehnung mitteilen",
        "Antrag stellen",
        "Genehmigt?",
        "Urlaub eintragen",
      ].sort(),
    );
    const arrows = read1.drawing.elements.filter(
      (el: { type: string }) => el.type === "arrow",
    );
    expect(arrows).toHaveLength(3);
    expect(
      arrows.every((el: { from: string; to: string }) => el.from && el.to),
    ).toBe(true);

    // change a label, comment on an element
    const nodeId = diagram.nodes.ja;
    const changed = await client.callTool({
      name: "update_elements",
      arguments: {
        sceneId: diagram.scene.id,
        updates: [{ id: nodeId, text: "Urlaub im Kalender eintragen" }],
      },
    });
    expect(changed.isError).toBeFalsy();
    const commented = text(
      await client.callTool({
        name: "add_comment",
        arguments: {
          sceneId: diagram.scene.id,
          elementId: nodeId,
          text: "Auch die Vertretung informieren.",
        },
      }),
    );
    expect(commented.thread.elementId).toBe(nodeId);

    const found = text(
      await client.callTool({
        name: "search_scenes",
        arguments: { query: "Urlaub" },
      }),
    );
    expect(found.results.map((s: { id: string }) => s.id)).toEqual([
      diagram.scene.id,
    ]);

    // errors come back as tool results
    const missing = await client.callTool({
      name: "get_scene",
      arguments: { sceneId: "gibtesnicht1234" },
    });
    expect(missing.isError).toBe(true);

    // a read token reads, but doesn't write
    const reader = await mcp(read.token);
    expect(
      (
        await reader.callTool({
          name: "get_scene",
          arguments: { sceneId: diagram.scene.id },
        })
      ).isError,
    ).toBeFalsy();
    const refused = await reader.callTool({
      name: "delete_elements",
      arguments: { sceneId: diagram.scene.id, ids: [nodeId] },
    });
    expect(refused.isError).toBe(true);

    // without a token: no MCP
    const anonymous = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(anonymous.status).toBe(401);
  });
});
