import { sql } from "kysely";

import { randomToken } from "../util/crypto.js";
import { sendError } from "../util/http.js";

import type { AppContext } from "../context.js";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

/** room ids, share link ids and file ids: url-safe, bounded */
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

const FILE_SCOPES = {
  rooms: "rooms",
  "share-links": "shareLinks",
} as const;

type FileScope = keyof typeof FILE_SCOPES;

const isFileScope = (value: string): value is FileScope =>
  Object.prototype.hasOwnProperty.call(FILE_SCOPES, value);

interface SceneBody {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
  /** revision the client based its write on; null = create */
  expectedRevision: number | string | null;
}

const isSceneBody = (body: unknown): body is SceneBody => {
  if (!body || typeof body !== "object") {
    return false;
  }
  const value = body as Record<string, unknown>;
  return (
    typeof value.sceneVersion === "number" &&
    Number.isFinite(value.sceneVersion) &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    (value.expectedRevision === null ||
      typeof value.expectedRevision === "number" ||
      (typeof value.expectedRevision === "string" &&
        /^\d+$/.test(value.expectedRevision)))
  );
};

const isBase64 = (value: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(value);

/**
 * Storage for the existing, end-to-end encrypted collaboration and sharing
 * features. The server only ever sees ciphertext: the keys stay in the URL
 * fragment, which browsers never send.
 */
export const registerDataRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, blobs, config } = ctx;

  // ---------------------------------------------------------------------------
  // collaboration rooms (replaces the Firestore "scenes" collection)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/scene",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { roomId } = request.params;
      if (!ID_RE.test(roomId)) {
        return sendError(reply, 400, "invalid_room_id");
      }
      const room = await db
        .selectFrom("rooms")
        .select(["scene_version", "revision", "iv", "ciphertext"])
        .where("id", "=", roomId)
        .executeTakeFirst();
      reply.header("cache-control", "no-store");
      if (!room) {
        return sendError(reply, 404, "not_found");
      }
      return {
        sceneVersion: Number(room.scene_version),
        revision: Number(room.revision),
        iv: room.iv.toString("base64"),
        ciphertext: room.ciphertext.toString("base64"),
      };
    },
  );

  app.put<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/scene",
    { preHandler: requireAuth, bodyLimit: config.limits.maxSceneBytes },
    async (request, reply) => {
      const { roomId } = request.params;
      if (!ID_RE.test(roomId)) {
        return sendError(reply, 400, "invalid_room_id");
      }
      const body = request.body;
      if (
        !isSceneBody(body) ||
        !isBase64(body.iv) ||
        !isBase64(body.ciphertext)
      ) {
        return sendError(reply, 400, "invalid_body");
      }
      const iv = Buffer.from(body.iv, "base64");
      const ciphertext = Buffer.from(body.ciphertext, "base64");
      const sceneVersion = Math.trunc(body.sceneVersion);
      reply.header("cache-control", "no-store");

      if (body.expectedRevision === null) {
        const inserted = await db
          .insertInto("rooms")
          .values({
            id: roomId,
            created_by: request.auth!.user.id,
            scene_version: sceneVersion,
            revision: 1,
            iv,
            ciphertext,
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .returning("revision")
          .executeTakeFirst();
        if (!inserted) {
          return sendError(reply, 409, "conflict", "room already exists");
        }
        return { revision: Number(inserted.revision) };
      }

      const updated = await db
        .updateTable("rooms")
        .set({
          scene_version: sceneVersion,
          revision: sql`revision + 1`,
          iv,
          ciphertext,
          updated_at: sql`now()`,
        })
        .where("id", "=", roomId)
        .where("revision", "=", String(body.expectedRevision))
        .returning("revision")
        .executeTakeFirst();
      if (!updated) {
        return sendError(reply, 409, "conflict", "scene was changed meanwhile");
      }
      return { revision: Number(updated.revision) };
    },
  );

  // ---------------------------------------------------------------------------
  // binary files of rooms and share links (replaces Firebase Storage)
  // ---------------------------------------------------------------------------

  app.put<{ Params: { scope: string; ownerId: string; fileId: string } }>(
    "/api/files/:scope/:ownerId/:fileId",
    { preHandler: requireAuth, bodyLimit: config.limits.maxFileBytes },
    async (request, reply) => {
      const { scope, ownerId, fileId } = request.params;
      if (!isFileScope(scope) || !ID_RE.test(ownerId) || !ID_RE.test(fileId)) {
        return sendError(reply, 400, "invalid_path");
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.byteLength === 0) {
        return sendError(reply, 400, "empty_body");
      }

      if (scope === "share-links") {
        // only whoever created the share link may attach files to it
        const link = await db
          .selectFrom("share_links")
          .select("created_by")
          .where("id", "=", ownerId)
          .executeTakeFirst();
        if (!link) {
          return sendError(reply, 404, "share_link_not_found");
        }
        if (link.created_by !== request.auth!.user.id) {
          return sendError(reply, 403, "forbidden");
        }
      }

      const created = await blobs.putIfAbsent(
        `files/${FILE_SCOPES[scope]}/${ownerId}/${fileId}`,
        data,
        {
          contentType: "application/octet-stream",
          createdBy: request.auth!.user.id,
        },
      );
      return reply.code(created ? 201 : 200).send({ ok: true });
    },
  );

  app.get<{ Params: { scope: string; ownerId: string; fileId: string } }>(
    "/api/files/:scope/:ownerId/:fileId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { scope, ownerId, fileId } = request.params;
      if (!isFileScope(scope) || !ID_RE.test(ownerId) || !ID_RE.test(fileId)) {
        return sendError(reply, 400, "invalid_path");
      }
      const blob = await blobs.get(
        `files/${FILE_SCOPES[scope]}/${ownerId}/${fileId}`,
      );
      if (!blob) {
        return sendError(reply, 404, "not_found");
      }
      // content-addressed and encrypted: safe to cache privately forever
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .type("application/octet-stream")
        .send(blob.data);
    },
  );

  // ---------------------------------------------------------------------------
  // share links: same protocol as json.excalidraw.com/api/v2, so the
  // client only needs a different base URL
  // ---------------------------------------------------------------------------

  app.post(
    "/api/v2/post/",
    {
      preHandler: requireAuth,
      // allow a little more than the limit so we can answer with the error
      // shape the client understands instead of a generic 413
      bodyLimit: config.limits.maxShareLinkBytes + 1024 * 1024,
    },
    async (request, reply) => {
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.byteLength === 0) {
        return sendError(reply, 400, "empty_body");
      }
      if (data.byteLength > config.limits.maxShareLinkBytes) {
        return reply.code(413).send({
          error_class: "RequestTooLargeError",
          message: "Scene too large",
        });
      }
      const id = randomToken(16);
      await db
        .insertInto("share_links")
        .values({ id, created_by: request.auth!.user.id, payload: data })
        .execute();
      return reply.header("cache-control", "no-store").send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v2/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!ID_RE.test(id)) {
        return sendError(reply, 400, "invalid_id");
      }
      const link = await db
        .selectFrom("share_links")
        .select("payload")
        .where("id", "=", id)
        .executeTakeFirst();
      if (!link) {
        return sendError(reply, 404, "not_found");
      }
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .type("application/octet-stream")
        .send(link.payload);
    },
  );
};
