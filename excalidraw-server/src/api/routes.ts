/**
 * Phase 3 routes:
 * - /api/tokens: the app manages a person's API tokens (session cookie)
 * - /api/v1/...: REST API for scripts and integrations (API token)
 * - comments, for the app (/api/...) and the REST API (/api/v1/...)
 */
import { sql } from "kysely";

import { bearerToken, generateToken, mayUseApi } from "../auth/tokens.js";
import { sha256 } from "../util/crypto.js";
import { HttpError, sendError } from "../util/http.js";
import { queryParam, searchText } from "../util/validate.js";
import { actorOf } from "../workspace/access.js";
import { cleanName } from "../workspace/service.js";
import { policiesOf, resolveWorkspace } from "../workspace/workspaces.js";

import { openApiDocument } from "./openapi.js";
import {
  diagramSpec,
  elementList,
  idList,
  pagination,
  skeletonList,
  sortOf,
  updateList,
} from "./validate.js";

import type { AppContext } from "../context.js";
import type { CommentService, ThreadStatus } from "../workspace/comments.js";
import type { WorkspaceService } from "../workspace/service.js";
import type { Discovery } from "../workspace/discovery.js";
import type { SceneOperations } from "./operations.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACTIVE_TOKENS = 25;

const actor = (request: FastifyRequest) => actorOf(request.auth!.user);
const body = (request: FastifyRequest) =>
  (request.body && typeof request.body === "object"
    ? request.body
    : {}) as Record<string, unknown>;

/** requests per token (or address) and minute */
export const apiRateLimit = (ctx: AppContext) => ({
  rateLimit: {
    max: ctx.config.api.rateLimitPerMinute,
    timeWindow: "1 minute",
    // the token itself, however the header is spelled; without a
    // well-formed token the address (the global limit applies as well)
    keyGenerator: (request: FastifyRequest) => {
      const token = bearerToken(request.headers.authorization);
      return token ? sha256(token) : request.ip;
    },
  },
});

// --- tokens (the app) ---------------------------------------------------------

export const registerTokenRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config } = ctx;

  const describe = (row: {
    id: string;
    name: string;
    scope: string;
    token_hint: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date;
  }) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    hint: row.token_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  });

  app.get("/api/tokens", { preHandler: requireAuth }, async (request) => {
    const user = request.auth!.user;
    const rows = await db
      .selectFrom("api_tokens")
      .selectAll()
      .where("user_id", "=", user.id)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute();
    return {
      allowed: mayUseApi(config, user),
      maxDays: config.api.tokenMaxDays,
      loginMaxAgeDays: config.api.loginMaxAgeDays,
      mcpEnabled: config.api.mcpEnabled,
      tokens: rows.map(describe),
    };
  });

  app.post(
    "/api/tokens",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = request.auth!.user;
      if (!mayUseApi(config, user)) {
        return sendError(
          reply,
          403,
          "api_not_allowed",
          "Du darfst keine API-Tokens anlegen.",
        );
      }
      const input = body(request);
      const name = cleanName(input.name);
      if (!name || name.length > 100) {
        return sendError(
          reply,
          400,
          "invalid_name",
          "Bitte einen Namen angeben.",
        );
      }
      const scope = input.scope ?? "read";
      if (scope !== "read" && scope !== "write") {
        return sendError(
          reply,
          400,
          "invalid_scope",
          "scope ist read oder write.",
        );
      }
      const days = Number(
        input.expiresInDays ?? Math.min(90, config.api.tokenMaxDays),
      );
      if (
        !Number.isInteger(days) ||
        days < 1 ||
        days > config.api.tokenMaxDays
      ) {
        return sendError(
          reply,
          400,
          "invalid_expiry",
          `Gültigkeit: 1 bis ${config.api.tokenMaxDays} Tage.`,
        );
      }
      const active = await db
        .selectFrom("api_tokens")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("user_id", "=", user.id)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", sql<Date>`now()`)
        .executeTakeFirstOrThrow();
      if (active.count >= MAX_ACTIVE_TOKENS) {
        return sendError(
          reply,
          400,
          "too_many_tokens",
          `Höchstens ${MAX_ACTIVE_TOKENS} gültige Tokens. Bitte alte widerrufen.`,
        );
      }
      const { token, hash, hint } = generateToken();
      const row = await db
        .insertInto("api_tokens")
        .values({
          user_id: user.id,
          name,
          token_hash: hash,
          token_hint: hint,
          scope,
          expires_at: new Date(Date.now() + days * 24 * 3600 * 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ctx.events.record({
        type: "token.created",
        actor: user,
        request,
        target: row.id,
        data: { name, scope, expiresInDays: days },
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ token, ...describe(row) });
    },
  );

  app.delete<{ Params: { tokenId: string } }>(
    "/api/tokens/:tokenId",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!UUID_RE.test(request.params.tokenId)) {
        return sendError(reply, 404, "not_found");
      }
      const revoked = await db
        .updateTable("api_tokens")
        .set({ revoked_at: sql`now()` })
        .where("id", "=", request.params.tokenId)
        .where("user_id", "=", request.auth!.user.id)
        .where("revoked_at", "is", null)
        .returning("id")
        .executeTakeFirst();
      if (!revoked) {
        return sendError(reply, 404, "not_found");
      }
      ctx.events.record({
        type: "token.revoked",
        actor: request.auth!.user,
        request,
        target: revoked.id,
      });
      return reply.code(204).send();
    },
  );
};

