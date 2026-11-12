import { createDecipheriv } from "node:crypto";

import { createAdapter } from "@socket.io/postgres-adapter";
import { Server } from "socket.io";

import { encryptForBrowser } from "../workspace/content.js";

import type { SessionStore } from "../auth/sessions.js";
import type { Config } from "../config.js";
import type { RealtimeHooks } from "../context.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { RemoteSocket, Socket } from "socket.io";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const FOLLOW_ROOM_PREFIX = "follow@";
/** rooms of workspace scenes: "scene-<sceneId>" (access-controlled) */
export const SCENE_ROOM_PREFIX = "scene-";

/**
 * Message types (the app's WS_SUBTYPES) a viewer may send: where they are
 * and what they look at, never scene changes (SCENE_INIT, SCENE_UPDATE).
 */
const VIEWER_MESSAGE_TYPES = new Set([
  "MOUSE_LOCATION",
  "IDLE_STATUS",
  "USER_VISIBLE_SCENE_BOUNDS",
]);
// the app encrypts messages with AES-128-GCM (WebCrypto: ciphertext | tag)
const ROOM_KEY_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const JOINS_PER_MINUTE = 20;
const SESSION_SWEEP_MS = 60 * 1000;

export type SceneRoomRole = "none" | "viewer" | "editor";

export interface SceneRoomAccess {
  role: SceneRoomRole;
  /** the scene's room key (base64url), needed to police viewers */
  key?: string;
}

/** decides who may join the live room of a workspace scene */
export type SceneRoomAuthorizer = (
  userId: string,
  sceneId: string,
) => Promise<SceneRoomAccess>;

interface UserFollowPayload {
  userToFollow?: { socketId?: unknown };
  action?: unknown;
}

const isValidRoomId = (roomId: unknown): roomId is string =>
  typeof roomId === "string" && ROOM_ID_RE.test(roomId);

/** rooms of the collaboration protocol (not the server's own bookkeeping) */
const isCollabRoom = (room: string, socketId: string) =>
  room !== socketId &&
  !room.startsWith("session:") &&
  !room.startsWith("user:") &&
  !room.startsWith(FOLLOW_ROOM_PREFIX);

const toBuffer = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

/**
 * Type of an encrypted collaboration message, or null if it does not
 * decrypt with the room key.
 */
export const messageType = (
  key: Buffer,
  encryptedData: unknown,
  iv: unknown,
): string | null => {
  const data = toBuffer(encryptedData);
  const nonce = toBuffer(iv);
  if (
    !data ||
    !nonce ||
    nonce.length !== IV_BYTES ||
    data.length <= AUTH_TAG_BYTES
  ) {
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(data.subarray(data.length - AUTH_TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(0, data.length - AUTH_TAG_BYTES)),
      decipher.final(),
    ]);
    const message = JSON.parse(plaintext.toString("utf8"));
    return typeof message?.type === "string" ? message.type : null;
  } catch {
    return null;
  }
};

/** what only this process knows about one of its sockets */
interface LocalState {
  /** keys of the scene rooms the socket may only watch */
  viewerKeys: Map<string, Buffer>;
  joins: number[];
}

/**
 * Realtime collaboration with the same event protocol as the upstream
 * excalidraw-room server, so the app's collaboration code stays unchanged.
 * Differences: every connection must carry a valid session cookie and come
 * from our own origin, payloads are relayed only within joined rooms, and
 * viewers of a workspace scene can show their cursor but not change it.
 */
