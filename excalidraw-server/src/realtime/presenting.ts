/**
 * Presenting over the realtime connection (Phase 6):
 *
 * - P4, remote control: the presenting tab and a phone share a random key
 *   (QR code). Their room is "remote:<user id>:<key>": only the same login
 *   gets in, whoever else sees the code lands in a room of their own.
 * - P6, live presentation: the presenter holds a secret host key; the
 *   audience link carries only its hash (the live id). The host sends the
 *   current slide (rendered) to "live:<id>", a newcomer gets it alone; the
 *   audience sends reactions and raised hands, with their names from the
 *   login, to "live-host:<id>". What the audience sees is stamped here with
 *   the live id and the presenter's name.
 *
 * Nothing is stored. Rooms use a colon, which the collaboration protocol's
 * room ids cannot contain, so they cannot be joined or written to that way.
 * A connection is in at most one room of each kind, and pays for what it
 * sends: messages per second, slide bytes per minute.
 */
import { createHash } from "node:crypto";

import type { Server, Socket } from "socket.io";

export const PRESENTING_ROOM_PREFIXES = ["remote:", "live:", "live-host:"];

const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const LIVE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** socket.io's connection ids */
const SOCKET_ID_RE = /^[A-Za-z0-9_-]{20}$/;
const MAX_REMOTE_BYTES = 64 * 1024;
/** a rendered slide (PNG of at most 1920 pixels) */
const MAX_STATE_BYTES = 4 * 1024 * 1024;
/** slides one connection may send per minute (each a database row in a cluster) */
const STATE_BYTES_PER_MINUTE = 24 * 1024 * 1024;
export const REACTIONS = new Set(["👍", "👏", "❤️", "😂", "😮", "🎉", "🤔"]);

/** the public id of a live presentation, from the host's secret key */
export const liveIdOf = (hostKey: string) =>
  createHash("sha256").update(hostKey).digest("base64url").slice(0, 22);

const sizeOf = (value: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Infinity;
  }
};

const answer = (ack: unknown, value: unknown) => {
  if (typeof ack === "function") {
    ack(value);
  }
};

