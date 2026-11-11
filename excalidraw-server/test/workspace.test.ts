import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

/** a collaboration message as the app encrypts it (AES-128-GCM) */
const encryptMessage = (
  key: string,
  type: string,
): [ArrayBuffer, Uint8Array] => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-128-gcm",
    Buffer.from(key, "base64url"),
    iv,
  );
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ type, payload: {} })),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    new Uint8Array(iv),
  ];
};

const decryptMessage = (
  key: string,
  data: ArrayBuffer,
  iv: ArrayBuffer,
): { type: string } | null => {
  try {
    const bytes = Buffer.from(data);
    const decipher = createDecipheriv(
      "aes-128-gcm",
      Buffer.from(key, "base64url"),
      Buffer.from(iv),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    return null;
  }
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
    const { scene, key } = (
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

    let readerSocket = await open(reader.cookie);
    const joined = once(ownerSocket, "new-user");
    readerSocket.emit("join-room", room);
    await joined;

    // presence shows up in scene lists
    const listed = (await owner.call("GET", "/api/scenes")).json();
    expect(
      listed.scenes[0].activeUsers.map((u: { name: string }) => u.name).sort(),
    ).toEqual(["Bob Beispiel", "Carol IT"]);

    // what arrives, decrypted with the scene key like the app does
    const received: string[] = [];
    ownerSocket.on("client-broadcast", (data: ArrayBuffer, iv: ArrayBuffer) =>
      received.push(decryptMessage(key, data, iv)?.type ?? "unreadable"),
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    // the viewer can show where it is, but not change the scene: not even
    // by sending an update the "volatile" way, or to its followers
    const followed = once<string[]>(readerSocket, "user-follow-room-change");
    ownerSocket.emit("user-follow", {
      userToFollow: { socketId: readerSocket.id },
      action: "FOLLOW",
    });
    expect(await followed).toEqual([ownerSocket.id]);
    const followRoom = `follow@${readerSocket.id}`;
    // one at a time: socket.io drops volatile messages while the
    // connection is still busy with the previous one
    const send = async (
      event: string,
      target: string,
      message: [ArrayBuffer, Uint8Array],
    ) => {
      readerSocket.emit(event, target, ...message);
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await send("server-broadcast", room, encryptMessage(key, "SCENE_UPDATE"));
    await send(
      "server-volatile-broadcast",
      room,
      encryptMessage(key, "SCENE_UPDATE"),
    );
    await send(
      "server-volatile-broadcast",
      room,
      encryptMessage(key, "SCENE_INIT"),
    );
    await send(
      "server-volatile-broadcast",
      followRoom,
      encryptMessage(key, "SCENE_UPDATE"),
    );
    await send("server-volatile-broadcast", room, [
      new Uint8Array([1, 2, 3]).buffer,
      new Uint8Array(12),
    ]);
    await send(
      "server-volatile-broadcast",
      room,
      encryptMessage(key, "MOUSE_LOCATION"),
    );
    await send(
      "server-volatile-broadcast",
      followRoom,
      encryptMessage(key, "USER_VISIBLE_SCENE_BOUNDS"),
    );
    await settle();
    expect(received).toEqual(["MOUSE_LOCATION", "USER_VISIBLE_SCENE_BOUNDS"]);

    // the viewer becomes editor: its connection starts over and may edit
    const upgraded = once<string>(readerSocket, "scene-access-changed");
    const upgradeDisconnect = once<string>(readerSocket, "disconnect");
    await owner.call("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "group", principal: "/IT", role: "editor" }],
    });
    expect(await upgraded).toBe(room);
    expect(await upgradeDisconnect).toBe("io server disconnect");
    readerSocket = await open(reader.cookie);
    const rejoined = once(ownerSocket, "new-user");
    readerSocket.emit("join-room", room);
    await rejoined;
    received.length = 0;
    readerSocket.emit(
      "server-broadcast",
      room,
      ...encryptMessage(key, "SCENE_UPDATE"),
    );
    await settle();
    expect(received).toEqual(["SCENE_UPDATE"]);

    // access removed: the live connection ends, the owner stays
    const revoked = once<string>(readerSocket, "scene-access-changed");
    await owner.call("PUT", `/api/scenes/${scene.id}/grants`, { grants: [] });
    expect(await revoked).toBe(room);
    await settle();
    expect(readerSocket.connected).toBe(false);
    expect(ownerSocket.connected).toBe(true);
  });

  it("hands the scene to newcomers only from people who may edit", async () => {
    env = await createTestEnv();
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = env.built.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("not listening");
    }
    const owner = await client(bob);
    const reader = await client(carol);
    const { scene } = (
      await owner.call("POST", "/api/scenes", { name: "Leser zuerst" })
    ).json();
    await owner.call("PUT", `/api/scenes/${scene.id}/grants`, {
      grants: [{ type: "group", principal: "/IT", role: "viewer" }],
    });
    const room = `scene-${scene.id}`;
    const open = (cookie: string) => {
      const socket = connect(`http://127.0.0.1:${address.port}`, {
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

    const readerSocket = await open(reader.cookie);
    const readerFirst = new Promise((resolve) =>
      readerSocket.once("first-in-room", resolve),
    );
    readerSocket.emit("join-room", room);
    await readerFirst;

    // only a viewer is there, who can't send the scene: load it from the server
    const ownerSocket = await open(owner.cookie);
    const ownerFirst = new Promise((resolve) =>
      ownerSocket.once("first-in-room", resolve),
    );
    ownerSocket.emit("join-room", room);
    await ownerFirst;
  });

  it("answers malformed input with 400, not with server errors", async () => {
    env = await createTestEnv();
    const owner = await client(bob);
    const colleague = await client(carol);
    const created = (
      await owner.call("POST", "/api/scenes", { name: "Teil\u0000A\tB" })
    ).json();
    expect(created.scene.name).toBe("Teil A B");
    const sceneId = created.scene.id;

    for (const body of [
      { ...content(null), expectedRevision: 1.5 },
      { ...content(null), expectedRevision: 1e21 },
      { ...content(null), sceneVersion: 1e300 },
      { ...content(null), sceneVersion: -1 },
    ]) {
      expect(
        (await owner.call("PUT", `/api/scenes/${sceneId}/content`, body))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await owner.call("PUT", `/api/rooms/abcdef0123456789abcd/scene`, {
          ...content(null),
          expectedRevision: "99999999999999999999",
        })
      ).statusCode,
    ).toBe(400);

    expect((await owner.call("GET", "/api/scenes?q=a&q=b")).statusCode).toBe(
      200,
    );
    expect((await owner.call("GET", "/api/scenes?q=%00Teil")).statusCode).toBe(
      200,
    );
    expect(
      (await owner.call("GET", "/api/directory?q=%00Carol")).statusCode,
    ).toBe(200);

    // the same group twice (once with blanks): stored once, higher role wins
    expect(
      (
        await owner.call("PUT", `/api/scenes/${sceneId}/grants`, {
          grants: [
            { type: "group", principal: "/IT", role: "viewer" },
            { type: "group", principal: " /IT ", role: "editor" },
            { type: "group", principal: "/IT\u0000", role: "viewer" },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await owner.call("PUT", `/api/scenes/${sceneId}/grants`, {
          grants: [
            { type: "group", principal: "/IT", role: "viewer" },
            { type: "group", principal: " /IT ", role: "editor" },
          ],
        })
      ).statusCode,
    ).toBe(200);
    const stored = (
      await owner.call("GET", `/api/scenes/${sceneId}/grants`)
    ).json();
    expect(stored.grants).toMatchObject([
      { type: "group", principal: "/IT", role: "editor" },
    ]);

    // user ids in upper case still match the person
    await owner.call("PUT", `/api/scenes/${sceneId}/grants`, {
      grants: [
        { type: "user", principal: colleague.id.toUpperCase(), role: "viewer" },
      ],
    });
    expect(
      (await colleague.call("GET", `/api/scenes/${sceneId}`)).json().scene.role,
    ).toBe("viewer");
    // "%" and "_" are searched literally
    const sharedWith = async (q: string) =>
      (
        await colleague.call(
          "GET",
          `/api/scenes?view=shared&q=${encodeURIComponent(q)}`,
        )
      ).json().scenes.length;
    expect(await sharedWith("Teil")).toBe(1);
    expect(await sharedWith("%")).toBe(0);
    expect(await sharedWith("T_il")).toBe(0);

    // a collection must keep a manager who exists
    const collection = (
      await owner.call("POST", "/api/collections", { name: "Team" })
    ).json();
    for (const manager of [
      { type: "group", principal: "/Gibt-es-nicht", role: "manager" },
      {
        type: "user",
        principal: "00000000-0000-4000-8000-000000000000",
        role: "manager",
      },
    ]) {
      expect(
        (
          await owner.call("PUT", `/api/collections/${collection.id}/grants`, {
            grants: [manager],
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await owner.call("PUT", `/api/collections/${collection.id}/grants`, {
          grants: [{ type: "group", principal: "/IT", role: "manager" }],
        })
      ).statusCode,
    ).toBe(200);
  });
});
