import { sql } from "kysely";

import { clientConfig } from "../context.js";
import { randomToken, sanitizeReturnTo, sha256 } from "../util/crypto.js";
import { sendError, sendHtmlError } from "../util/http.js";

import { decodeJwtPayload, hasAccess, mapIdentity } from "./claims.js";

import type { AppContext } from "../context.js";
import type { User } from "../db/schema.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const LOGIN_STATE_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_COOKIE_PATH = "/api/auth";

/** one cookie per pending login, so parallel logins in several tabs work */
const loginCookieName = (state: string) =>
  `excalidraw_login_${sha256(state).slice(0, 16)}`;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const publicUser = (user: User) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  username: user.username,
  isAdmin: user.is_admin,
});

const loginLink = (returnTo = "/") => ({
  href: `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
  label: "Erneut anmelden",
});

/**
 * Cookie-authenticated, state-changing requests must come from our own
 * origin. SameSite=Lax alone is not enough in an intranet, where many apps
 * share one "site" (e.g. *.company.example).
 */
const isSameOriginRequest = (request: FastifyRequest, origin: string) => {
  const originHeader = request.headers.origin;
  if (originHeader) {
    return originHeader === origin;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string") {
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  // every supported browser sends one of the two; a cookie without them is
  // not worth the risk (API clients will use tokens, not cookies)
  return false;
};

export const createRequireAuth = (ctx: AppContext): preHandlerHookHandler => {
  const origin = ctx.config.publicUrl.origin;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth) {
      return sendError(reply, 401, "unauthenticated", "Bitte melde dich an.");
    }
    if (
      !SAFE_METHODS.has(request.method) &&
      !isSameOriginRequest(request, origin)
    ) {
      return sendError(reply, 403, "cross_origin_request");
    }
  };
};

export const registerAuth = (app: FastifyInstance, ctx: AppContext) => {
  const { config, db, sessions, oidc } = ctx;
  const cookieName = config.session.cookieName;
  const requireAuth = createRequireAuth(ctx);

  app.decorateRequest("auth", null);

  // resolve the session for every API request; routes decide whether they
  // need it (requireAuth) or not
  app.addHook("onRequest", async (request) => {
    // the REST API takes API tokens only (see auth/tokens.ts); decided by
    // the route that matched, however its address was spelled
    const route = request.routeOptions.url || "";
    if (!route.startsWith("/api/") || route.startsWith("/api/v1/")) {
      return;
    }
    request.auth = await sessions.resolve(request.cookies[cookieName]);
  });

  app.get(
    "/api/auth/login",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const returnTo = sanitizeReturnTo(
        (request.query as Record<string, unknown>).returnTo,
      );

      let login;
      try {
        login = await oidc.createLoginRequest();
      } catch (error) {
        request.log.error({ err: error }, "identity provider unreachable");
        return sendHtmlError(
          reply,
          503,
          "Anmeldung gerade nicht möglich",
          "Der Anmeldedienst (Keycloak) antwortet nicht. Bitte versuche es in ein paar Minuten noch einmal.",
          loginLink(returnTo),
        );
      }

      const binding = randomToken(24);
      await db
        .insertInto("login_states")
        .values({
          id: sha256(binding),
          state: login.state,
          nonce: login.nonce,
          code_verifier: login.codeVerifier,
          return_to: returnTo,
        })
        .execute();

      reply.setCookie(loginCookieName(login.state), binding, {
        path: LOGIN_COOKIE_PATH,
        httpOnly: true,
        secure: config.session.secureCookie,
        sameSite: "lax",
        maxAge: LOGIN_STATE_MAX_AGE_SECONDS,
      });
      reply.header("cache-control", "no-store");
      return reply.redirect(login.url.toString(), 302);
    },
  );

  app.get(
    "/api/auth/callback",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;

      if (query.error) {
        request.log.warn(
          { error: query.error, description: query.error_description },
          "login rejected by identity provider",
        );
        return sendHtmlError(
          reply,
          400,
          "Anmeldung abgebrochen",
          "Die Anmeldung wurde nicht abgeschlossen.",
          loginLink(),
        );
      }

      const state = query.state;
      if (!state) {
        return sendHtmlError(
          reply,
          400,
          "Ungültige Anmeldung",
          "Der Anmelde-Link ist unvollständig.",
          loginLink(),
        );
      }

      const name = loginCookieName(state);
      const binding = request.cookies[name];
      reply.clearCookie(name, { path: LOGIN_COOKIE_PATH });

      const row = await db
        .selectFrom("login_states")
        .selectAll()
        .where("state", "=", state)
        .where(
          "created_at",
          ">",
          sql<Date>`now() - make_interval(secs => ${LOGIN_STATE_MAX_AGE_SECONDS})`,
        )
        .executeTakeFirst();

      if (!row || !binding || sha256(binding) !== row.id) {
        return sendHtmlError(
          reply,
          400,
          "Anmeldung abgelaufen",
          "Die Anmeldung hat zu lange gedauert oder wurde in einem anderen Browser begonnen.",
          loginLink(row?.return_to),
        );
      }
      await db.deleteFrom("login_states").where("id", "=", row.id).execute();

      let result;
      try {
        result = await oidc.exchangeCode(
          new URL(request.url, config.publicUrl),
          {
            state: row.state,
            nonce: row.nonce,
            codeVerifier: row.code_verifier,
          },
        );
      } catch (error) {
        request.log.warn({ err: error }, "authorization code exchange failed");
        return sendHtmlError(
          reply,
          400,
          "Anmeldung fehlgeschlagen",
          "Keycloak hat die Anmeldung nicht bestätigt.",
          loginLink(row.return_to),
        );
      }

      const identity = mapIdentity(config.oidc, [
        result.idTokenClaims,
        decodeJwtPayload(result.accessToken),
        result.userinfo || {},
      ]);

      const issuer =
        typeof result.idTokenClaims.iss === "string"
          ? result.idTokenClaims.iss
          : oidc.issuer;

      if (!hasAccess(config.oidc, identity)) {
        request.log.info(
          { subject: identity.subject },
          "login denied: required role missing",
        );
        // Keycloak took the access away: store what it says now and end the
        // person's API tokens as well
        const known = await db
          .updateTable("users")
          .set({
            roles: identity.roles,
            groups: identity.groups,
            is_admin: identity.isAdmin,
          })
          .where("oidc_issuer", "=", issuer)
          .where("oidc_subject", "=", identity.subject)
          .returning("id")
          .executeTakeFirst();
        if (known) {
          await db
            .updateTable("api_tokens")
            .set({ revoked_at: sql`now()` })
            .where("user_id", "=", known.id)
            .where("revoked_at", "is", null)
            .execute();
        }
        ctx.events.record({
          type: "auth.login_denied",
          actor: known ? { id: known.id, name: identity.name } : null,
          request,
          target: identity.username || identity.subject,
          data: { reason: "required_role" },
        });
        return sendHtmlError(
          reply,
          403,
          "Kein Zugriff",
          `Dein Konto ist angemeldet, hat aber nicht die Keycloak-Rolle „${config.oidc.requiredRole}“, die für Excalidraw nötig ist. Bitte wende dich an die Administration.`,
        );
      }

      const user = await db
        .insertInto("users")
        .values({
          oidc_issuer: issuer,
          oidc_subject: identity.subject,
          email: identity.email,
          name: identity.name,
          username: identity.username,
          roles: identity.roles,
          groups: identity.groups,
          is_admin: identity.isAdmin,
          last_login_at: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(["oidc_issuer", "oidc_subject"]).doUpdateSet({
            email: identity.email,
            name: identity.name,
            username: identity.username,
            roles: identity.roles,
            groups: identity.groups,
            is_admin: identity.isAdmin,
            last_login_at: new Date(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      if (user.disabled_at) {
        return sendHtmlError(
          reply,
          403,
          "Konto gesperrt",
          "Dein Konto ist für Excalidraw gesperrt. Bitte wende dich an die Administration.",
        );
      }

      const token = await sessions.create({
        userId: user.id,
        oidcSid: identity.sid,
        idToken: result.idToken || null,
        userAgent: request.headers["user-agent"] || null,
      });
      ctx.events.record({ type: "auth.login", actor: user, request });

      reply.setCookie(cookieName, token, {
        path: "/",
        httpOnly: true,
        secure: config.session.secureCookie,
        sameSite: "lax",
        maxAge: config.session.ttlSeconds,
      });
      reply.header("cache-control", "no-store");
      request.log.info({ userId: user.id }, "user logged in");
      return reply.redirect(row.return_to, 302);
    },
  );

  app.get("/api/auth/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!request.auth) {
      return sendError(reply, 401, "unauthenticated", "Bitte melde dich an.");
    }
    return {
      user: publicUser(request.auth.user),
      config: {
        ...clientConfig(config),
        // what this person may use
        ai: await ctx.ai.statusFor(request.auth.user),
        embeds: await ctx.editor.embeds(),
        fonts: await ctx.fonts.list(),
      },
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const origin = config.publicUrl.origin;
    if (!isSameOriginRequest(request, origin)) {
      return sendError(reply, 403, "cross_origin_request");
    }
    const token = request.cookies[cookieName];
    reply.clearCookie(cookieName, { path: "/" });
    reply.header("cache-control", "no-store");

    const session = token ? await sessions.destroyByToken(token) : null;
    if (!session) {
      return { redirectUrl: "/" };
    }
    ctx.realtime.disconnectSessions([session.id]);
    ctx.events.record({
      type: "auth.logout",
      actor: request.auth?.user ?? { id: session.user_id, name: "" },
      request,
    });

    let redirectUrl = "/";
    try {
      redirectUrl = (await oidc.buildLogoutUrl(session.id_token)) || "/";
    } catch (error) {
      request.log.warn({ err: error }, "could not build Keycloak logout URL");
    }
    return { redirectUrl };
  });

  // OpenID Connect Back-Channel Logout: Keycloak calls this server-to-server
  // when a session ends elsewhere (logout in another app, admin action).
  app.post(
    "/api/auth/backchannel-logout",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const body = request.body as Record<string, unknown> | undefined;
      const logoutToken = body?.logout_token;
      if (typeof logoutToken !== "string") {
        return sendError(reply, 400, "invalid_request");
      }
      try {
        const { sid, sub } = await oidc.verifyLogoutToken(logoutToken);
        const sessionIds = sid
          ? await sessions.destroyByOidcSid(sid)
          : await sessions.destroyBySubject(oidc.issuer, sub!);
        ctx.realtime.disconnectSessions(sessionIds);
        request.log.info(
          { sessions: sessionIds.length },
          "back-channel logout processed",
        );
        return reply.code(200).send();
      } catch (error) {
        request.log.warn({ err: error }, "invalid back-channel logout token");
        return sendError(reply, 400, "invalid_request");
      }
    },
  );

  return { requireAuth };
};