// --- comments (app and REST API) ----------------------------------------------

const threadStatus = (value: unknown): ThreadStatus => {
  const status = queryParam(value) ?? "all";
  if (status !== "open" && status !== "resolved" && status !== "all") {
    throw new HttpError(
      400,
      "invalid_status",
      "status ist open, resolved oder all.",
    );
  }
  return status;
};

export const registerCommentRoutes = (
  app: FastifyInstance,
  prefix: "/api" | "/api/v1",
  options: { preHandler: preHandlerHookHandler; config?: object },
  comments: CommentService,
) => {
  app.get<{ Params: { sceneId: string } }>(
    `${prefix}/scenes/:sceneId/comments`,
    options,
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        threads: await comments.list(
          actor(request),
          request.params.sceneId,
          threadStatus((request.query as Record<string, unknown>).status),
        ),
      };
    },
  );

  app.post<{ Params: { sceneId: string } }>(
    `${prefix}/scenes/:sceneId/comments`,
    options,
    async (request, reply) =>
      reply.code(201).send({
        thread: await comments.createThread(
          actor(request),
          request.params.sceneId,
          body(request),
        ),
      }),
  );

  app.post<{ Params: { threadId: string } }>(
    `${prefix}/comment-threads/:threadId/comments`,
    options,
    async (request, reply) =>
      reply.code(201).send({
        thread: await comments.reply(
          actor(request),
          request.params.threadId,
          body(request),
        ),
      }),
  );

  app.patch<{ Params: { threadId: string } }>(
    `${prefix}/comment-threads/:threadId`,
    options,
    async (request) => {
      const input = body(request);
      const thread =
        input.resolved !== undefined
          ? await comments.setResolved(
              actor(request),
              request.params.threadId,
              input.resolved,
            )
          : await comments.move(actor(request), request.params.threadId, input);
      return { thread };
    },
  );

  app.delete<{ Params: { threadId: string } }>(
    `${prefix}/comment-threads/:threadId`,
    options,
    async (request, reply) => {
      await comments.removeThread(actor(request), request.params.threadId);
      return reply.code(204).send();
    },
  );

  app.patch<{ Params: { commentId: string } }>(
    `${prefix}/comments/:commentId`,
    options,
    async (request) => ({
      thread: await comments.edit(
        actor(request),
        request.params.commentId,
        body(request),
      ),
    }),
  );

  app.delete<{ Params: { commentId: string } }>(
    `${prefix}/comments/:commentId`,
    options,
    async (request, reply) => {
      await comments.remove(actor(request), request.params.commentId);
      return reply.code(204).send();
    },
  );
};

