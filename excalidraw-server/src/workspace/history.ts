/**
 * Routes of the app (session cookie) for what happened to scenes:
 * - trash (W5): restore, delete for good
 * - version history (W7): list, read, restore
 * - activity feed (W8)
 */
import { sql } from "kysely";

import { replaceAll } from "../../vendor/elements.mjs";
import { FEED_TYPES } from "../events.js";
import { openSceneKey } from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { queryParam } from "../util/validate.js";

import {
  actorOf,
  atLeast,
  collectionRole,
  grantMatches,
  SCENE_META_COLUMNS,
  accessibleCollections,
} from "./access.js";
import { decryptElements } from "./content.js";
import { notFound, SCENE_ID_RE } from "./service.js";
import { resolveWorkspace } from "./workspaces.js";

import type { AppContext } from "../context.js";
import type { Actor, SceneAccess } from "./access.js";
import type { WorkspaceService } from "./service.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerHistoryRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  workspace: WorkspaceService,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config } = ctx;
  const options = { preHandler: requireAuth };
  const actor = (request: FastifyRequest): Actor => actorOf(request.auth!.user);

  const names = async (ids: (string | null)[]) => {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) {
      return new Map<string, string>();
    }
    const rows = await db
      .selectFrom("users")
      .select(["id", "name"])
      .where("id", "in", unique)
      .execute();
    return new Map(rows.map((row) => [row.id, row.name]));
  };

  // --- trash --------------------------------------------------------------------

  /** a deleted scene the actor may restore or delete for good */
  const trashed = async (current: Actor, sceneId: string) => {
    if (!SCENE_ID_RE.test(sceneId)) {
      throw notFound();
    }
    const scene = await db
      .selectFrom("scenes")
      .select(SCENE_META_COLUMNS)
      .where("id", "=", sceneId)
      .where("deleted_at", "is not", null)
      .executeTakeFirst();
    if (!scene) {
      throw notFound();
    }
    const collection = await db
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", scene.collection_id)
      .executeTakeFirstOrThrow();
    // a deleted collection still decides who may restore
    const role = await collectionRole(db, current, {
      ...collection,
      deleted_at: null,
    });
    if (!atLeast(role, "editor") && scene.deleted_by !== current.id) {
      throw notFound();
    }
    return { scene, collection };
  };

  app.post<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/restore",
    options,
    async (request) => {
      const current = actor(request);
      const { scene, collection } = await trashed(
        current,
        request.params.sceneId,
      );
      // its collection is gone, or belonged to a removed person: back into
      // the restorer's "Meine Szenen"
      let collectionId = collection.id;
      const ownerGone =
        collection.kind === "personal" &&
        collection.owner_id !== current.id &&
        !!(await db
          .selectFrom("users")
          .select("id")
          .where("id", "=", collection.owner_id!)
          .where("erased_at", "is not", null)
          .executeTakeFirst());
      if (collection.deleted_at || ownerGone) {
        collectionId = (
          await workspace.ensurePersonalCollection(
            current.id,
            scene.workspace_id,
          )
        ).id;
      }
      await db
        .updateTable("scenes")
        .set({
          deleted_at: null,
          deleted_by: null,
          collection_id: collectionId,
          updated_at: sql`now()`,
        })
        .where("id", "=", scene.id)
        .execute();
      ctx.events.record({
        type: "scene.restored",
        actor: request.auth!.user,
        request,
        workspaceId: scene.workspace_id,
        collectionId,
        sceneId: scene.id,
        data: { name: scene.name },
      });
      return {
        scene: await workspace.describeAccess(
          await workspace.sceneFor(current, scene.id, "viewer"),
        ),
      };
    },
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/purge",
    options,
    async (request, reply) => {
      const { scene } = await trashed(actor(request), request.params.sceneId);
      // restored meanwhile: nothing is deleted
      if (!(await ctx.lifecycle.purgeScene(scene.id, request.auth!.user))) {
        throw notFound();
      }
      return reply.code(204).send();
    },
  );

  // --- version history ------------------------------------------------------------

  /**
   * Earlier states only for people with access through a collection or a
   * grant: a read-only link shows the scene as it is now, not what was
   * removed before it was shared.
   */
  const historyAccess = (access: SceneAccess) => {
    if (access.viaLinkOnly) {
      throw new HttpError(
        403,
        "forbidden",
        "Frühere Versionen sehen nur Personen, die über eine Collection oder eine Freigabe Zugriff haben.",
      );
    }
    return access;
  };

  app.get<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/versions",
    options,
    async (request, reply) => {
      const access = historyAccess(
        await workspace.sceneFor(
          actor(request),
          request.params.sceneId,
          "viewer",
        ),
      );
      const versions = await db
        .selectFrom("scene_versions")
        .select([
          "id",
          "created_at",
          "created_by",
          "size",
          "reason",
          "revision",
        ])
        .where("scene_id", "=", access.scene.id)
        .orderBy("created_at", "desc")
        .limit(200)
        .execute();
      const people = await names([
        access.scene.updated_by,
        ...versions.map((version) => version.created_by),
      ]);
      reply.header("cache-control", "no-store");
      return {
        current: {
          savedAt: access.scene.updated_at,
          savedBy: access.scene.updated_by
            ? people.get(access.scene.updated_by) || null
            : null,
          revision: Number(access.scene.revision),
        },
        versions: versions.map((version) => ({
          id: version.id,
          savedAt: version.created_at,
          savedBy: version.created_by
            ? people.get(version.created_by) || null
            : null,
          size: version.size,
          reason: version.reason,
        })),
        canRestore: access.role === "editor",
      };
    },
  );

  const versionOf = async (sceneId: string, versionId: string) => {
    if (!UUID_RE.test(versionId)) {
      throw notFound("Version");
    }
    const version = await db
      .selectFrom("scene_versions")
      .selectAll()
      .where("id", "=", versionId)
      .where("scene_id", "=", sceneId)
      .executeTakeFirst();
    if (!version) {
      throw notFound("Version");
    }
    return version;
  };

  /** a version, encrypted with the scene key like the scene's content */
  app.get<{ Params: { sceneId: string; versionId: string } }>(
    "/api/scenes/:sceneId/versions/:versionId",
    options,
    async (request, reply) => {
      const access = historyAccess(
        await workspace.sceneFor(
          actor(request),
          request.params.sceneId,
          "viewer",
        ),
      );
      const version = await versionOf(
        access.scene.id,
        request.params.versionId,
      );
      reply.header("cache-control", "no-store");
      return {
        id: version.id,
        savedAt: version.created_at,
        iv: version.iv.toString("base64"),
        ciphertext: version.ciphertext.toString("base64"),
      };
    },
  );

  app.post<{ Params: { sceneId: string; versionId: string } }>(
    "/api/scenes/:sceneId/versions/:versionId/restore",
    options,
    async (request) => {
      const current = actor(request);
      const access = await workspace.sceneFor(
        current,
        request.params.sceneId,
        "editor",
      );
      const version = await versionOf(
        access.scene.id,
        request.params.versionId,
      );
      const key = openSceneKey(
        config.dataEncryptionKey,
        access.scene.key_sealed,
      );
      let elements;
      try {
        elements = decryptElements(key, version.iv, version.ciphertext);
      } catch {
        throw new HttpError(
          422,
          "unreadable_version",
          "Diese Version lässt sich nicht lesen.",
        );
      }
      // the state that the restore replaces stays in the history
      await ctx.lifecycle.keepVersion(access.scene.id, {
        force: true,
        reason: "restore",
      });
      const result = await workspace.changeContent(
        current,
        access.scene.id,
        (now) => replaceAll(now, elements),
      );
      ctx.events.record({
        type: "scene.version_restored",
        actor: request.auth!.user,
        request,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name, versionAt: version.created_at },
      });
      return { revision: result.revision };
    },
  );

  // --- activity feed ----------------------------------------------------------------

  app.get("/api/activity", options, async (request, reply) => {
    const current = actor(request);
    const query = request.query as Record<string, unknown>;
    const { workspace: space } = await resolveWorkspace(
      db,
      current,
      queryParam(query.workspace),
    );
    const before = queryParam(query.before);
    if (before !== undefined && !/^\d{1,18}$/.test(before)) {
      throw new HttpError(
        400,
        "invalid_before",
        "before ist eine Ereignis-id.",
      );
    }
    const collectionIds = (
      await accessibleCollections(db, current, space.id)
    ).map((item) => item.collection.id);
    // scenes the actor can see now (deleted ones of visible collections too)
    const visibleScenes = db
      .selectFrom("scenes")
      .select("scenes.id")
      .where("scenes.workspace_id", "=", space.id)
      .where((eb) =>
        eb.or([
          ...(collectionIds.length
            ? [eb("scenes.collection_id", "in", collectionIds)]
            : []),
          eb.exists(
            eb
              .selectFrom("scene_grants")
              .select(sql`1`.as("one"))
              .whereRef("scene_grants.scene_id", "=", "scenes.id")
              .where(grantMatches(current)),
          ),
        ]),
      );
    let events = db
      .selectFrom("events")
      .selectAll()
      .where("workspace_id", "=", space.id)
      .where("type", "in", FEED_TYPES)
      .where((eb) =>
        eb.or([
          eb("scene_id", "in", visibleScenes),
          ...(collectionIds.length
            ? [
                eb.and([
                  eb("scene_id", "is", null),
                  eb("collection_id", "in", collectionIds),
                ]),
              ]
            : []),
        ]),
      );
    if (before) {
      events = events.where("id", "<", before);
    }
    const rows = await events.orderBy("id", "desc").limit(50).execute();
    const sceneIds = [
      ...new Set(rows.map((row) => row.scene_id).filter(Boolean)),
    ] as string[];
    const scenes = sceneIds.length
      ? await db
          .selectFrom("scenes")
          .select(["id", "name", "deleted_at"])
          .where("id", "in", sceneIds)
          .execute()
      : [];
    const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
    reply.header("cache-control", "no-store");
    return {
      events: rows.map((row) => {
        const scene = row.scene_id ? sceneById.get(row.scene_id) : undefined;
        const data = row.data as Record<string, unknown>;
        return {
          id: row.id,
          at: row.at,
          type: row.type,
          actor: row.actor_id
            ? { id: row.actor_id, name: row.actor_name }
            : null,
          scene: row.scene_id
            ? {
                id: row.scene_id,
                name: scene?.name ?? data.name ?? null,
                available: !!scene && !scene.deleted_at,
              }
            : null,
          collectionId: row.collection_id,
          // not "from": the collection a scene came from may be one the
          // reader has no access to
          details: {
            name: data.name,
            before: data.before,
            count: data.count,
            via: data.via,
          },
        };
      }),
      next: rows.length === 50 ? rows[rows.length - 1].id : null,
    };
  });
};
