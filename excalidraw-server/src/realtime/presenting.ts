/**
 * Presenting over the realtime connection (Phase 6):
 *
 * - P4, remote control: the presenting tab and a phone share a random key
 *   (QR code) and pass messages in the room "remote:<key>".
 * - P6, live presentation: the presenter holds a secret host key; the
 *   audience link carries only its hash (the live id). The host sends the
 *   current slide (rendered) to "live:<id>"; the audience sends reactions
 *   and raised hands, with their names from the login, to "live-host:<id>".
 *
 * Nothing is stored. Rooms use a colon, which the collaboration protocol's
 * room ids cannot contain, so they cannot be joined or written to that way.
 */
import { createHash } from "node:crypto";

import type { Server, Socket } from "socket.io";

export const PRESENTING_ROOM_PREFIXES = ["remote:", "live:", "live-host:"];

const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const LIVE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_REMOTE_BYTES = 64 * 1024;
/** a rendered slide, with its images and fonts */
const MAX_STATE_BYTES = 10 * 1024 * 1024;
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
    socket.join(`remote:${key}`);
    socket
      .to(`remote:${key}`)
      .emit("remote-message", { type: "joined", name: socket.data.userName });
    answer(ack, { ok: true });
  });

  socket.on("remote-message", (key: unknown, message: unknown) => {
    if (
      typeof key !== "string" ||
      !socket.rooms.has(`remote:${key}`) ||
      sizeOf(message) > MAX_REMOTE_BYTES ||
      !allow()
    ) {
      return;
    }
    socket.to(`remote:${key}`).emit("remote-message", message);
  });

  // --- P6: live presentation ------------------------------------------------------

  socket.on("live-host", (hostKey: unknown, ack?: unknown) => {
    if (typeof hostKey !== "string" || !KEY_RE.test(hostKey)) {
      answer(ack, { ok: false });
      return;
    }
    const id = liveIdOf(hostKey);
    socket.join(`live-host:${id}`);
    answer(ack, { ok: true, id });
  });

  socket.on("live-state", (hostKey: unknown, state: unknown) => {
    const id = hostRoom(hostKey);
    if (!id || sizeOf(state) > MAX_STATE_BYTES) {
      return;
    }
    io.to(`live:${id}`).emit("live-state", state);
  });

  socket.on("live-count", async (hostKey: unknown, ack?: unknown) => {
    const id = hostRoom(hostKey);
    if (!id) {
      answer(ack, { count: 0 });
      return;
    }
    const audience = await io.in(`live:${id}`).fetchSockets();
    answer(ack, { count: audience.length });
  });

  socket.on("live-lower-hand", (hostKey: unknown, socketId: unknown) => {
    if (hostRoom(hostKey) && typeof socketId === "string") {
      io.to(socketId).emit("live-hand-lowered");
    }
  });

  socket.on("live-join", (id: unknown, ack?: unknown) => {
    if (typeof id !== "string" || !LIVE_ID_RE.test(id) || !allow()) {
      answer(ack, { ok: false });
      return;
    }
    socket.join(`live:${id}`);
    io.to(`live-host:${id}`).emit("live-audience", {
      type: "joined",
      socketId: socket.id,
      name: socket.data.userName,
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
