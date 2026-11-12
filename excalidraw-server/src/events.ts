/**
 * Events: what happened, by whom, when. One table serves two purposes:
 * - the activity feed of a workspace (W8): changes to scenes, collections,
 *   comments and sharing, for people who can see them
 * - the audit log (S2): everything, including sign-ins, API tokens and
 *   administration, for admins only, kept for AUDIT_RETENTION_DAYS
 *
 * Event data never contains drawing or comment content (that is encrypted);
 * names of scenes and collections are stored as they were at the time.
 */
import { sql } from "kysely";

import type { Database, User } from "./db/schema.js";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

export type EventType =
  | "auth.login"
  | "auth.login_denied"
  | "auth.logout"
  | "token.created"
  | "token.revoked"
  | "scene.created"
  | "scene.renamed"
  | "scene.moved"
  | "scene.edited"
  | "scene.deleted"
  | "scene.restored"
  | "scene.purged"
  | "scene.version_restored"
  | "scene.exported"
  | "share.scene_grants"
  | "share.read_link_created"
  | "share.read_link_deleted"
  | "collection.created"
  | "collection.renamed"
  | "collection.deleted"
  | "collection.grants"
  | "comment.created"
  | "comment.replied"
  | "comment.resolved"
  | "comment.reopened"
  | "comment.deleted"
  | "workspace.created"
  | "workspace.updated"
  | "workspace.deleted"
  | "workspace.members"
  | "workspace.exported"
  | "admin.user_disabled"
  | "admin.user_enabled"
  | "admin.user_erased"
  | "admin.tokens_revoked"
  | "admin.branding"
  | "admin.audit_exported";

/** what the activity feed shows */
export const FEED_TYPES: EventType[] = [
  "scene.created",
  "scene.renamed",
  "scene.moved",
  "scene.edited",
  "scene.deleted",
  "scene.restored",
  "scene.version_restored",
  "share.scene_grants",
  "share.read_link_created",
  "collection.created",
  "collection.renamed",
  "collection.grants",
  "comment.created",
  "comment.replied",
  "comment.resolved",
];

export interface EventInput {
  type: EventType;
  actor?: Pick<User, "id" | "name"> | null;
  request?: FastifyRequest;
  workspaceId?: string | null;
  collectionId?: string | null;
  sceneId?: string | null;
  /** another subject: a user, a token, a group */
  target?: string | null;
  data?: Record<string, unknown>;
}

/** edits by one person on one scene within this time are one event */
const EDIT_WINDOW = "30 minutes";

export const createEventLog = (
  db: Kysely<Database>,
  log: FastifyBaseLogger,
  /** counts events for the metrics */
  onEvent: (type: EventType) => void = () => {},
) => {
  const values = (event: EventInput) => ({
    type: event.type,
    actor_id: event.actor?.id ?? null,
    actor_name: event.actor?.name ?? null,
    workspace_id: event.workspaceId ?? null,
    collection_id: event.collectionId ?? null,
    scene_id: event.sceneId ?? null,
    target: event.target ?? null,
    data: event.data ?? {},
    ip: event.request?.ip ?? null,
    user_agent: event.request?.headers["user-agent"]?.slice(0, 200) ?? null,
  });

  /** write an event; failures are logged, never thrown at the caller */
  const record = (event: EventInput) => {
    onEvent(event.type);
    void db
      .insertInto("events")
      .values(values(event))
      .execute()
      .catch((error) => log.error({ err: error, event }, "event not recorded"));
  };

  /** "scene.edited", once per person and scene within EDIT_WINDOW */
  const recordEdit = (event: Omit<EventInput, "type">) => {
    const actorId = event.actor?.id;
    if (!actorId || !event.sceneId) {
      return;
    }
    onEvent("scene.edited");
    void (async () => {
      const updated = await db
        .updateTable("events")
        .set({
          at: sql`now()`,
          data: sql`jsonb_set(data, '{count}', to_jsonb(coalesce((data->>'count')::int, 1) + 1))`,
        })
        .where(
          "id",
          "=",
          db
            .selectFrom("events")
            .select("id")
            .where("type", "=", "scene.edited")
            .where("scene_id", "=", event.sceneId!)
            .where("actor_id", "=", actorId)
            .where(
              "at",
              ">",
              sql<Date>`now() - ${sql.lit(EDIT_WINDOW)}::interval`,
            )
            .orderBy("at", "desc")
            .limit(1),
        )
        .returning("id")
        .executeTakeFirst();
      if (!updated) {
        await db
          .insertInto("events")
          .values(
            values({
              ...event,
              type: "scene.edited",
              data: { count: 1, ...event.data },
            }),
          )
          .execute();
      }
    })().catch((error) => log.error({ err: error }, "edit event not recorded"));
  };

  return { record, recordEdit };
};

export type EventLog = ReturnType<typeof createEventLog>;
