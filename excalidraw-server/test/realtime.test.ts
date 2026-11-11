import { afterEach, expect, it } from "vitest";
import { io as connect } from "socket.io-client";

import {
  bob,
  alice,
  createTestEnv,
  describeWithDb,
  ORIGIN,
} from "./helpers/setup.js";

import type { TestEnv } from "./helpers/setup.js";
import type { Socket } from "socket.io-client";

const waitFor = <T = unknown>(socket: Socket, event: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      5000,
    );
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve((args.length > 1 ? args : args[0]) as T);
    });
  });

describeWithDb("realtime collaboration", () => {
  let env: TestEnv;
  let url: string;
  const sockets: Socket[] = [];

  const open = (cookie: string | null, origin = ORIGIN) => {
    const socket = connect(url, {
      transports: ["websocket"],
      extraHeaders: { origin, ...(cookie ? { cookie } : {}) },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  };

  const start = async () => {
    env = await createTestEnv();
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = env.built.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("server not listening");
    }
    url = `http://127.0.0.1:${address.port}`;
  };

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await env?.close();
  });

  it("refuses connections without a session", async () => {
    await start();
    const socket = open(null);
    const error = await waitFor<Error>(socket, "connect_error");
    expect(error.message).toBe("unauthorized");
  });

  it("refuses connections from other origins", async () => {
    await start();
    const cookie = await env.login(bob);
    const socket = open(cookie, "https://other-app.example");
    await waitFor(socket, "connect_error");
    expect(socket.connected).toBe(false);
  });

  it("speaks the excalidraw-room protocol inside joined rooms", async () => {
    await start();
    const bobCookie = await env.login(bob);
    const aliceCookie = await env.login(alice);
    const roomId = "abcdef0123456789abcd";

    const first = open(bobCookie);
    await waitFor(first, "init-room");
    const firstInRoom = waitFor(first, "first-in-room");
    first.emit("join-room", roomId);
    await firstInRoom;

    const second = open(aliceCookie);
    await waitFor(second, "init-room");
    const newUser = waitFor<string>(first, "new-user");
    const userChange = waitFor<string[]>(second, "room-user-change");
    second.emit("join-room", roomId);
    expect(await newUser).toBe(second.id);
    expect((await userChange).sort()).toEqual([first.id, second.id].sort());

    // a third socket that did not join must not be able to inject updates
    const outsider = open(bobCookie);
    await waitFor(outsider, "init-room");

    const received = waitFor<[ArrayBuffer, Uint8Array]>(
      second,
      "client-broadcast",
    );
    outsider.emit(
      "server-broadcast",
      roomId,
      new Uint8Array([9]),
      new Uint8Array([9]),
    );
    first.emit(
      "server-broadcast",
      roomId,
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4]),
    );
    const [data] = await received;
    expect(Array.from(new Uint8Array(data))).toEqual([1, 2, 3]);
  });

  it("relays the viewport to followers in the same room only", async () => {
    await start();
    const bobCookie = await env.login(bob);
    const aliceCookie = await env.login(alice);
    const roomId = "follow0123456789abcd";

    const leader = open(bobCookie);
    await waitFor(leader, "init-room");
    const first = waitFor(leader, "first-in-room");
    leader.emit("join-room", roomId);
    await first;
    const follower = open(aliceCookie);
    await waitFor(follower, "init-room");
    const joined = waitFor(leader, "new-user");
    follower.emit("join-room", roomId);
    await joined;

    // someone outside the room can't follow
    const stranger = open(aliceCookie);
    await waitFor(stranger, "init-room");
    stranger.emit("user-follow", {
      userToFollow: { socketId: leader.id },
      action: "FOLLOW",
    });

    const followedBy = waitFor<string[]>(leader, "user-follow-room-change");
    follower.emit("user-follow", {
      userToFollow: { socketId: leader.id },
      action: "FOLLOW",
    });
    expect(await followedBy).toEqual([follower.id]);

    // the app sends the viewport to "follow@<own socket id>"
    const bounds = waitFor<[ArrayBuffer, Uint8Array]>(
      follower,
      "client-broadcast",
    );
    let strangerGotIt = false;
    stranger.on("client-broadcast", () => {
      strangerGotIt = true;
    });
    leader.emit(
      "server-volatile-broadcast",
      `follow@${leader.id}`,
      new Uint8Array([7, 7]),
      new Uint8Array([1]),
    );
    const [data] = await bounds;
    expect(Array.from(new Uint8Array(data))).toEqual([7, 7]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(strangerGotIt).toBe(false);
  });

  it("disconnects sockets when the session is logged out", async () => {
    await start();
    const cookie = await env.login(bob);
    const socket = open(cookie);
    await waitFor(socket, "init-room");
    const disconnected = new Promise<string>((resolve) =>
      socket.once("disconnect", (reason) => resolve(reason)),
    );
    await env.built.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: ORIGIN },
    });
    expect(await disconnected).toBe("io server disconnect");
  });
});
