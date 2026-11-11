import { afterEach, expect, it } from "vitest";

import {
  alice,
  bob,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { TestEnv } from "./helpers/setup.js";

const scene = (expectedRevision: number | null, marker = "a") => ({
  sceneVersion: 42,
  iv: Buffer.from("123456789012").toString("base64"),
  ciphertext: Buffer.from(`encrypted-${marker}`).toString("base64"),
  expectedRevision,
});

describeWithDb("storage API", () => {
  let env: TestEnv;

  afterEach(async () => {
    await env?.close();
  });

  it("stores room scenes with optimistic concurrency", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const headers = { cookie, origin: ORIGIN };
    const url = "/api/rooms/0123456789abcdef0123/scene";
    const app = env.built.app;

    expect((await app.inject({ url, headers })).statusCode).toBe(404);

    const created = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: scene(null),
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().revision).toBe(1);

    const duplicate = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: scene(null),
    });
    expect(duplicate.statusCode).toBe(409);

    const updated = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: scene(1, "b"),
    });
    expect(updated.json().revision).toBe(2);

    const stale = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: scene(1, "c"),
    });
    expect(stale.statusCode).toBe(409);

    const loaded = await app.inject({ url, headers });
    expect(loaded.json()).toMatchObject({ sceneVersion: 42, revision: 2 });
    expect(Buffer.from(loaded.json().ciphertext, "base64").toString()).toBe(
      "encrypted-b",
    );
  });

  it("rejects malformed room ids and bodies", async () => {
    env = await createTestEnv();
    const cookie = await env.login(bob);
    const headers = { cookie, origin: ORIGIN };
    const app = env.built.app;
    expect(
      (await app.inject({ url: "/api/rooms/bad%20id/scene", headers }))
        .statusCode,
    ).toBe(400);
    const badBody = await app.inject({
      method: "PUT",
      url: "/api/rooms/abc/scene",
      headers,
      payload: { sceneVersion: "x" },
    });
    expect(badBody.statusCode).toBe(400);
  });

  it("stores files write-once and enforces the size limit", async () => {
    env = await createTestEnv({ MAX_FILE_SIZE_MB: "1" });
    const cookie = await env.login(bob);
    const headers = {
      cookie,
      origin: ORIGIN,
      "content-type": "application/octet-stream",
    };
    const app = env.built.app;
    const url = "/api/files/rooms/room1/file1";

    const first = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: Buffer.from("one"),
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: Buffer.from("two"),
    });
    expect(second.statusCode).toBe(200);

    const loaded = await app.inject({ url, headers: { cookie } });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.rawPayload.toString()).toBe("one");
    expect(loaded.headers["cache-control"]).toContain("immutable");

    const tooLarge = await app.inject({
      method: "PUT",
      url: "/api/files/rooms/room1/file2",
      headers,
      payload: Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge.statusCode).toBe(413);

    const unauthenticated = await app.inject({ url });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("creates share links compatible with the json backend protocol", async () => {
    env = await createTestEnv();
    const bobCookie = await env.login(bob);
    const aliceCookie = await env.login(alice);
    const app = env.built.app;

    const created = await app.inject({
      method: "POST",
      url: "/api/v2/post/",
      headers: {
        cookie: bobCookie,
        origin: ORIGIN,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("compressed-and-encrypted"),
    });
    expect(created.statusCode).toBe(200);
    const { id } = created.json();
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);

    // anyone signed in can open the link (the key stays in the URL fragment)
    const loaded = await app.inject({
      url: `/api/v2/${id}`,
      headers: { cookie: aliceCookie },
    });
    expect(loaded.rawPayload.toString()).toBe("compressed-and-encrypted");

    // but only the creator may attach files to it
    const fileUrl = `/api/files/share-links/${id}/file1`;
    const foreign = await app.inject({
      method: "PUT",
      url: fileUrl,
      headers: {
        cookie: aliceCookie,
        origin: ORIGIN,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("x"),
    });
    expect(foreign.statusCode).toBe(403);
    const own = await app.inject({
      method: "PUT",
      url: fileUrl,
      headers: {
        cookie: bobCookie,
        origin: ORIGIN,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("x"),
    });
    expect(own.statusCode).toBe(201);
  });

  it("answers oversized share links with the error the app understands", async () => {
    env = await createTestEnv({ MAX_SHARE_LINK_SIZE_MB: "1" });
    const cookie = await env.login(bob);
    const response = await env.built.app.inject({
      method: "POST",
      url: "/api/v2/post/",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(1024 * 1024 + 10),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error_class).toBe("RequestTooLargeError");
  });

  it("reports readiness", async () => {
    env = await createTestEnv();
    const ready = await env.built.app.inject({ url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    const live = await env.built.app.inject({ url: "/healthz" });
    expect(live.json()).toEqual({ status: "ok" });
  });
});
