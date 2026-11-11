import { afterEach, expect, it } from "vitest";
import { io as connect } from "socket.io-client";

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

// non-admin colleagues
const carol: FakeUser = {
  sub: "carol",
  name: "Carol IT",
  email: "carol@example.test",
  groups: ["/IT"],
};
const dave: FakeUser = {
  sub: "dave",
  name: "Dave Vertrieb",
  groups: ["/Vertrieb"],
};
// member of a subgroup only: Keycloak lists just "/IT/Architektur"
const erin: FakeUser = {
  sub: "erin",
  name: "Erin Architektur",
  groups: ["/IT/Architektur"],
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describeWithDb("workspace", () => {
  let env: TestEnv;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await env?.close();
  });

  /** logged-in API client for one user */
  const client = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const call = async (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      payload?: unknown,
      headers: Record<string, string> = {},
    ) =>
      env.built.app.inject({
        method,
        url,
        headers: { cookie, origin: ORIGIN, ...headers },
        ...(payload === undefined
          ? {}
          : Buffer.isBuffer(payload)
          ? { payload }
          : { payload: payload as Record<string, unknown> }),
      });
    const me = (await call("GET", "/api/auth/me")).json().user;
    return { cookie, call, id: me.id as string };
  };

  const content = (expectedRevision: number | null) => ({
    sceneVersion: 3,
    iv: Buffer.from("123456789012").toString("base64"),
    ciphertext: Buffer.from("ciphertext").toString("base64"),
    expectedRevision,
  });

  it("keeps personal scenes private and encrypts keys at rest", async () => {
    env = await createTestEnv();
    const owner = await client(bob);
    const other = await client(dave);

    const workspace = (await owner.call("GET", "/api/workspace")).json();
    const personal = workspace.collections.find(
      (c: { kind: string }) => c.kind === "personal",
    );
    expect(personal).toMatchObject({ name: "Meine Szenen", role: "manager" });

    const created = await owner.call("POST", "/api/scenes", { name: "Ablauf" });
    expect(created.statusCode).toBe(201);
    const { scene, key } = created.json();
    expect(key).toMatch(/^[\w-]{22}$/);
    expect(scene.collection.id).toBe(personal.id);

    // the key is not stored in plain text
    const row = await env.built.ctx.db
      .selectFrom("scenes")
      .select("key_sealed")
      .where("id", "=", scene.id)
      .executeTakeFirstOrThrow();
    expect(row.key_sealed.toString("utf8")).not.toContain(key);

    // content with optimistic concurrency
    const url = `/api/scenes/${scene.id}/content`;
    expect((await owner.call("GET", url)).statusCode).toBe(404);
    expect((await owner.call("PUT", url, content(null))).json().revision).toBe(
      1,
    );
    expect((await owner.call("PUT", url, content(null))).statusCode).toBe(409);
    expect((await owner.call("PUT", url, content(1))).json().revision).toBe(2);
    expect((await owner.call("GET", url)).json().revision).toBe(2);

    // nobody else sees it
    expect(
      (await other.call("GET", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(404);
    expect((await other.call("PUT", url, content(2))).statusCode).toBe(404);
  });

  it("shares single scenes with people as viewer or editor", async () => {
    env = await createTestEnv();
    const owner = await client(bob);
    const other = await client(dave);
    const { scene } = (
      await owner.call("POST", "/api/scenes", { name: "Plan" })
    ).json();
    const grantsUrl = `/api/scenes/${scene.id}/grants`;
    const contentUrl = `/api/scenes/${scene.id}/content`;

    await owner.call("PUT", grantsUrl, {
      grants: [{ type: "user", principal: other.id, role: "viewer" }],
    });
    const viewed = (await other.call("GET", `/api/scenes/${scene.id}`)).json();
    expect(viewed.scene).toMatchObject({ role: "viewer", canManage: false });
    expect(viewed.key).toMatch(/^[\w-]{22}$/);
    expect(
      (await other.call("PUT", contentUrl, content(null))).statusCode,
    ).toBe(403);
    // viewers and direct editors cannot re-share
    expect(
      (await other.call("PUT", grantsUrl, { grants: [] })).statusCode,
    ).toBe(403);

    await owner.call("PUT", grantsUrl, {
      grants: [{ type: "user", principal: other.id, role: "editor" }],
    });
    expect(
      (await other.call("PUT", contentUrl, content(null))).statusCode,
    ).toBe(200);

    const shared = (await other.call("GET", "/api/scenes?view=shared")).json();
    expect(shared.scenes.map((s: { id: string }) => s.id)).toEqual([scene.id]);
    const recent = (await other.call("GET", "/api/scenes")).json();
    expect(recent.scenes.map((s: { id: string }) => s.id)).toEqual([scene.id]);
  });

  it("gives Keycloak groups access to team collections", async () => {
    env = await createTestEnv();
    const lead = await client(bob);
    const itMember = await client(carol);
    const outsider = await client(dave);

    const collection = (
      await lead.call("POST", "/api/collections", { name: "Architektur" })
    ).json();
    expect(collection.role).toBe("manager");

    // at least one manager must remain
    expect(
      (
        await lead.call("PUT", `/api/collections/${collection.id}/grants`, {
          grants: [{ type: "group", principal: "/IT", role: "editor" }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await lead.call("PUT", `/api/collections/${collection.id}/grants`, {
          grants: [
            { type: "user", principal: lead.id, role: "manager" },
            { type: "group", principal: "/IT", role: "editor" },
          ],
        })
      ).statusCode,
    ).toBe(200);

    const created = await itMember.call("POST", "/api/scenes", {
      name: "Zielbild",
      collectionId: collection.id,
    });
    expect(created.statusCode).toBe(201);
    const sceneId = created.json().scene.id;

    const list = (
      await itMember.call("GET", `/api/scenes?collection=${collection.id}`)
    ).json();
    expect(list.scenes).toHaveLength(1);

    // a grant to a group covers its subgroups
    const subgroupMember = await client(erin);
    expect(
      (await subgroupMember.call("GET", `/api/scenes/${sceneId}`)).json().scene
        .role,
    ).toBe("editor");

    expect(
      (await outsider.call("GET", `/api/scenes?collection=${collection.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await outsider.call("GET", `/api/scenes/${sceneId}`)).statusCode,
    ).toBe(404);

    // the workspace admin sees every team collection
    const admin = await client(alice);
    const adminView = (await admin.call("GET", "/api/workspace")).json();
    expect(
      adminView.collections.some((c: { id: string }) => c.id === collection.id),
    ).toBe(true);

    // non-empty collections cannot be deleted
    expect(
      (await lead.call("DELETE", `/api/collections/${collection.id}`))
        .statusCode,
    ).toBe(409);
    expect(
      (await lead.call("DELETE", `/api/scenes/${sceneId}`)).statusCode,
    ).toBe(204);
    expect(
      (await itMember.call("GET", `/api/scenes/${sceneId}`)).statusCode,
    ).toBe(404);
    expect(
      (await lead.call("DELETE", `/api/collections/${collection.id}`))
        .statusCode,
    ).toBe(204);
  });

  it("opens scenes via revocable read-only links", async () => {
    env = await createTestEnv();
    const owner = await client(bob);
    const reader = await client(dave);
    const { scene } = (
      await owner.call("POST", "/api/scenes", { name: "Info" })
    ).json();

    const link = (
      await owner.call("POST", `/api/scenes/${scene.id}/read-link`)
    ).json();
    const token = new URL(link.url).pathname.split("/").pop();
    expect(link.url).toBe(`${ORIGIN}/v/${token}`);

    const resolved = (
      await reader.call("GET", `/api/read-links/${token}`)
    ).json();
    expect(resolved.sceneId).toBe(scene.id);
    const opened = (await reader.call("GET", `/api/scenes/${scene.id}`)).json();
    expect(opened.scene.role).toBe("viewer");

    await owner.call("DELETE", `/api/scenes/${scene.id}/read-link`);
    expect(
      (await reader.call("GET", `/api/scenes/${scene.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await reader.call("GET", `/api/read-links/${token}`)).statusCode,
    ).toBe(404);
  });

  it("stores thumbnails encrypted and finds colleagues and groups", async () => {
    env = await createTestEnv();
    const owner = await client(bob);
    await client(carol);
    const { scene } = (
      await owner.call("POST", "/api/scenes", { name: "Bild" })
    ).json();

    const put = await owner.call(
      "PUT",
      `/api/scenes/${scene.id}/thumbnail`,
      PNG,
      { "content-type": "image/png" },
    );
    expect(put.statusCode).toBe(200);
    const stored = await env.built.ctx.blobs.get(
      `thumbnails/scenes/${scene.id}`,
    );
    expect(stored!.data.equals(PNG)).toBe(false);
    const get = await owner.call("GET", `/api/scenes/${scene.id}/thumbnail`);
    expect(get.headers["content-type"]).toBe("image/png");
    expect(get.rawPayload.equals(PNG)).toBe(true);

    const listed = (await owner.call("GET", "/api/scenes")).json();
    expect(listed.scenes[0].thumbnailUrl).toMatch(
      new RegExp(`^/api/scenes/${scene.id}/thumbnail\\?v=\\d+$`),
    );

    const directory = (await owner.call("GET", "/api/directory?q=car")).json();
    expect(directory.users.map((u: { name: string }) => u.name)).toEqual([
      "Carol IT",
    ]);
    const groups = (await owner.call("GET", "/api/directory?q=IT")).json();
    expect(groups.groups).toContain("/IT");
  });

  it("lets only permitted users into a scene's live room", async () => {
    env = await createTestEnv();
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = env.built.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("not listening");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const owner = await client(bob);
    const reader = await client(carol);
    const outsider = await client(dave);
    const { scene } = (
      await owner.call("POST", "/api/scenes", { name: "Live" })
    ).json();
    await owner.call("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "group", principal: "/IT", role: "viewer" }],
    });
    const room = `scene-${scene.id}`;

    const open = (cookie: string) => {
      const socket = connect(url, {
        transports: ["websocket"],
        extraHeaders: { origin: ORIGIN, cookie },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      return new Promise<Socket>((resolve) =>
        socket.once("init-room", () => resolve(socket)),
      );
    };
    const once = <T>(socket: Socket, event: string) =>
      new Promise<T>((resolve) =>
        socket.once(event, (value: T) => resolve(value)),
      );

    const ownerSocket = await open(owner.cookie);
    const firstIn = once(ownerSocket, "first-in-room");
    ownerSocket.emit("join-room", room);
    await firstIn;

    const outsiderSocket = await open(outsider.cookie);
    const denied = once<string>(outsiderSocket, "room-access-denied");
    outsiderSocket.emit("join-room", room);
    expect(await denied).toBe(room);

    const readerSocket = await open(reader.cookie);
    const joined = once(ownerSocket, "new-user");
    readerSocket.emit("join-room", room);
    await joined;

    // presence shows up in scene lists
    const listed = (await owner.call("GET", "/api/scenes")).json();
    expect(
      listed.scenes[0].activeUsers.map((u: { name: string }) => u.name).sort(),
    ).toEqual(["Bob Beispiel", "Carol IT"]);

    // the viewer's scene updates are dropped, cursor updates pass
    const received: string[] = [];
    ownerSocket.on("client-broadcast", (data: ArrayBuffer) => {
      received.push(Buffer.from(data).toString());
    });
    readerSocket.emit(
      "server-broadcast",
      room,
      Buffer.from("edit"),
      Buffer.from("iv"),
    );
    readerSocket.emit(
      "server-volatile-broadcast",
      room,
      Buffer.from("cursor"),
      Buffer.from("iv"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toEqual(["cursor"]);
  });
});
