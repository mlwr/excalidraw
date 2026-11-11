import { sql } from "kysely";

import { randomToken, sha256 } from "../util/crypto.js";

import type { Database, Session, User } from "../db/schema.js";
import type { Kysely } from "kysely";

export interface AuthContext {
  user: User;
  session: Session;
}

// don't write last_seen_at on every request
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export class SessionStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ttlSeconds: number,
  ) {}

  /** creates a session and returns the raw token for the cookie */
  async create(input: {
    userId: string;
    oidcSid: string | null;
    idToken: string | null;
    userAgent: string | null;
  }): Promise<string> {
    const token = randomToken(32);
    await this.db
      .insertInto("sessions")
      .values({
        id: sha256(token),
        user_id: input.userId,
        oidc_sid: input.oidcSid,
        id_token: input.idToken,
        expires_at: new Date(Date.now() + this.ttlSeconds * 1000),
        user_agent: input.userAgent ? input.userAgent.slice(0, 512) : null,
      })
      .execute();
    return token;
  }

  async resolve(token: string | undefined): Promise<AuthContext | null> {
    if (!token || token.length > 256) {
      return null;
    }
    const id = sha256(token);
    const session = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", id)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!session) {
      return null;
    }
    const user = await this.db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", session.user_id)
      .where("disabled_at", "is", null)
      .executeTakeFirst();
    if (!user) {
      return null;
    }
    if (
      Date.now() - new Date(session.last_seen_at).getTime() >
      TOUCH_INTERVAL_MS
    ) {
      await this.db
        .updateTable("sessions")
        .set({ last_seen_at: sql`now()` })
        .where("id", "=", id)
        .execute();
    }
    return { user, session };
  }

  async destroyByToken(token: string): Promise<Session | null> {
    const row = await this.db
      .deleteFrom("sessions")
      .where("id", "=", sha256(token))
      .returningAll()
      .executeTakeFirst();
    return row || null;
  }

  /** back-channel logout by Keycloak session id; returns deleted session ids */
  async destroyByOidcSid(sid: string): Promise<string[]> {
    const rows = await this.db
      .deleteFrom("sessions")
      .where("oidc_sid", "=", sid)
      .returning("id")
      .execute();
    return rows.map((row) => row.id);
  }

  /** back-channel logout by subject; returns deleted session ids */
  async destroyBySubject(issuer: string, subject: string): Promise<string[]> {
    const rows = await this.db
      .deleteFrom("sessions")
      .where("user_id", "in", (qb) =>
        qb
          .selectFrom("users")
          .select("id")
          .where("oidc_issuer", "=", issuer)
          .where("oidc_subject", "=", subject),
      )
      .returning("id")
      .execute();
    return rows.map((row) => row.id);
  }

  async cleanup(): Promise<void> {
    await this.db
      .deleteFrom("sessions")
      .where("expires_at", "<", sql<Date>`now()`)
      .execute();
    await this.db
      .deleteFrom("login_states")
      .where("created_at", "<", sql<Date>`now() - interval '15 minutes'`)
      .execute();
  }
}