export const attachPresenting = (io: Server, socket: Socket) => {
  // a little of everything per socket: 30 messages per 10 seconds
  let tokens = 30;
  let refilled = Date.now();
  const allow = () => {
    const now = Date.now();
    tokens = Math.min(30, tokens + ((now - refilled) / 10_000) * 30);
    refilled = now;
    if (tokens < 1) {
      return false;
    }
    tokens -= 1;
    return true;
  };

  // slide bytes: refilled over a minute
  let budget = STATE_BYTES_PER_MINUTE;
  let budgetAt = Date.now();
  const spend = (bytes: number) => {
    const now = Date.now();
    budget = Math.min(
      STATE_BYTES_PER_MINUTE,
      budget + ((now - budgetAt) / 60_000) * STATE_BYTES_PER_MINUTE,
    );
    budgetAt = now;
    if (budget < bytes) {
      return false;
    }
    budget -= bytes;
    return true;
  };

  /** one room of a kind per connection: a new one replaces the old */
  const joinOnly = (prefix: string, room: string) => {
    for (const current of socket.rooms) {
      if (current.startsWith(prefix) && current !== room) {
        void socket.leave(current);
      }
    }
    void socket.join(room);
  };

  const remoteRoom = (key: string) => `remote:${socket.data.userId}:${key}`;

  const hostRoom = (hostKey: unknown) => {
    if (typeof hostKey !== "string" || !KEY_RE.test(hostKey)) {
      return null;
    }
    const id = liveIdOf(hostKey);
    return socket.rooms.has(`live-host:${id}`) ? id : null;
  };

  // --- P4: remote control ------------------------------------------------------

  socket.on("remote-join", (key: unknown, ack?: unknown) => {
    if (typeof key !== "string" || !KEY_RE.test(key) || !allow()) {
      answer(ack, { ok: false });
      return;
    }
    const room = remoteRoom(key);
    joinOnly("remote:", room);
    // a notice of the server's own: no message anyone could send
    socket.to(room).emit("remote-peer", { type: "joined" });
    answer(ack, { ok: true });
  });

  socket.on("remote-message", (key: unknown, message: unknown) => {
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      return;
    }
    const room = remoteRoom(key);
    if (
      !socket.rooms.has(room) ||
      sizeOf(message) > MAX_REMOTE_BYTES ||
      !allow()
    ) {
      return;
    }
    socket.to(room).emit("remote-message", message);
  });

  // --- P6: live presentation ------------------------------------------------------

  socket.on("live-host", (hostKey: unknown, ack?: unknown) => {
    if (typeof hostKey !== "string" || !KEY_RE.test(hostKey) || !allow()) {
      answer(ack, { ok: false });
      return;
    }
    const id = liveIdOf(hostKey);
    joinOnly("live-host:", `live-host:${id}`);
    answer(ack, { ok: true, id });
  });

  socket.on("live-state", (hostKey: unknown, state: unknown, to?: unknown) => {
    const id = hostRoom(hostKey);
    if (!id || !state || typeof state !== "object" || Array.isArray(state)) {
      return;
    }
    const size = sizeOf(state);
    if (size > MAX_STATE_BYTES || !allow() || !spend(size)) {
      return;
    }
    // who presents and which presentation: from here, not from the sender
    const stamped = {
      ...(state as Record<string, unknown>),
      liveId: id,
      presenter: socket.data.userName,
    };
    if (to !== undefined) {
      // a newcomer alone (its page ignores states of other presentations)
      if (typeof to === "string" && SOCKET_ID_RE.test(to)) {
        io.to(to).emit("live-state", stamped);
      }
      return;
    }
    io.to(`live:${id}`).emit("live-state", stamped);
  });

  socket.on("live-count", async (hostKey: unknown, ack?: unknown) => {
    const id = hostRoom(hostKey);
    if (!id || !allow()) {
      answer(ack, { count: 0 });
      return;
    }
    const audience = await io.in(`live:${id}`).fetchSockets();
    answer(ack, { count: audience.length });
  });

  socket.on("live-lower-hand", (hostKey: unknown, socketId: unknown) => {
    const id = hostRoom(hostKey);
    if (
      id &&
      typeof socketId === "string" &&
      SOCKET_ID_RE.test(socketId) &&
      allow()
    ) {
      // within the audience only; the page whose hand it is takes it down
      io.to(`live:${id}`).emit("live-hand-lowered", { socketId });
    }
  });

  socket.on("live-join", (id: unknown, ack?: unknown) => {
    if (typeof id !== "string" || !LIVE_ID_RE.test(id) || !allow()) {
      answer(ack, { ok: false });
      return;
    }
    joinOnly("live:", `live:${id}`);
    // no name: the presenter learns names from reactions and hands only
    io.to(`live-host:${id}`).emit("live-audience", {
      type: "joined",
      socketId: socket.id,
    });
    answer(ack, { ok: true });
  });

  socket.on("live-feedback", (id: unknown, feedback: unknown) => {
    if (typeof id !== "string" || !socket.rooms.has(`live:${id}`) || !allow()) {
      return;
    }
    const value = (feedback || {}) as {
      type?: unknown;
      emoji?: unknown;
      raised?: unknown;
    };
    if (
      value.type === "reaction" &&
      typeof value.emoji === "string" &&
      REACTIONS.has(value.emoji)
    ) {
      io.to(`live-host:${id}`).emit("live-audience", {
        type: "reaction",
        emoji: value.emoji,
        name: socket.data.userName,
      });
    } else if (value.type === "hand" && typeof value.raised === "boolean") {
      io.to(`live-host:${id}`).emit("live-audience", {
        type: "hand",
        raised: value.raised,
        socketId: socket.id,
        name: socket.data.userName,
      });
    }
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room.startsWith("live:")) {
        io.to(`live-host:${room.slice("live:".length)}`).emit("live-audience", {
          type: "left",
          socketId: socket.id,
        });
      }
    }
  });
};