// --- REST API -------------------------------------------------------------------

export const registerApiRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  services: {
    workspace: WorkspaceService;
    operations: SceneOperations;
    comments: CommentService;
    discovery: Discovery;
  },
  requireToken: preHandlerHookHandler,
) => {
  const { config } = ctx;
  const { workspace, operations } = services;
  const options = { preHandler: requireToken, config: apiRateLimit(ctx) };
  const large = {
    ...options,
    bodyLimit: config.limits.maxSceneBytes,
  };

  app.get("/api/v1/openapi.json", async () => openApiDocument(config));

  app.get("/api/v1/me", options, async (request) => {
    const { user, token } = request.auth!;
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        isAdmin: user.is_admin,
      },
      token: token && {
        id: token.id,
        name: token.name,
        scope: token.scope,
        expiresAt: token.expires_at,
      },
    };
  });

  app.get("/api/v1/collections", options, async (request) => ({
    collections: await workspace.listCollections(actor(request)),
  }));

  const listScenes = async (request: FastifyRequest, collectionId?: string) => {
    const query = request.query as Record<string, unknown>;
    const { limit, offset } = pagination(query);
    const result = await workspace.listScenes(actor(request), {
      collectionId: collectionId ?? queryParam(query.collectionId),
      query: searchText(query.q) || undefined,
      sort: sortOf(query.sort),
      limit,
      offset,
    });
    return { ...result, limit, offset };
  };

  app.get<{ Params: { collectionId: string } }>(
    "/api/v1/collections/:collectionId/scenes",
    options,
    async (request) => listScenes(request, request.params.collectionId),
  );

  app.get("/api/v1/scenes", options, async (request) => listScenes(request));

  /**
   * new scene: empty, from skeletons ("elements"), or from an .excalidraw
   * document ("content")
   */
  app.post("/api/v1/scenes", large, async (request, reply) => {
    const input = body(request);
    const name =
      input.name === undefined ? "Unbenannte Szene" : cleanName(input.name);
    if (!name) {
      throw new HttpError(400, "invalid_name", "Ungültiger Name.");
    }
    const content =
      input.content && typeof input.content === "object"
        ? (input.content as Record<string, unknown>)
        : null;
    const skeletons =
      input.elements !== undefined ? skeletonList(input.elements) : null;
    const imported = content ? elementList(content.elements ?? []) : null;
    if (skeletons && imported) {
      throw new HttpError(
        400,
        "invalid_body",
        "Entweder elements (Skelette) oder content (.excalidraw), nicht beides.",
      );
    }
    // check everything that can be checked before the scene exists
    workspace.validateFiles(content?.files);
    const current = actor(request);
    const { scene } = await workspace.createScene(current, {
      name,
      collectionId:
        typeof input.collectionId === "string" ? input.collectionId : null,
    });
    let created: unknown[] = [];
    try {
      if (skeletons) {
        created = (await operations.addElements(current, scene.id, skeletons))
          .created;
      } else if (imported?.length) {
        await operations.replace(current, scene.id, {
          elements: imported,
          files: content!.files,
        });
      }
    } catch (error) {
      // no half-made scenes
      await workspace.discardScene(scene.id);
      throw error;
    }
    return reply.code(201).send({
      scene: await workspace.describeAccess(
        await workspace.sceneFor(current, scene.id, "viewer"),
      ),
      ...(skeletons ? { created } : {}),
    });
  });

  app.get<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId",
    options,
    async (request) => ({
      scene: await workspace.describeAccess(
        await workspace.sceneFor(
          actor(request),
          request.params.sceneId,
          "viewer",
        ),
      ),
    }),
  );

  app.patch<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId",
    options,
    async (request) => ({
      scene: await workspace.updateScene(
        actor(request),
        request.params.sceneId,
        body(request),
      ),
    }),
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId",
    options,
    async (request, reply) => {
      await workspace.deleteScene(actor(request), request.params.sceneId);
      return reply.code(204).send();
    },
  );

  /** the scene as an .excalidraw document */
  app.get<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/content",
    options,
    async (request, reply) => {
      const access = await workspace.sceneFor(
        actor(request),
        request.params.sceneId,
        "viewer",
      );
      const { key, elements, revision } = await workspace.readContent(access);
      const live = elements.filter((element) => !element.isDeleted);
      const withFiles = queryParam(
        (request.query as Record<string, unknown>).files,
      );
      const { files, omitted } =
        withFiles === "false"
          ? { files: {}, omitted: [] as string[] }
          : await workspace.readFiles(access.scene.id, key, live);
      reply.header("cache-control", "no-store");
      return {
        type: "excalidraw",
        version: 2,
        source: config.publicUrl.origin,
        elements: live,
        appState: { viewBackgroundColor: "#ffffff", gridSize: null },
        files,
        // images beyond the size limit of one response
        ...(omitted.length ? { filesOmitted: omitted } : {}),
        revision,
      };
    },
  );

  /** replace the drawing (e.g. with an edited export) */
  app.put<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/content",
    large,
    async (request) => {
      const input = body(request);
      const expected = input.expectedRevision;
      if (
        expected !== undefined &&
        expected !== null &&
        !(Number.isSafeInteger(expected) && (expected as number) >= 0)
      ) {
        throw new HttpError(
          400,
          "invalid_revision",
          "expectedRevision ungültig.",
        );
      }
      return operations.replace(actor(request), request.params.sceneId, {
        elements: elementList(input.elements),
        files: input.files,
        expectedRevision: expected as number | null | undefined,
      });
    },
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/elements",
    options,
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await operations.addElements(
            actor(request),
            request.params.sceneId,
            skeletonList(body(request).elements),
          ),
        ),
  );

  app.patch<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/elements",
    options,
    async (request) =>
      operations.update(
        actor(request),
        request.params.sceneId,
        updateList(body(request).updates),
      ),
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/elements",
    options,
    async (request) =>
      operations.remove(
        actor(request),
        request.params.sceneId,
        idList(
          (request.query as Record<string, unknown>).ids ?? body(request).ids,
        ),
      ),
  );

  app.post<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/diagram",
    options,
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await operations.addDiagram(
            actor(request),
            request.params.sceneId,
            diagramSpec(request.body),
          ),
        ),
  );

  registerCommentRoutes(app, "/api/v1", options, services.comments);

  /** names, texts in drawings and comments; all workspaces without ?workspace */
  app.get("/api/v1/search", options, async (request) => {
    const query = request.query as Record<string, unknown>;
    const workspaceParam = queryParam(query.workspace);
    const current = actor(request);
    const workspaceId = workspaceParam
      ? (await resolveWorkspace(ctx.db, current, workspaceParam)).workspace.id
      : undefined;
    return services.discovery.search(current, {
      workspaceId,
      query: queryParam(query.q) || "",
      limit: 50,
    });
  });

  /** ZIP of .excalidraw files: a workspace (?workspace) or a collection */
  app.get(
    "/api/v1/export",
    {
      ...options,
      // per token, like every API call, but only a few per minute
      config: {
        rateLimit: {
          ...options.config.rateLimit,
          max: 6,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const current = actor(request);
      const { workspace, access } = await resolveWorkspace(
        ctx.db,
        current,
        queryParam(query.workspace),
      );
      if (
        !policiesOf(workspace, {
          trashRetentionDays: config.retention.trashDays,
        }).export &&
        access !== "admin"
      ) {
        throw new HttpError(
          403,
          "policy",
          "In diesem Workspace dürfen nur Admins exportieren.",
        );
      }
      const collectionId = queryParam(query.collection);
      const items = await services.discovery.exportable(current, {
        workspaceId: workspace.id,
        collectionId,
      });
      const { count } = await services.discovery.sendZip(
        reply,
        current,
        items,
        `excalidraw-${workspace.slug}-${new Date()
          .toISOString()
          .slice(0, 10)}.zip`,
      );
      ctx.events.record({
        type: "workspace.exported",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        collectionId: collectionId ?? null,
        data: { scenes: count, via: "api" },
      });
      return reply;
    },
  );
};
