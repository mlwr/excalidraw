import { STATUS_CODES } from "node:http";

import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { sql } from "kysely";

import { OidcClient } from "./auth/oidc.js";
import { registerAuth } from "./auth/routes.js";
import { SessionStore } from "./auth/sessions.js";
import { createDb, migrateToLatest } from "./db/index.js";
import { attachRealtime } from "./realtime/socket.js";
import { registerDataRoutes } from "./routes/data.js";
import { registerStatic } from "./routes/static.js";
import { createBlobStore } from "./storage/index.js";
import { openSceneKey } from "./util/crypto.js";
import { HttpError, sendError } from "./util/http.js";
import { actorOf, sceneAccess } from "./workspace/access.js";
import { registerWorkspaceRoutes } from "./workspace/routes.js";
import { createSceneOperations } from "./api/operations.js";
import {
  registerApiRoutes,
  registerCommentRoutes,
  registerTokenRoutes,
} from "./api/routes.js";
import { createRequireToken, TokenStore } from "./auth/tokens.js";
import { createEventLog } from "./events.js";
import { startJobs } from "./jobs.js";
import { createMetrics } from "./metrics.js";
import { createLifecycle } from "./workspace/lifecycle.js";
import { createSearch } from "./workspace/search.js";
import { registerAdminRoutes } from "./admin/routes.js";
import { registerAiRoutes } from "./ai/routes.js";
import { createAi } from "./ai/service.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import { createNotifications } from "./notifications/service.js";
import { registerMcp } from "./mcp/server.js";
import { createCommentService } from "./workspace/comments.js";
import { createWorkspaceService } from "./workspace/service.js";
import {
  createDiscovery,
  registerDiscoveryRoutes,
} from "./workspace/discovery.js";
import { registerHistoryRoutes } from "./workspace/history.js";
import { registerLibraryRoutes } from "./workspace/libraries.js";
import { registerEmbedRoutes } from "./workspace/embeds.js";

import type { Config } from "./config.js";
import type { AppContext, RealtimeHooks } from "./context.js";
import type { FastifyError, FastifyInstance } from "fastify";
import type { Server } from "socket.io";

const API_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
};

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  io: Server;
  jobs: ReturnType<typeof startJobs>;
  metrics: ReturnType<typeof createMetrics>;
  close: () => Promise<void>;
}

