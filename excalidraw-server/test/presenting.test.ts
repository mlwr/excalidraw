/**
 * Presenting over the realtime connection: phone remote control (P4) and
 * live presentations for an audience (P6).
 */
import { io as connect } from "socket.io-client";
import { afterEach, expect, it } from "vitest";

import { liveIdOf } from "../src/realtime/presenting.js";

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

/** nothing arrives within a short while */
const silent = (socket: Socket, event: string, ms = 300) =>
  new Promise<boolean>((resolve) => {
    const listener = () => resolve(false);
    socket.once(event, listener);
    setTimeout(() => {
      socket.off(event, listener);
      resolve(true);
    }, ms);
  });

const ask = <T>(socket: Socket, event: string, ...args: unknown[]) =>
  new Promise<T>((resolve) => socket.emit(event, ...args, resolve));

describeWithDb("presenting", () => {
  let env: TestEnv;
  let url: string;
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.close());
    await env?.close();
  });

  const start = async () => {
    env = await createTestEnv();
    await env.built.app.listen({ host: "127.0.0.1", port: 0 });
    const address = env.built.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("server not listening");
    }
    url = `http://127.0.0.1:${address.port}`;
  };

  const open = async (user: FakeUser) => {
    const cookie = await env.login(user);
    const socket = connect(url, {
      transports: ["websocket"],
      extraHeaders: { origin: ORIGIN, cookie },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    await waitFor(socket, "init-room");
    return socket;
  };

  it("lets a phone control the presentation that showed its QR code", async () => {
    await start();
    const presenter = await open(bob);
    const phone = await open(bob);
    const stranger = await open(alice);
    const key = "QRkey_0123456789abcdefghij";

    expect(await ask(presenter, "remote-join", key)).toEqual({ ok: true });
    const joined = waitFor(presenter, "remote-peer");
    expect(await ask(phone, "remote-join", key)).toEqual({ ok: true });
    expect(await joined).toEqual({ type: "joined" });

    const command = waitFor(presenter, "remote-message");
    phone.emit("remote-message", key, { type: "next" });
    expect(await command).toEqual({ type: "next" });
    const state = waitFor(phone, "remote-message");
    presenter.emit("remote-message", key, {
      type: "state",
      state: { notes: "Gehalt: geheim" },
    });
    expect(await state).toMatchObject({ type: "state" });

    // someone else who saw the code lands in a room of their own: no
    // notes, no slides moved, no notice of having joined
    const noNotice = silent(presenter, "remote-peer");
    expect(await ask(stranger, "remote-join", key)).toEqual({ ok: true });
    expect(await noNotice).toBe(true);
    const noNotes = silent(stranger, "remote-message");
    presenter.emit("remote-message", key, {
      type: "state",
      state: { notes: "Gehalt: geheim" },
    });
    expect(await noNotes).toBe(true);
    const quiet = silent(presenter, "remote-message");
    stranger.emit("remote-message", key, { type: "next" });
    expect(await quiet).toBe(true);
    expect(await ask(stranger, "remote-join", "short")).toEqual({ ok: false });

    // a "joined" sent as a message is a message, not the server's notice
    const forged = silent(presenter, "remote-peer");
    phone.emit("remote-message", key, { type: "joined", name: "Vorstand" });
    expect(await forged).toBe(true);
  });

  it("shows the presenter's slides to the audience, and their reactions to the presenter", async () => {
    await start();
    const presenter = await open(bob);
    const listener = await open(carol);
    const other = await open(alice);
    const hostKey = "hostKey_0123456789abcdefgh";
    const id = liveIdOf(hostKey);

    expect(await ask(presenter, "live-host", hostKey)).toEqual({
      ok: true,
      id,
    });
    const arrived = waitFor<{ type: string; socketId: string }>(
      presenter,
      "live-audience",
    );
    expect(await ask(listener, "live-join", id)).toEqual({ ok: true });
    // no name when joining: names come with reactions and hands only
    expect(await arrived).toEqual({ type: "joined", socketId: listener.id });
    expect(await ask(presenter, "live-count", hostKey)).toEqual({ count: 1 });

    // the slide reaches the audience, stamped by the server
    const slide = waitFor(listener, "live-state");
    presenter.emit("live-state", hostKey, {
      started: true,
      index: 0,
      presenter: "Alice Admin (Vorstand)",
    });
    expect(await slide).toEqual({
      started: true,
      index: 0,
      liveId: id,
      presenter: "Bob Beispiel",
    });

    // a newcomer gets the slide alone, the others not again
    const second = await open(alice);
    const newcomer = waitFor<{ socketId: string }>(presenter, "live-audience");
    expect(await ask(second, "live-join", id)).toEqual({ ok: true });
    const { socketId } = await newcomer;
    const alone = waitFor(second, "live-state");
    const notAgain = silent(listener, "live-state");
    presenter.emit(
      "live-state",
      hostKey,
      { started: true, index: 0 },
      socketId,
    );
    expect(await alone).toMatchObject({ liveId: id, index: 0 });
    expect(await notAgain).toBe(true);

    // only the host sends slides: the id alone is not enough
    expect(await ask(other, "live-host", id)).toEqual({
      ok: true,
      id: liveIdOf(id),
    });
    const noFake = silent(listener, "live-state");
    other.emit("live-state", id, { started: true, index: 99 });
    expect(await noFake).toBe(true);

    // reactions and hands carry the name from the login
    const reaction = waitFor(presenter, "live-audience");
    listener.emit("live-feedback", id, { type: "reaction", emoji: "👏" });
    expect(await reaction).toEqual({
      type: "reaction",
      emoji: "👏",
      name: "Carol IT",
    });
    const unknownEmoji = silent(presenter, "live-audience");
    listener.emit("live-feedback", id, { type: "reaction", emoji: "💣" });
    expect(await unknownEmoji).toBe(true);
    const hand = waitFor<{ socketId: string }>(presenter, "live-audience");
    listener.emit("live-feedback", id, { type: "hand", raised: true });
    const raised = await hand;
    expect(raised).toMatchObject({
      type: "hand",
      raised: true,
      name: "Carol IT",
    });

    // the host lowers it, within the audience only
    const lowered = waitFor(listener, "live-hand-lowered");
    const notOutside = silent(other, "live-hand-lowered");
    presenter.emit("live-lower-hand", hostKey, raised.socketId);
    expect(await lowered).toEqual({ socketId: listener.id });
    expect(await notOutside).toBe(true);
    // not into other rooms
    const otherUser = silent(other, "live-hand-lowered");
    presenter.emit("live-lower-hand", hostKey, `user:${other.id}`);
    presenter.emit("live-lower-hand", hostKey, other.id);
    expect(await otherUser).toBe(true);

    // outsiders of the room send nothing to the host
    const outside = silent(presenter, "live-audience");
    other.emit("live-feedback", id, { type: "reaction", emoji: "👍" });
    expect(await outside).toBe(true);

    // leaving is noticed
    const left = waitFor(presenter, "live-audience");
    listener.close();
    expect(await left).toMatchObject({ type: "left" });
  });

  it("throttles what a connection sends and keeps one room of a kind", async () => {
    await start();
    const presenter = await open(bob);
    const listener = await open(carol);
    const hostKey = "hostKey_throttle_0123456789";
    const id = liveIdOf(hostKey);
    expect(await ask(presenter, "live-host", hostKey)).toMatchObject({
      ok: true,
    });
    expect(await ask(listener, "live-join", id)).toEqual({ ok: true });

    let received = 0;
    listener.on("live-state", () => {
      received++;
    });
    for (let i = 0; i < 60; i++) {
      presenter.emit("live-state", hostKey, { started: true, index: i });
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThanOrEqual(30);

    // a second live presentation on the same connection replaces the first
    const other = await open(alice);
    const otherKey = "hostKey_other_0123456789ab";
    expect(await ask(other, "live-host", otherKey)).toMatchObject({ ok: true });
    expect(await ask(listener, "live-join", liveIdOf(otherKey))).toEqual({
      ok: true,
    });
    // (a fresh host connection: the first one has used up its messages)
    const again = await open(bob);
    expect(await ask(again, "live-host", hostKey)).toMatchObject({ ok: true });
    const gone = silent(listener, "live-state", 400);
    again.emit("live-state", hostKey, { started: true, index: 0 });
    expect(await gone).toBe(true);
  });
});
