/**
 * Life of a scene after the editor: version history (W7), trash and final
 * deletion (W5), and the deletion periods of the data protection concept
 * (S3) that background jobs enforce.
 */
import { sql } from "kysely";

import { policiesOf } from "./workspaces.js";

import type { AppContext } from "../context.js";
import type { User } from "../db/schema.js";

type Person = Pick<User, "id" | "name"> | null;

export const createLifecycle = (ctx: AppContext) => {
  const { db, blobs, config } = ctx;

  /**
   * Before new content replaces the old one: keep the old one as a version,
   * at most one per VERSION_INTERVAL_MINUTES (copied inside the database,
   * the content stays encrypted). force: always (before restoring one).
   */
  const keepVersion = async (
    sceneId: string,
    options: { force?: boolean; reason?: "auto" | "restore" | "import" } = {},
  ) => {
    const minutes = config.retention.versionIntervalMinutes;
    await sql`
      insert into scene_versions
        (scene_id, created_at, created_by, revision, scene_version, iv, ciphertext, size, reason)
      select s.id, s.updated_at, s.updated_by, s.revision, s.scene_version,
             s.iv, s.ciphertext, length(s.ciphertext), ${
               options.reason || "auto"
             }
      from scenes s
      where s.id = ${sceneId}
        and s.revision > 0
        and s.ciphertext is not null
        and not exists (
          select 1 from scene_versions v
          where v.scene_id = s.id
            and (v.revision = s.revision
                 or (${!options.force} and v.taken_at > now() - make_interval(mins => ${minutes})))
        )
      on conflict (scene_id, revision) do nothing
    `.execute(db);
  };

  /**
   * Delete a scene for good: content, key, versions, comments, images.
   * Only while it is in the trash (dueBefore: deleted before that time), so
   * a restore just before cannot lose it. The row goes first: images left
   * over after a storage error are unreadable without the scene's key.
   */
  const purgeScene = async (
    sceneId: string,
    actor: Person = null,
    dueBefore?: Date,
  ) => {
    let query = db
      .deleteFrom("scenes")
      .where("id", "=", sceneId)
      .where("deleted_at", "is not", null);
    if (dueBefore) {
      query = query.where("deleted_at", "<", dueBefore);
    }
    // grants, comments, versions, search index, visits go along (cascade)
    const scene = await query
      .returning(["id", "name", "workspace_id", "collection_id"])
      .executeTakeFirst();
    if (!scene) {
      return false;
    }
    for (const prefix of [
      `files/scenes/${scene.id}/`,
      // scene ids all have the same length: the prefix is the exact key
      `thumbnails/scenes/${scene.id}`,
    ]) {
      await blobs
        .deletePrefix(prefix)
        .catch((error) =>
          ctx.log.warn(
            { err: error, sceneId: scene.id, prefix },
            "images of a purged scene not deleted",
          ),
        );
    }
    ctx.events.record({
      type: "scene.purged",
      actor,
      sceneId: scene.id,
      workspaceId: scene.workspace_id,
      collectionId: scene.collection_id,
      data: { name: scene.name, automatic: !actor },
    });
    return true;
  };

  // --- jobs -------------------------------------------------------------------

  /** scenes longer in the trash than their workspace keeps them */
  const purgeTrash = async () => {
    const workspaces = await db
      .selectFrom("workspaces")
      .select(["id", "settings"])
      .execute();
    let purged = 0;
    for (const workspace of workspaces) {
      const days = policiesOf(workspace, {
        trashRetentionDays: config.retention.trashDays,
      }).trashRetentionDays;
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
      const due = await db
        .selectFrom("scenes")
        .select("id")
        .where("workspace_id", "=", workspace.id)
        .where("deleted_at", "is not", null)
        .where("deleted_at", "<", cutoff)
        .limit(500)
        .execute();
      for (const { id } of due) {
        try {
          purged += (await purgeScene(id, null, cutoff)) ? 1 : 0;
        } catch (error) {
          ctx.log.warn({ err: error, sceneId: id }, "scene not purged");
        }
      }
    }
    return purged;
  };

  /**
   * Versions, by when they were taken: all of the last 2 days, then the
   * last one of each day, none after VERSION_RETENTION_DAYS, at most 200
   * per scene.
   */
  const thinVersions = async () => {
    const days = config.retention.versionDays;
    await sql`delete from scene_versions where taken_at < now() - make_interval(days => ${days})`.execute(
      db,
    );
    await sql`
      delete from scene_versions v
      where v.taken_at < now() - interval '2 days'
        and exists (
          select 1 from scene_versions w
          where w.scene_id = v.scene_id
            and date_trunc('day', w.taken_at) = date_trunc('day', v.taken_at)
            and w.taken_at > v.taken_at
        )
    `.execute(db);
    await sql`
      delete from scene_versions where id in (
        select id from (
          select id, row_number() over (partition by scene_id order by taken_at desc) as n
          from scene_versions
        ) ranked where n > 200
      )
    `.execute(db);
  };

  /** the audit log and other traces of use */
  const purgeTraces = async () => {
    const { auditDays, visitDays, trashDays } = config.retention;
    await sql`delete from events where at < now() - make_interval(days => ${auditDays})`.execute(
      db,
    );
    await sql`delete from scene_visits where visited_at < now() - make_interval(days => ${visitDays})`.execute(
      db,
    );
    // deleted comments and threads: kept as long as the trash keeps scenes
    await sql`delete from comment_threads where deleted_at < now() - make_interval(days => ${trashDays})`.execute(
      db,
    );
    await sql`delete from comments where deleted_at < now() - make_interval(days => ${trashDays})`.execute(
      db,
    );
    await sql`delete from api_tokens where (revoked_at is not null or expires_at < now()) and coalesce(revoked_at, expires_at) < now() - interval '90 days'`.execute(
      db,
    );
  };

  return { keepVersion, purgeScene, purgeTrash, thinVersions, purgeTraces };
};

export type Lifecycle = ReturnType<typeof createLifecycle>;