export const buildApp = async (
  config: Config,
  options: { logger?: boolean } = {},
): Promise<BuiltApp> => {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
  });

  const dbHandle = createDb(config.databaseUrl, config.databasePoolSize);
  const metrics = createMetrics();
  if (config.autoMigrate) {
    const applied = await migrateToLatest(dbHandle.db);
    if (applied.length) {
      app.log.info({ migrations: applied }, "database migrated");
    }
  }

  // realtime is attached after the routes; until then the hooks are no-ops
  const realtimeHooks: RealtimeHooks = {
    disconnectSessions: () => {},
    scenePresence: async () => new Map(),
    closeSceneRoom: () => {},
    recheckScenes: async () => {},
    broadcastSceneUpdate: () => {},
    notifyComments: () => {},
    notifyUsers: () => {},
  };

  // filled right below: they need the context themselves
  const ctx = {
    log: app.log,
    config,
    db: dbHandle.db,
    sessions: new SessionStore(dbHandle.db, config.session.ttlSeconds),
    oidc: new OidcClient(config),
    blobs: createBlobStore(config, dbHandle.db),
    events: createEventLog(dbHandle.db, app.log, metrics.event),
    realtime: {
      disconnectSessions: (ids) => realtimeHooks.disconnectSessions(ids),
      scenePresence: () => realtimeHooks.scenePresence(),
      closeSceneRoom: (id) => realtimeHooks.closeSceneRoom(id),
      recheckScenes: (ids) => realtimeHooks.recheckScenes(ids),
      broadcastSceneUpdate: (id, key, elements) =>
        realtimeHooks.broadcastSceneUpdate(id, key, elements),
      notifyComments: (id) => realtimeHooks.notifyComments(id),
      notifyUsers: (ids) => realtimeHooks.notifyUsers(ids),
    },
  } as AppContext;
  ctx.lifecycle = createLifecycle(ctx);
  ctx.ai = createAi(ctx);
  ctx.notifications = createNotifications(ctx);
  ctx.search = createSearch(ctx);

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
        if (!reply.hasHeader(name)) {
          reply.header(name, value);
        }
      }
    }
    return payload;
  });

  // never send internal error details (database messages, stack traces)
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      return sendError(
        reply,
        error.statusCode,
        error.code,
        error.message,
        error.extra,
      );
    }
    const status = error.statusCode || 500;
    if (status < 500) {
      return reply.code(status).send({
        statusCode: status,
        code: error.code,
        error: STATUS_CODES[status],
        message: error.message,
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply
      .code(500)
      .header("cache-control", "no-store")
      .send({ error: "internal_error", message: "Interner Serverfehler" });
  });

  app.addHook("onResponse", async (request, reply) => {
    metrics.httpRequest(
      request.method,
      request.routeOptions.url || "unmatched",
      reply.statusCode,
      reply.elapsedTime / 1000,
    );
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (request, reply) => {
    try {
      await sql`select 1`.execute(ctx.db);
      await ctx.blobs.check();
      return { status: "ok" };
    } catch (error) {
      request.log.warn({ err: error }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  const { requireAuth } = registerAuth(app, ctx);
  registerDataRoutes(app, ctx, requireAuth);
  registerWorkspaceRoutes(app, ctx, requireAuth);

  // Phase 3: comments, REST API, MCP server
  const workspace = createWorkspaceService(ctx);
  const comments = createCommentService(ctx, workspace);
  const operations = createSceneOperations(workspace);
  registerCommentRoutes(app, "/api", { preHandler: requireAuth }, comments);

  // Phase 4: trash, versions, activity, search, export
  const discovery = createDiscovery(ctx, workspace);
  registerHistoryRoutes(app, ctx, workspace, requireAuth);
  registerDiscoveryRoutes(app, ctx, discovery, requireAuth);
  registerAdminRoutes(app, ctx, requireAuth);

  // Phase 5: AI with the company's language model, libraries
  registerAiRoutes(app, ctx, requireAuth);
  registerLibraryRoutes(app, ctx, requireAuth);
  registerNotificationRoutes(app, ctx, requireAuth);
  registerEmbedRoutes(app, ctx, requireAuth);
  if (config.api.enabled) {
    const requireToken = createRequireToken(new TokenStore(ctx.db, config));
    registerTokenRoutes(app, ctx, requireAuth);
    registerApiRoutes(
      app,
      ctx,
      { workspace, operations, comments, discovery },
      requireToken,
    );
    if (config.api.mcpEnabled) {
      registerMcp(
        app,
        ctx,
        { workspace, operations, comments, discovery },
        requireToken,
      );
    }
  }
  await registerStatic(app, config);

  const { io, hooks } = attachRealtime(
    app,
    config,
    ctx.sessions,
    dbHandle.pool,
    async (userId, sceneId) => {
      const user = await ctx.db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", userId)
        .where("disabled_at", "is", null)
        .executeTakeFirst();
      const access = user
        ? await sceneAccess(ctx.db, actorOf(user), sceneId)
        : null;
      if (!access || access.role === "none") {
        return { role: "none" };
      }
      if (access.role === "viewer") {
        // the server checks what viewers send, so it needs the room key
        return {
          role: "viewer",
          key: openSceneKey(config.dataEncryptionKey, access.scene.key_sealed),
        };
      }
      return { role: "editor" };
    },
  );
  Object.assign(realtimeHooks, hooks);

  // housekeeping and deletion periods (S3), one pod at a time
  const MINUTE = 60 * 1000;
  const jobs = startJobs(
    dbHandle.pool,
    app.log,
    [
      {
        name: "sessions",
        everyMs: 15 * MINUTE,
        run: () => ctx.sessions.cleanup(),
      },
      {
        name: "search",
        everyMs: 20 * 1000,
        run: () => ctx.search.indexPending(),
      },
      {
        name: "trash",
        everyMs: 60 * MINUTE,
        run: () => ctx.lifecycle.purgeTrash(),
      },
      {
        name: "versions",
        everyMs: 60 * MINUTE,
        run: () => ctx.lifecycle.thinVersions(),
      },
      {
        name: "traces",
        everyMs: 6 * 60 * MINUTE,
        run: async () => {
          await ctx.ai.condenseUsage();
          await ctx.lifecycle.purgeTraces();
        },
      },
      {
        name: "emails",
        everyMs: MINUTE,
        run: () => ctx.notifications.sendEmails(),
      },
    ],
    metrics.job,
  );

  // --- metrics (B7) ------------------------------------------------------------------
  metrics.gauge(
    "excalidraw_socket_connections",
    "Open realtime connections on this pod.",
    () => io.engine.clientsCount,
  );
  metrics.gauge(
    "excalidraw_db_pool_connections",
    "Database connections of this pod by state.",
    () => [
      [{ state: "total" }, dbHandle.pool.totalCount],
      [{ state: "idle" }, dbHandle.pool.idleCount],
      [{ state: "waiting" }, dbHandle.pool.waitingCount],
    ],
  );
  // figures of the whole installation, counted at most once a minute
  let figures: { at: number; rows: Record<string, number> } | null = null;
  const figure = (name: string) => async () => {
    if (!figures || Date.now() - figures.at > 60_000) {
      const result = await sql<Record<string, string>>`
        select
          (select count(*) from users where erased_at is null and disabled_at is null) as users,
          (select count(*) from users where last_login_at > now() - interval '30 days') as users_active_30d,
          (select count(*) from scenes where deleted_at is null) as scenes,
          (select count(*) from scenes where deleted_at is not null) as scenes_trash,
          (select coalesce(sum(length(ciphertext)), 0) from scenes) as scene_bytes,
          (select count(*) from scene_versions) as versions,
          (select coalesce(sum(size), 0) from scene_versions) as version_bytes,
          (select count(*) from scenes c left join scene_search s on s.scene_id = c.id
            where c.deleted_at is null
              and (s.scene_id is null or s.indexed_revision < c.revision)) as search_pending
      `.execute(ctx.db);
      figures = {
        at: Date.now(),
        rows: Object.fromEntries(
          Object.entries(result.rows[0]).map(([key, value]) => [
            key,
            Number(value),
          ]),
        ),
      };
    }
    return figures.rows[name] ?? null;
  };
  metrics.gauge(
    "excalidraw_users",
    "Active (not disabled) people.",
    figure("users"),
  );
  metrics.gauge(
    "excalidraw_users_active_30d",
    "People who signed in within 30 days.",
    figure("users_active_30d"),
  );
  metrics.gauge(
    "excalidraw_scenes",
    "Scenes, not counting the trash.",
    figure("scenes"),
  );
  metrics.gauge(
    "excalidraw_scenes_trash",
    "Scenes in the trash.",
    figure("scenes_trash"),
  );
  metrics.gauge(
    "excalidraw_scene_bytes",
    "Stored (encrypted) scene content.",
    figure("scene_bytes"),
  );
  metrics.gauge(
    "excalidraw_versions",
    "Stored versions of scenes.",
    figure("versions"),
  );
  metrics.gauge(
    "excalidraw_version_bytes",
    "Stored (encrypted) versions.",
    figure("version_bytes"),
  );
  metrics.gauge(
    "excalidraw_search_pending",
    "Scenes waiting for the search index.",
    figure("search_pending"),
  );

  const close = async () => {
    jobs.stop();
    io.close();
    ctx.notifications.close();
    await metrics.close();
    await app.close();
    await dbHandle.close();
  };

  return { app, ctx, io, jobs, metrics, close };
};
