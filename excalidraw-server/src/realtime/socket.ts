import { createAdapter } from "@socket.io/postgres-adapter";
import { Server } from "socket.io";

import type { SessionStore } from "../auth/sessions.js";
import type { Config } from "../config.js";
import type { RealtimeHooks } from "../context.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Socket } from "socket.io";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const FOLLOW_ROOM_PREFIX = "follow@";

interface UserFollowPayload {
  userToFollow?: { socketId?: unknown };
  action?: unknown;
}

const isValidRoomId = (roomId: unknown): roomId is string =>
  typeof roomId === "string" && ROOM_ID_RE.test(roomId);

/**
 * Realtime collaboration with the same event protocol as the upstream
 * excalidraw-room server, so the app's collaboration code stays unchanged.
 * Differences: every connection must carry a valid session cookie and come
 * from our own origin, and payloads are relayed only within joined rooms.
 */
export const attachRealtime = (
  app: FastifyInstance,
  config: Config,
  sessions: SessionStore,
  pool: pg.Pool,
): { io: Server; hooks: RealtimeHooks } => {
  const origin = config.publicUrl.origin;

  const io = new Server(app.server, {
    path: "/socket.io/",
    maxHttpBufferSize: config.realtime.maxPayloadBytes,
    transports: ["websocket", "polling"],
    allowRequest: (request, callback) => {
      // cross-site WebSocket hijacking protection
      callback(null, request.headers.origin === origin);
    },
  });

  if (config.realtime.cluster) {
    io.adapter(createAdapter(pool, { tableName: "socket_io_attachments" }));
  }

  io.use(async (socket, next) => {
    try {
      const cookies = app.parseCookie(socket.request.headers.cookie || "");
      const auth = await sessions.resolve(cookies[config.session.cookieName]);
      if (!auth) {
        return next(new Error("unauthorized"));
      }
      socket.data.userId = auth.user.id;
      socket.data.sessionId = auth.session.id;
      next();
    } catch (error) {
      app.log.error({ err: error }, "socket authentication failed");
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    socket.join(`session:${socket.data.sessionId}`);
    socket.join(`user:${socket.data.userId}`);

    io.to(socket.id).emit("init-room");

    socket.on("join-room", async (roomId: unknown) => {
      if (!isValidRoomId(roomId)) {
        return;
      }
      await socket.join(roomId);
      const sockets = await io.in(roomId).fetchSockets();
      if (sockets.length <= 1) {
        io.to(socket.id).emit("first-in-room");
      } else {
        socket.broadcast.to(roomId).emit("new-user", socket.id);
      }
      io.in(roomId).emit(
        "room-user-change",
        sockets.map((s) => s.id),
      );
    });

    const relay =
      (volatile: boolean) =>
      (roomId: unknown, encryptedData: unknown, iv: unknown) => {
        // only relay into rooms this socket actually joined
        if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) {
          return;
        }
        const target = volatile
          ? socket.volatile.broadcast.to(roomId)
          : socket.broadcast.to(roomId);
        target.emit("client-broadcast", encryptedData, iv);
      };

    socket.on("server-broadcast", relay(false));
    socket.on("server-volatile-broadcast", relay(true));

    socket.on("user-follow", async (payload: UserFollowPayload) => {
      const socketId = payload?.userToFollow?.socketId;
      if (typeof socketId !== "string" || !ROOM_ID_RE.test(socketId)) {
        return;
      }
      const roomId = `${FOLLOW_ROOM_PREFIX}${socketId}`;
      if (payload.action === "FOLLOW") {
        await socket.join(roomId);
      } else if (payload.action === "UNFOLLOW") {
        await socket.leave(roomId);
      } else {
        return;
      }
      const sockets = await io.in(roomId).fetchSockets();
      io.to(socketId).emit(
        "user-follow-room-change",
        sockets.map((s) => s.id),
      );
    });

    socket.on("disconnecting", async () => {
      for (const roomId of socket.rooms) {
        if (
          roomId === socket.id ||
          roomId.startsWith("session:") ||
          roomId.startsWith("user:")
        ) {
          continue;
        }
        const otherClients = (await io.in(roomId).fetchSockets()).filter(
          (s) => s.id !== socket.id,
        );
        const isFollowRoom = roomId.startsWith(FOLLOW_ROOM_PREFIX);
        if (!isFollowRoom && otherClients.length > 0) {
          socket.broadcast.to(roomId).emit(
            "room-user-change",
            otherClients.map((s) => s.id),
          );
        }
        if (isFollowRoom && otherClients.length === 0) {
          const followedSocketId = roomId.slice(FOLLOW_ROOM_PREFIX.length);
          io.to(followedSocketId).emit("broadcast-unfollow");
        }
      }
    });
  });

  const hooks: RealtimeHooks = {
    disconnectSessions: (sessionIds) => {
      if (sessionIds.length) {
        io.in(sessionIds.map((id) => `session:${id}`)).disconnectSockets(true);
      }
    },
  };

  return { io, hooks };
};