export const attachRealtime = (
  app: FastifyInstance,
  config: Config,
  sessions: SessionStore,
  pool: pg.Pool,
  authorizeSceneRoom: SceneRoomAuthorizer,
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

  const local = new Map<string, LocalState>();

  const authorize = (userId: string, roomId: string) =>
    authorizeSceneRoom(userId, roomId.slice(SCENE_ROOM_PREFIX.length)).catch(
      (error): SceneRoomAccess => {
        app.log.error({ err: error }, "scene room authorization failed");
        return { role: "none" };
      },
    );

  const sessionExpired = (socket: Socket) =>
    Date.now() >= socket.data.sessionExpiresAt;

  io.use(async (socket, next) => {
    try {
      const cookies = app.parseCookie(socket.request.headers.cookie || "");
      const auth = await sessions.resolve(cookies[config.session.cookieName]);
      if (!auth) {
        return next(new Error("unauthorized"));
      }
      socket.data.userId = auth.user.id;
      socket.data.userName = auth.user.name;
      socket.data.sessionId = auth.session.id;
      socket.data.sessionExpiresAt = new Date(
        auth.session.expires_at,
      ).getTime();
      // scene rooms this socket may only watch (viewers); visible to every
      // node of the cluster, unlike the keys in `local`
      socket.data.readOnlyRooms = [] as string[];
      next();
    } catch (error) {
      app.log.error({ err: error }, "socket authentication failed");
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const state: LocalState = { viewerKeys: new Map(), joins: [] };
    local.set(socket.id, state);

    socket.join(`session:${socket.data.sessionId}`);
    socket.join(`user:${socket.data.userId}`);

    io.to(socket.id).emit("init-room");

    const setReadOnly = (roomId: string, key: Buffer | null) => {
      const readOnly = new Set<string>(socket.data.readOnlyRooms);
      if (key) {
        state.viewerKeys.set(roomId, key);
        readOnly.add(roomId);
      } else {
        state.viewerKeys.delete(roomId);
        readOnly.delete(roomId);
      }
      socket.data.readOnlyRooms = [...readOnly];
    };

    const joinAllowed = () => {
      const now = Date.now();
      state.joins = state.joins.filter((at) => now - at < 60 * 1000);
      if (state.joins.length >= JOINS_PER_MINUTE) {
        return false;
      }
      state.joins.push(now);
      return true;
    };

    socket.on("join-room", async (roomId: unknown) => {
      if (sessionExpired(socket)) {
        socket.disconnect(true);
        return;
      }
      if (!isValidRoomId(roomId) || !joinAllowed()) {
        return;
      }
      if (roomId.startsWith(SCENE_ROOM_PREFIX)) {
        const access = await authorize(socket.data.userId, roomId);
        const key =
          access.role === "viewer" && access.key
            ? Buffer.from(access.key, "base64url")
            : null;
        if (
          access.role === "none" ||
          (access.role === "viewer" && key?.length !== ROOM_KEY_BYTES)
        ) {
          io.to(socket.id).emit("room-access-denied", roomId);
          return;
        }
        setReadOnly(roomId, key);
      }
      await socket.join(roomId);
      const sockets = await io.in(roomId).fetchSockets();
      // viewers can't hand over the scene (SCENE_INIT): with nobody else
      // who can, the newcomer loads it from the server right away
      const senders = sockets.filter(
        (s) =>
          s.id !== socket.id &&
          !((s.data.readOnlyRooms || []) as string[]).includes(roomId),
      );
      if (senders.length === 0) {
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
        if (sessionExpired(socket)) {
          socket.disconnect(true);
          return;
        }
        if (typeof roomId !== "string") {
          return;
        }
        // followers get the viewport through "follow@<own socket id>"
        const toFollowers = roomId === `${FOLLOW_ROOM_PREFIX}${socket.id}`;
        // otherwise only relay into rooms this socket actually joined
        if (
          !toFollowers &&
          (!isValidRoomId(roomId) || !socket.rooms.has(roomId))
        ) {
          return;
        }
        // viewers: the server holds the room key and lets presence through
        // only; whether the client calls it volatile does not matter
        const { viewerKeys } = state;
        if (viewerKeys.size && (toFollowers || viewerKeys.has(roomId))) {
          const keys = toFollowers
            ? [...viewerKeys.values()]
            : [viewerKeys.get(roomId)!];
          const type = keys
            .map((key) => messageType(key, encryptedData, iv))
            .find((found) => found !== null);
          if (!type || !VIEWER_MESSAGE_TYPES.has(type)) {
            return;
          }
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
      if (
        typeof socketId !== "string" ||
        !ROOM_ID_RE.test(socketId) ||
        socketId === socket.id
      ) {
        return;
      }
      const roomId = `${FOLLOW_ROOM_PREFIX}${socketId}`;
      if (payload.action === "FOLLOW") {
        // only follow someone in the same session or scene
        const [target] = await io.in(socketId).fetchSockets();
        const sharesRoom =
          !!target &&
          [...socket.rooms].some(
            (room) => isCollabRoom(room, socket.id) && target.rooms.has(room),
          );
        if (!sharesRoom) {
          return;
        }
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

    socket.on("disconnect", () => {
      local.delete(socket.id);
    });
  });

  // sessions have a fixed end: close live connections that outlived theirs
  const sweep = setInterval(() => {
    for (const socket of io.of("/").sockets.values()) {
      if (sessionExpired(socket)) {
        socket.disconnect(true);
      }
    }
  }, SESSION_SWEEP_MS);
  sweep.unref();
  app.server.once("close", () => clearInterval(sweep));

  /** the app reloads the scene and comes back with its current rights */
  const endLiveAccess = (socket: RemoteSocket<any, any>, roomId: string) => {
    socket.emit("scene-access-changed", roomId);
    socket.disconnect(true);
  };

  const hooks: RealtimeHooks = {
    disconnectSessions: (sessionIds) => {
      if (sessionIds.length) {
        io.in(sessionIds.map((id) => `session:${id}`)).disconnectSockets(true);
      }
    },
    scenePresence: async () => {
      const presence = new Map<string, { id: string; name: string }[]>();
      let sockets: RemoteSocket<any, any>[];
      try {
        sockets = await io.fetchSockets();
      } catch (error) {
        // e.g. a cluster node went away and has not timed out yet
        app.log.warn({ err: error }, "presence lookup failed");
        return presence;
      }
      for (const socket of sockets) {
        for (const room of socket.rooms) {
          if (!room.startsWith(SCENE_ROOM_PREFIX)) {
            continue;
          }
          const sceneId = room.slice(SCENE_ROOM_PREFIX.length);
          const users = presence.get(sceneId) || [];
          if (!users.some((user) => user.id === socket.data.userId)) {
            users.push({ id: socket.data.userId, name: socket.data.userName });
          }
          presence.set(sceneId, users);
        }
      }
      return presence;
    },
    closeSceneRoom: (sceneId) => {
      io.in(`${SCENE_ROOM_PREFIX}${sceneId}`).disconnectSockets(true);
    },
    broadcastSceneUpdate: (sceneId, sceneKey, elements) => {
      if (!elements.length) {
        return;
      }
      // the server speaks as a collaborator: an encrypted SCENE_UPDATE
      const { iv, data } = encryptForBrowser(
        sceneKey,
        Buffer.from(
          JSON.stringify({ type: "SCENE_UPDATE", payload: { elements } }),
        ),
      );
      io.to(`${SCENE_ROOM_PREFIX}${sceneId}`).emit(
        "client-broadcast",
        data,
        iv,
      );
    },
    notifyComments: (sceneId) => {
      io.to(`${SCENE_ROOM_PREFIX}${sceneId}`).emit("comments-changed");
    },
    notifyUsers: (userIds) => {
      for (const userId of new Set(userIds)) {
        io.to(`user:${userId}`).emit("notifications-changed");
      }
    },
    recheckScenes: async (sceneIds) => {
      const rooms = new Set(sceneIds.map((id) => `${SCENE_ROOM_PREFIX}${id}`));
      if (!rooms.size) {
        return;
      }
      const sockets =
        rooms.size === 1
          ? await io.in([...rooms][0]).fetchSockets()
          : await io.fetchSockets();
      for (const socket of sockets) {
        for (const roomId of socket.rooms) {
          if (!rooms.has(roomId)) {
            continue;
          }
          const access = await authorize(socket.data.userId, roomId);
          const wasReadOnly = (
            (socket.data.readOnlyRooms || []) as string[]
          ).includes(roomId);
          // lost access, or became viewer or editor: start over
          if (
            access.role === "none" ||
            (access.role === "viewer") !== wasReadOnly
          ) {
            endLiveAccess(socket, roomId);
            break;
          }
        }
      }
    },
  };

  return { io, hooks };
};
