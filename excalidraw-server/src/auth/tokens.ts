import { sql } from "kysely";

import { randomToken, sha256 } from "../util/crypto.js";
import { sendError } from "../util/http.js";

import type { Config } from "../config.js";
import type { ApiToken, Database, User } from "../db/schema.js";
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { Kysely } from "kysely";

/** personal API tokens: "exc_" and 43 random characters */
export const TOKEN_PREFIX = "exc_";
const TOKEN_RE = /^exc_[A-Za-z0-9_-]{43}$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// don't write last_used_at on every request
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const generateToken = () => {
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256(token), hint: token.slice(-4) };
};

/** the token of an "Authorization: Bearer ..." header, if well-formed */
export const bearerToken = (header: string | undefined) => {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || "");
  return match && TOKEN_RE.test(match[1]) ? match[1] : null;
};

/** whether the user may hold API tokens at all */
export const mayUseApi = (config: Config, user: User) => {
  const hasRole = (role: string | null) =>
    !role || user.roles.includes(role) || user.is_admin;
  return (
    config.api.enabled &&
    !user.disabled_at &&
    hasRole(config.oidc.requiredRole) &&
    hasRole(config.api.requiredRole)
  );
};

export class TokenStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: Config,
  ) {}

  get loginMaxAgeDays() {
    return this.config.api.loginMaxAgeDays;
  }

  /** e.g. when Keycloak says the person may no longer use the app */
  async revokeAll(userId: string) {
    await this.db
      .updateTable("api_tokens")
      .set({ revoked_at: sql`now()` })
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** user and token for a bearer token, or why it is not valid (now) */
  async resolve(
    token: string,
  ): Promise<
    | { user: User; token: ApiToken }
    | { error: "invalid_token" | "login_required" }
  > {
    const row = await this.db
      .selectFrom("api_tokens")
      .selectAll()
      .where("token_hash", "=", sha256(token))
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) {
      return { error: "invalid_token" };
    }
    const user = await this.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    // roles as of the user's last login
    if (!user || !mayUseApi(this.config, user)) {
      return { error: "invalid_token" };
    }
    // ... which must be recent, so that people who left or lost access in
    // Keycloak (and no longer sign in) lose their tokens too
    const maxAge = this.config.api.loginMaxAgeDays;
    if (
      maxAge > 0 &&
      (!user.last_login_at ||
        Date.now() - new Date(user.last_login_at).getTime() >
          maxAge * 24 * 3600 * 1000)
    ) {
      return { error: "login_required" };
    }
    if (
      !row.last_used_at ||
      Date.now() - new Date(row.last_used_at).getTime() > TOUCH_INTERVAL_MS
    ) {
      await this.db
        .updateTable("api_tokens")
        .set({ last_used_at: sql`now()` })
        .where("id", "=", row.id)
        .execute();
    }
    return { user, token: row };
  }
}

/**
 * Routes of the REST API and the MCP server: a personal token in the
 * Authorization header, never the session cookie (so no CSRF either).
 * Read tokens may only read.
 */
export const createRequireToken =
  (tokens: TokenStore): preHandlerHookHandler =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearerToken(request.headers.authorization);
    const resolved = token
      ? await tokens.resolve(token)
      : { error: "invalid_token" as const };
    if ("error" in resolved) {
      reply.header("www-authenticate", 'Bearer error="invalid_token"');
      return resolved.error === "login_required"
        ? sendError(
            reply,
            401,
            "login_required",
            `API-Tokens gelten nur, wenn du dich in den letzten ${tokens.loginMaxAgeDays} Tagen in Excalidraw angemeldet hast. Bitte einmal anmelden.`,
          )
        : sendError(
            reply,
            401,
            "invalid_token",
            "API-Token fehlt, ist ungültig, abgelaufen oder widerrufen.",
          );
    }
    if (
      !SAFE_METHODS.has(request.method) &&
      resolved.token.scope !== "write" &&
      // MCP: every call is a POST; tools check the scope themselves
      !request.url.startsWith("/mcp")
    ) {
      reply.header("www-authenticate", 'Bearer error="insufficient_scope"');
      return sendError(
        reply,
        403,
        "insufficient_scope",
        "Dieses Token darf nur lesen.",
      );
    }
    request.auth = {
      user: resolved.user,
      session: null,
      token: resolved.token,
    };
  };
