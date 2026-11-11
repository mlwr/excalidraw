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
import { actorOf, sceneAccess } from "./workspace/access.js";
import { registerWorkspaceRoutes } from "./workspace/routes.js";

import type { Config } from "./config.js";
import type { AppContext, RealtimeHooks } from "./context.js";
import type { FastifyInstance } from "fastify";
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
  };

  const ctx: AppContext = {
    config,
    db: dbHandle.db,
    sessions: new SessionStore(dbHandle.db, config.session.ttlSeconds),
    oidc: new OidcClient(config),
    blobs: createBlobStore(config, dbHandle.db),
    realtime: {
      disconnectSessions: (ids) => realtimeHooks.disconnectSessions(ids),
      scenePresence: () => realtimeHooks.scenePresence(),
      closeSceneRoom: (id) => realtimeHooks.closeSceneRoom(id),
    },
  };

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
        .executeTakeFirst();
      const access = user
        ? await sceneAccess(ctx.db, actorOf(user), sceneId)
        : null;
      if (!access || access.role === "none") {
        return "none";
      }
      return access.role === "viewer" ? "viewer" : "editor";
    },
  );
  Object.assign(realtimeHooks, hooks);

  // housekeeping: expired sessions and abandoned logins
  const cleanupTimer = setInterval(() => {
    ctx.sessions.cleanup().catch((error) => {
      app.log.warn({ err: error }, "session cleanup failed");
    });
  }, 15 * 60 * 1000);
  cleanupTimer.unref();

  const close = async () => {
    clearInterval(cleanupTimer);
    io.close();
    await app.close();
    await dbHandle.close();
  };

  return { app, ctx, io, close };
};
