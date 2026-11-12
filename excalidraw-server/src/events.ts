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
  | "collection.moved"
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
  | "admin.audit_exported"
  | "admin.ai_settings"
  | "admin.embed_settings"
  | "admin.font_added"
  | "admin.font_removed"
  | "share.embed_created"
  | "share.embed_deleted"
  | "library.changed"
  | "library_catalog.published"
  | "library_catalog.updated"
  | "library_catalog.removed";

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
  "collection.moved",
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
/** ... but one entry covers at most this long */
const EDIT_SPAN = "3 hours";

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
      .catch((error) =>
        // never the request itself: it carries cookies and tokens
        log.error(
          {
            err: error,
            type: event.type,
            actorId: event.actor?.id,
            sceneId: event.sceneId,
          },
          "event not recorded",
        ),
      );
  };

  /**
   * "scene.edited": saves of one person on one scene are one entry while
   * they follow each other within EDIT_WINDOW (for at most EDIT_SPAN). The
   * entry moves to the top with each save (deleted and written anew), so
   * the feed, which pages by id, stays in order.
   */
  const recordEdit = (event: Omit<EventInput, "type">) => {
    const actorId = event.actor?.id;
    if (!actorId || !event.sceneId) {
      return;
    }
    onEvent("scene.edited");
    const row = values({ ...event, type: "scene.edited" });
    void sql`
      with previous as (
        delete from events where id = (
          select id from events
          where type = 'scene.edited'
            and scene_id = ${event.sceneId}
            and actor_id = ${actorId}
            and at > now() - ${sql.lit(EDIT_WINDOW)}::interval
            and coalesce((data->>'first')::timestamptz, at)
                > now() - ${sql.lit(EDIT_SPAN)}::interval
          order by id desc
          limit 1
        )
        returning data
      )
      insert into events
        (type, actor_id, actor_name, workspace_id, collection_id, scene_id,
         target, data, ip, user_agent)
      values (
        'scene.edited', ${row.actor_id}, ${row.actor_name}, ${row.workspace_id},
        ${row.collection_id}, ${row.scene_id}, ${row.target},
        ${JSON.stringify(row.data)}::jsonb || jsonb_build_object(
          'count', coalesce((select (data->>'count')::int from previous), 0) + 1,
          'first', coalesce((select data->'first' from previous), to_jsonb(now()))
        ),
        ${row.ip}, ${row.user_agent}
      )
    `
      .execute(db)
      .catch((error) => log.error({ err: error }, "edit event not recorded"));
  };

  return { record, recordEdit };
};

export type EventLog = ReturnType<typeof createEventLog>;
