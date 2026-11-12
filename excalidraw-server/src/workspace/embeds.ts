/**
 * Embedding scenes in wiki and intranet pages (T3): an embedding link
 * (`/embed/<token>`) shows the scene read-only in an iframe and follows
 * changes. Like a read-only link it is for everyone logged in who has it;
 * if the workspace allows it, also without login (for pages on other
 * domains, whose iframes get no login cookie).
 */
import { openSceneKey, randomToken } from "../util/crypto.js";
import { HttpError, sendError } from "../util/http.js";
import { queryParam } from "../util/validate.js";

import { actorOf, sceneAccess } from "./access.js";
import { policiesOf } from "./workspaces.js";

import type { AppContext } from "../context.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const TOKEN_RE = /^[a-zA-Z0-9_-]{16,64}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export const registerEmbedRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config, blobs } = ctx;

  const policiesFor = async (workspaceId: string) => {
    const workspace = await db
      .selectFrom("workspaces")
      .select("settings")
      .where("id", "=", workspaceId)
      .executeTakeFirstOrThrow();
    return policiesOf(workspace, {
      trashRetentionDays: config.retention.trashDays,
    });
  };

  const embedUrl = (token: string) =>
    new URL(`/embed/${token}`, config.publicUrl).toString();

  /** a scene I may manage, for creating or removing its embedding link */
  const managed = async (request: FastifyRequest, sceneId: string) => {
    const access = await sceneAccess(db, actorOf(request.auth!.user), sceneId);
    if (!access || access.role === "none") {
      throw new HttpError(404, "not_found", "Szene nicht gefunden.");
    }
    if (!access.canManage) {
      throw new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");
    }
    return access;
  };

  app.post<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/embed",
    { preHandler: requireAuth },
    async (request) => {
      const access = await managed(request, request.params.sceneId);
      if (!(await policiesFor(access.scene.workspace_id)).embeds) {
        throw new HttpError(
          403,
          "policy",
          "In diesem Workspace lassen sich Szenen nicht einbetten.",
        );
      }
      let token = access.scene.embed_token;
      if (!token) {
        token = randomToken(24);
        await db
          .updateTable("scenes")
          .set({ embed_token: token })
          .where("id", "=", access.scene.id)
          .execute();
        ctx.events.record({
          type: "share.embed_created",
          actor: request.auth!.user,
          request,
          workspaceId: access.scene.workspace_id,
          collectionId: access.scene.collection_id,
          sceneId: access.scene.id,
          data: { name: access.scene.name },
        });
      }
      return { url: embedUrl(token) };
    },
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/embed",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await managed(request, request.params.sceneId);
      if (access.scene.embed_token) {
        await db
          .updateTable("scenes")
          .set({ embed_token: null })
          .where("id", "=", access.scene.id)
          .execute();
        ctx.events.record({
          type: "share.embed_deleted",
          actor: request.auth!.user,
          request,
          workspaceId: access.scene.workspace_id,
          collectionId: access.scene.collection_id,
          sceneId: access.scene.id,
          data: { name: access.scene.name },
        });
      }
      return reply.code(204).send();
    },
  );

  /**
   * the scene behind an embedding link, if this request may see it:
   * logged in, or without login where the workspace allows that
   */
  const embedded = async (
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ) => {
    reply.header("cache-control", "no-store");
    if (!TOKEN_RE.test(token)) {
      sendError(reply, 404, "not_found", "Dieser Link ist nicht gültig.");
      return null;
    }
    const scene = await db
      .selectFrom("scenes")
      .select([
        "id",
        "name",
        "workspace_id",
        "key_sealed",
        "revision",
        "updated_at",
      ])
      .where("embed_token", "=", token)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const policies = scene ? await policiesFor(scene.workspace_id) : null;
    if (!scene || !policies?.embeds) {
      sendError(
        reply,
        404,
        "not_found",
        "Diese Einbettung gibt es nicht mehr.",
      );
      return null;
    }
    if (!request.auth && !policies.embedsWithoutLogin) {
      sendError(reply, 401, "login_required", "Zum Ansehen bitte anmelden.");
      return null;
    }
    return scene;
  };

  app.get<{ Params: { token: string } }>(
    "/api/embed/:token",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const scene = await embedded(request, reply, request.params.token);
      if (!scene) {
        return reply;
      }
      // polling: nothing new since this revision
      const since = queryParam(
        (request.query as Record<string, unknown>).since,
      );
      if (since !== undefined && since === String(scene.revision)) {
        return reply.code(204).send();
      }
      const content = await db
        .selectFrom("scenes")
        .select(["iv", "ciphertext"])
        .where("id", "=", scene.id)
        .executeTakeFirstOrThrow();
      return {
        scene: {
          name: scene.name,
          revision: Number(scene.revision),
          updatedAt: scene.updated_at,
          url: request.auth
            ? new URL(`/s/${scene.id}`, config.publicUrl).toString()
            : null,
        },
        key: openSceneKey(config.dataEncryptionKey, scene.key_sealed),
        iv: content.iv ? content.iv.toString("base64") : null,
        ciphertext: content.ciphertext
          ? content.ciphertext.toString("base64")
          : null,
      };
    },
  );

  app.get<{ Params: { token: string; fileId: string } }>(
    "/api/embed/:token/files/:fileId",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const scene = await embedded(request, reply, request.params.token);
      if (!scene) {
        return reply;
      }
      if (!FILE_ID_RE.test(request.params.fileId)) {
        return sendError(reply, 404, "not_found");
      }
      const blob = await blobs.get(
        `files/scenes/${scene.id}/${request.params.fileId}`,
      );
      if (!blob) {
        return sendError(reply, 404, "not_found");
      }
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .type("application/octet-stream")
        .send(blob.data);
    },
  );
};
