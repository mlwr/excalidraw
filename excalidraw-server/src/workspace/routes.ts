import { sql } from "kysely";

import {
  decryptWithSceneKey,
  encryptWithSceneKey,
  generateSceneKey,
  openSceneKey,
  randomToken,
  sealSceneKey,
} from "../util/crypto.js";
import { sendError } from "../util/http.js";
import {
  containsPattern,
  hasControlChars,
  isCounter,
  queryParam,
  searchText,
  singleLine,
} from "../util/validate.js";

import {
  accessibleCollections,
  actorOf,
  atLeast,
  collectionRole,
  grantMatches,
  SCENE_META_COLUMNS,
  sceneAccess,
} from "./access.js";
import {
  atLeastWorkspace,
  clearForbiddenSharing,
  isWorkspaceAdmin,
  listWorkspaces,
  policiesOf,
  resolveWorkspace,
} from "./workspaces.js";

import type { AppContext } from "../context.js";
import type {
  Collection,
  GrantRole,
  PrincipalType,
  Workspace,
} from "../db/schema.js";
import type { Actor, Role, SceneMeta } from "./access.js";
import type { WorkspaceAccess } from "./workspaces.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const SCENE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_THUMBNAIL_BYTES = 1024 * 1024;
const THUMBNAIL_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);
const PRESENCE_CACHE_MS = 3000;

interface GrantInput {
  type: PrincipalType;
  principal: string;
  role: GrantRole;
}

const cleanName = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const name = singleLine(value).replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
};

const isBase64 = (value: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(value);

const GRANT_RANK: Record<GrantRole, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

const parseGrants = (
  value: unknown,
  allowedRoles: GrantRole[],
): GrantInput[] | null => {
  if (!Array.isArray(value) || value.length > 200) {
    return null;
  }
  const grants = new Map<string, GrantInput>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const { type, principal: raw, role } = item as Record<string, unknown>;
    if (
      (type !== "user" && type !== "group") ||
      typeof raw !== "string" ||
      !allowedRoles.includes(role as GrantRole)
    ) {
      return null;
    }
    // grants are matched as text: user ids in their canonical lower case
    const principal = type === "user" ? raw.trim().toLowerCase() : raw.trim();
    if (
      !principal ||
      principal.length > 500 ||
      hasControlChars(principal) ||
      (type === "user" && !UUID_RE.test(principal))
    ) {
      return null;
    }
    // the same person or group twice: the higher role wins
    const key = `${type}:${principal}`;
    const existing = grants.get(key);
    if (
      !existing ||
      GRANT_RANK[role as GrantRole] > GRANT_RANK[existing.role]
    ) {
      grants.set(key, { type, principal, role: role as GrantRole });
    }
  }
  return [...grants.values()];
};

export const registerWorkspaceRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, blobs, config } = ctx;
  const masterKey = config.dataEncryptionKey;

  const actor = (request: FastifyRequest): Actor => actorOf(request.auth!.user);

  /** "Meine Szenen": one per person and workspace */
  const ensurePersonalCollection = async (
    userId: string,
    workspaceId: string,
  ) => {
    await db
      .insertInto("collections")
      .values({
        workspace_id: workspaceId,
        name: "Meine Szenen",
        kind: "personal",
        owner_id: userId,
        created_by: userId,
      })
      .onConflict((oc) =>
        oc
          .columns(["workspace_id", "owner_id"])
          .where("kind", "=", "personal")
          .doNothing(),
      )
      .execute();
    return db
      .selectFrom("collections")
      .selectAll()
      .where("kind", "=", "personal")
      .where("owner_id", "=", userId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
  };

  /** the workspace a request is about (?workspace=…), default otherwise */
  const workspaceOf = (
    request: FastifyRequest,
    minimum: WorkspaceAccess = "guest",
    value: unknown = (request.query as Record<string, unknown>)?.workspace,
  ) =>
    resolveWorkspace(
      db,
      actor(request),
      typeof value === "string" || value === undefined
        ? value
        : queryParam(value),
      minimum,
    );

  const policies = (workspace: Pick<Workspace, "settings">) =>
    policiesOf(workspace, { trashRetentionDays: config.retention.trashDays });

  const workspaceById = (id: string) =>
    db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  // --- presence: who is in which scene right now ------------------------------

  let presenceCache: {
    at: number;
    value: Map<string, { id: string; name: string }[]>;
  } | null = null;
  const presence = async () => {
    if (!presenceCache || Date.now() - presenceCache.at > PRESENCE_CACHE_MS) {
      presenceCache = {
        at: Date.now(),
        value: await ctx.realtime.scenePresence(),
      };
    }
    return presenceCache.value;
  };

  // --- serialization ------------------------------------------------------------

  const userNames = async (ids: (string | null)[]) => {
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

  const sceneSummaries = async (
    scenes: SceneMeta[],
    collections: Map<string, Collection>,
    options: {
      withPresence?: boolean;
      /** the current user's rights per scene id */
      access?: Map<string, { role: Role; canManage: boolean }>;
    } = {},
  ) => {
    const names = await userNames(
      scenes.flatMap((scene) => [scene.created_by, scene.updated_by]),
    );
    const active = options.withPresence
      ? await presence()
      : new Map<string, { id: string; name: string }[]>();
    return scenes.map((scene) => {
      const collection = collections.get(scene.collection_id);
      return {
        id: scene.id,
        name: scene.name,
        collection: collection
          ? { id: collection.id, name: collection.name, kind: collection.kind }
          : null,
        createdAt: scene.created_at,
        updatedAt: scene.updated_at,
        createdBy: scene.created_by
          ? names.get(scene.created_by) || null
          : null,
        updatedBy: scene.updated_by
          ? names.get(scene.updated_by) || null
          : null,
        thumbnailUrl: scene.thumbnail_updated_at
          ? `/api/scenes/${scene.id}/thumbnail?v=${new Date(
              scene.thumbnail_updated_at,
            ).getTime()}`
          : null,
        hasReadLink: !!scene.read_link_token,
        activeUsers: active.get(scene.id) || [],
        ...(options.access?.get(scene.id) || {}),
      };
    });
  };

  const collectionsById = async (ids: string[]) => {
    const unique = [...new Set(ids)];
    if (!unique.length) {
      return new Map<string, Collection>();
    }
    const rows = await db
      .selectFrom("collections")
      .selectAll()
      .where("id", "in", unique)
      .execute();
    return new Map(rows.map((row) => [row.id, row]));
  };

  /** resolve scene access or answer 404 (never reveal unknown scenes) */
  const loadScene = async (
    request: FastifyRequest<{ Params: { sceneId: string } }>,
    reply: FastifyReply,
    minimum: Role,
  ) => {
    const { sceneId } = request.params;
    if (!SCENE_ID_RE.test(sceneId)) {
      sendError(reply, 404, "not_found");
      return null;
    }
    const access = await sceneAccess(db, actor(request), sceneId);
    if (!access || access.role === "none") {
      sendError(reply, 404, "not_found");
      return null;
    }
    if (!atLeast(access.role, minimum)) {
      sendError(reply, 403, "forbidden", "Dafür fehlen dir die Rechte.");
      return null;
    }
    return access;
  };

  const loadCollection = async (
    current: Actor,
    collectionId: string,
    reply: FastifyReply,
    minimum: Role,
  ) => {
    if (!UUID_RE.test(collectionId)) {
      sendError(reply, 404, "not_found");
      return null;
    }
    const collection = await db
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", collectionId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!collection) {
      sendError(reply, 404, "not_found");
      return null;
    }
    const role = await collectionRole(db, current, collection);
    if (role === "none") {
      sendError(reply, 404, "not_found");
      return null;
    }
    if (!atLeast(role, minimum)) {
      sendError(reply, 403, "forbidden", "Dafür fehlen dir die Rechte.");
      return null;
    }
    return { collection, role };
  };

  const grantsWithNames = async (
    rows: { principal_type: string; principal: string; role: string }[],
  ) => {
    const names = await userNames(
      rows
        .filter((row) => row.principal_type === "user")
        .map((row) => row.principal),
    );
    return rows.map((row) => ({
      type: row.principal_type as PrincipalType,
      principal: row.principal,
      role: row.role as GrantRole,
      label:
        row.principal_type === "user"
          ? names.get(row.principal) || "Unbekannte Person"
          : row.principal,
    }));
  };

  const validateUserGrants = async (grants: GrantInput[]) => {
    const userIds = grants
      .filter((grant) => grant.type === "user")
      .map((grant) => grant.principal);
    if (!userIds.length) {
      return true;
    }
    const found = await db
      .selectFrom("users")
      .select("id")
      .where("id", "in", userIds)
      .execute();
    return found.length === new Set(userIds).size;
  };

  /** some active user is a manager: directly or through a group */
  const hasActiveManager = async (grants: GrantInput[]) => {
    const managers = grants.filter((grant) => grant.role === "manager");
    const userIds = managers
      .filter((grant) => grant.type === "user")
      .map((grant) => grant.principal);
    const groups = managers
      .filter((grant) => grant.type === "group")
      .map((grant) => grant.principal);
    if (!userIds.length && !groups.length) {
      return false;
    }
    const found = await db
      .selectFrom("users")
      .select("id")
      .where("disabled_at", "is", null)
      .where((eb) =>
        eb.or([
          ...(userIds.length ? [eb("id", "in", userIds)] : []),
          ...(groups.length ? [sql<boolean>`groups && ${groups}::text[]`] : []),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return !!found;
  };

  /** live connections to these scenes re-check their rights */
  const recheckLiveAccess = (sceneIds: string[]) => {
    if (sceneIds.length) {
      ctx.realtime.recheckScenes(sceneIds).catch((error) => {
        app.log.warn({ err: error }, "re-checking live access failed");
      });
    }
  };

  // ---------------------------------------------------------------------------
  // workspace overview
  // ---------------------------------------------------------------------------

  app.get("/api/workspace", { preHandler: requireAuth }, async (request) => {
    const { workspace, access } = await workspaceOf(request);
    if (atLeastWorkspace(access, "member")) {
      await ensurePersonalCollection(request.auth!.user.id, workspace.id);
    }
    const collections = await accessibleCollections(
      db,
      actor(request),
      workspace.id,
    );
    const counts = collections.length
      ? await db
          .selectFrom("scenes")
          .select(["collection_id", sql<number>`count(*)::int`.as("count")])
          .where(
            "collection_id",
            "in",
            collections.map((item) => item.collection.id),
          )
          .where("deleted_at", "is", null)
          .groupBy("collection_id")
          .execute()
      : [];
    const countMap = new Map(
      counts.map((row) => [row.collection_id, row.count]),
    );
    const workspaces = await listWorkspaces(db, actor(request));
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        access,
        policies: policies(workspace),
      },
      workspaces: workspaces.map((item) => ({
        id: item.workspace.id,
        slug: item.workspace.slug,
        name: item.workspace.name,
        access: item.access,
      })),
      collections: collections.map(({ collection, role }) => ({
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
        role,
        sceneCount: countMap.get(collection.id) || 0,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // collections
  // ---------------------------------------------------------------------------

  app.post(
    "/api/collections",
    { preHandler: requireAuth },
    async (request, reply) => {
      const name = cleanName((request.body as Record<string, unknown>)?.name);
      if (!name) {
        return sendError(
          reply,
          400,
          "invalid_name",
          "Bitte einen Namen angeben.",
        );
      }
      const userId = request.auth!.user.id;
      const { workspace, access } = await workspaceOf(
        request,
        "member",
        (request.body as Record<string, unknown>)?.workspaceId,
      );
      if (
        policies(workspace).collectionCreation === "admins" &&
        access !== "admin"
      ) {
        return sendError(
          reply,
          403,
          "forbidden",
          "In diesem Workspace legen nur Admins Collections an.",
        );
      }
      const collection = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("collections")
          .values({
            workspace_id: workspace.id,
            name,
            kind: "team",
            created_by: userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("collection_grants")
          .values({
            collection_id: created.id,
            principal_type: "user",
            principal: userId,
            role: "manager",
            created_by: userId,
          })
          .execute();
        return created;
      });
      ctx.events.record({
        type: "collection.created",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        collectionId: collection.id,
        data: { name },
      });
      return reply.code(201).send({
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
        role: "manager",
        sceneCount: 0,
      });
    },
  );

  app.patch<{ Params: { collectionId: string } }>(
    "/api/collections/:collectionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const loaded = await loadCollection(
        actor(request),
        request.params.collectionId,
        reply,
        "manager",
      );
      if (!loaded) {
        return;
      }
      if (loaded.collection.kind === "personal") {
        return sendError(reply, 400, "personal_collection");
      }
      const name = cleanName((request.body as Record<string, unknown>)?.name);
      if (!name) {
        return sendError(
          reply,
          400,
          "invalid_name",
          "Bitte einen Namen angeben.",
        );
      }
      await db
        .updateTable("collections")
        .set({ name, updated_at: sql`now()` })
        .where("id", "=", loaded.collection.id)
        .execute();
      ctx.events.record({
        type: "collection.renamed",
        actor: request.auth!.user,
        request,
        workspaceId: loaded.collection.workspace_id,
        collectionId: loaded.collection.id,
        data: { name, before: loaded.collection.name },
      });
      return { id: loaded.collection.id, name };
    },
  );

  app.delete<{ Params: { collectionId: string } }>(
    "/api/collections/:collectionId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const loaded = await loadCollection(
        actor(request),
        request.params.collectionId,
        reply,
        "manager",
      );
      if (!loaded) {
        return;
      }
      if (loaded.collection.kind === "personal") {
        return sendError(reply, 400, "personal_collection");
      }
      const remaining = await db
        .selectFrom("scenes")
        .select(sql<number>`count(*)::int`.as("count"))
        .where("collection_id", "=", loaded.collection.id)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      if (remaining.count > 0) {
        return sendError(
          reply,
          409,
          "collection_not_empty",
          "Die Collection enthält noch Szenen.",
        );
      }
      await db
        .updateTable("collections")
        .set({ deleted_at: sql`now()` })
        .where("id", "=", loaded.collection.id)
        .execute();
      ctx.events.record({
        type: "collection.deleted",
        actor: request.auth!.user,
        request,
        workspaceId: loaded.collection.workspace_id,
        collectionId: loaded.collection.id,
        data: { name: loaded.collection.name },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { collectionId: string } }>(
    "/api/collections/:collectionId/grants",
    { preHandler: requireAuth },
    async (request, reply) => {
      const loaded = await loadCollection(
        actor(request),
        request.params.collectionId,
        reply,
        "viewer",
      );
      if (!loaded) {
        return;
      }
      const rows = await db
        .selectFrom("collection_grants")
        .select(["principal_type", "principal", "role"])
        .where("collection_id", "=", loaded.collection.id)
        .orderBy("principal_type")
        .execute();
      return {
        grants: await grantsWithNames(rows),
        canManage: loaded.role === "manager",
      };
    },
  );

  app.put<{ Params: { collectionId: string } }>(
    "/api/collections/:collectionId/grants",
    { preHandler: requireAuth },
    async (request, reply) => {
      const loaded = await loadCollection(
        actor(request),
        request.params.collectionId,
        reply,
        "manager",
      );
      if (!loaded) {
        return;
      }
      if (loaded.collection.kind === "personal") {
        return sendError(
          reply,
          400,
          "personal_collection",
          "Einzelne Szenen aus „Meine Szenen“ lassen sich direkt teilen.",
        );
      }
      const grants = parseGrants(
        (request.body as Record<string, unknown>)?.grants,
        ["viewer", "editor", "manager"],
      );
      if (!grants || !(await validateUserGrants(grants))) {
        return sendError(reply, 400, "invalid_grants");
      }
      if (!(await hasActiveManager(grants))) {
        return sendError(
          reply,
          400,
          "manager_required",
          "Mindestens eine Person oder eine Gruppe mit Mitgliedern muss die Collection verwalten.",
        );
      }
      const userId = request.auth!.user.id;
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("collection_grants")
          .where("collection_id", "=", loaded.collection.id)
          .execute();
        await trx
          .insertInto("collection_grants")
          .values(
            grants.map((grant) => ({
              collection_id: loaded.collection.id,
              principal_type: grant.type,
              principal: grant.principal,
              role: grant.role,
              created_by: userId,
            })),
          )
          .execute();
      });
      const scenes = await db
        .selectFrom("scenes")
        .select("id")
        .where("collection_id", "=", loaded.collection.id)
        .where("deleted_at", "is", null)
        .execute();
      recheckLiveAccess(scenes.map((scene) => scene.id));
      ctx.events.record({
        type: "collection.grants",
        actor: request.auth!.user,
        request,
        workspaceId: loaded.collection.workspace_id,
        collectionId: loaded.collection.id,
        data: {
          name: loaded.collection.name,
          grants: grants.map(
            (grant) => `${grant.type}:${grant.principal}:${grant.role}`,
          ),
        },
      });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // scene lists
  // ---------------------------------------------------------------------------

  app.get(
    "/api/scenes",
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const current = actor(request);
      const search = searchText(query.q);
      const sortParam = queryParam(query.sort);
      const sort =
        sortParam === "name" || sortParam === "created" ? sortParam : "updated";
      // order in SQL before the limit, so large collections list the right ones
      const orderColumn =
        sort === "name"
          ? "name"
          : sort === "created"
          ? "created_at"
          : "updated_at";
      const orderDirection = sort === "name" ? "asc" : "desc";

      let scenes: SceneMeta[] = [];
      const access = new Map<string, { role: Role; canManage: boolean }>();
      const collectionId = queryParam(query.collection);
      const view = queryParam(query.view);
      const mode = collectionId
        ? "collection"
        : view === "shared" || view === "trash"
        ? view
        : "recent";
      const { workspace } = await workspaceOf(request);

      if (mode === "collection" && collectionId) {
        const loaded = await loadCollection(
          current,
          collectionId,
          reply,
          "viewer",
        );
        if (!loaded) {
          return;
        }
        let builder = db
          .selectFrom("scenes")
          .select(SCENE_META_COLUMNS)
          .where("collection_id", "=", loaded.collection.id)
          .where("deleted_at", "is", null);
        if (search) {
          builder = builder.where("name", "ilike", containsPattern(search));
        }
        scenes = await builder
          .orderBy(orderColumn, orderDirection)
          .limit(500)
          .execute();
        // rights follow the collection role
        for (const scene of scenes) {
          access.set(scene.id, {
            role: loaded.role === "manager" ? "editor" : loaded.role,
            canManage: atLeast(loaded.role, "editor"),
          });
        }
      } else if (mode === "shared") {
        // scenes shared with me directly (not through a collection)
        let builder = db
          .selectFrom("scenes")
          .select(SCENE_META_COLUMNS)
          .where("deleted_at", "is", null)
          .where("workspace_id", "=", workspace.id)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("scene_grants")
                .select(sql`1`.as("one"))
                .whereRef("scene_grants.scene_id", "=", "scenes.id")
                .where(grantMatches(current)),
            ),
          );
        if (search) {
          builder = builder.where("name", "ilike", containsPattern(search));
        }
        scenes = await builder
          .orderBy(orderColumn, orderDirection)
          .limit(500)
          .execute();
        for (const scene of scenes) {
          const result = await sceneAccess(db, current, scene.id);
          if (result) {
            access.set(scene.id, {
              role: result.role,
              canManage: result.canManage,
            });
          }
        }
      } else if (mode === "trash") {
        // deleted scenes I may restore: I manage their collection, or I
        // deleted them
        const adminHere = await isWorkspaceAdmin(db, current, workspace.id);
        // collections (deleted ones too) where I may edit: filtered in the
        // database, so the limit below counts only what I may see
        const editable = db
          .selectFrom("collections")
          .select("collections.id")
          .where("collections.workspace_id", "=", workspace.id)
          .where((eb) =>
            eb.or([
              eb.and([
                eb("collections.kind", "=", "personal"),
                eb("collections.owner_id", "=", current.id),
              ]),
              adminHere
                ? eb("collections.kind", "=", "team")
                : eb.and([
                    eb("collections.kind", "=", "team"),
                    eb.exists(
                      eb
                        .selectFrom("collection_grants")
                        .select(sql`1`.as("one"))
                        .whereRef(
                          "collection_grants.collection_id",
                          "=",
                          "collections.id",
                        )
                        .where("collection_grants.role", "in", [
                          "editor",
                          "manager",
                        ])
                        .where(grantMatches(current)),
                    ),
                  ]),
            ]),
          );
        let builder = db
          .selectFrom("scenes")
          .select(SCENE_META_COLUMNS)
          .where("workspace_id", "=", workspace.id)
          .where("deleted_at", "is not", null)
          .where((eb) =>
            eb.or([
              eb("deleted_by", "=", current.id),
              eb("collection_id", "in", editable),
            ]),
          );
        if (search) {
          builder = builder.where("name", "ilike", containsPattern(search));
        }
        const deleted = await builder
          .orderBy("deleted_at", "desc")
          .limit(500)
          .execute();
        const roles = new Map<string, Role>();
        for (const scene of deleted) {
          if (!roles.has(scene.collection_id)) {
            const collection = await db
              .selectFrom("collections")
              .selectAll()
              .where("id", "=", scene.collection_id)
              .executeTakeFirst();
            roles.set(
              scene.collection_id,
              collection
                ? await collectionRole(db, current, {
                    ...collection,
                    // a deleted collection still decides who may restore
                    deleted_at: null,
                  })
                : "none",
            );
          }
          const manages = atLeast(roles.get(scene.collection_id)!, "editor");
          if (manages || scene.deleted_by === current.id) {
            scenes.push(scene);
            access.set(scene.id, { role: "editor", canManage: manages });
          }
        }
      } else {
        // recently visited by me
        const visited = await db
          .selectFrom("scene_visits")
          .innerJoin("scenes", "scenes.id", "scene_visits.scene_id")
          .select(
            SCENE_META_COLUMNS.map((column) => `scenes.${column}` as const),
          )
          .where("scene_visits.user_id", "=", current.id)
          .where("scenes.workspace_id", "=", workspace.id)
          .where("scenes.deleted_at", "is", null)
          .orderBy("scene_visits.visited_at", "desc")
          .limit(30)
          .execute();
        const allowed: SceneMeta[] = [];
        for (const scene of visited) {
          const result = await sceneAccess(db, current, scene.id);
          if (result && result.role !== "none") {
            allowed.push(scene);
            access.set(scene.id, {
              role: result.role,
              canManage: result.canManage,
            });
          }
        }
        scenes = search
          ? allowed.filter((scene) =>
              scene.name.toLowerCase().includes(search.toLowerCase()),
            )
          : allowed;
      }

      if (mode !== "recent" && mode !== "trash") {
        scenes.sort((a, b) => {
          if (sort === "name") {
            return a.name.localeCompare(b.name, "de");
          }
          const field = sort === "created" ? "created_at" : "updated_at";
          return new Date(b[field]).getTime() - new Date(a[field]).getTime();
        });
      }

      const collections = await collectionsById(
        scenes.map((scene) => scene.collection_id),
      );
      const summaries = await sceneSummaries(scenes, collections, {
        withPresence: mode !== "trash",
        access,
      });
      if (mode === "trash") {
        const days = policies(workspace).trashRetentionDays;
        const names = await userNames(scenes.map((scene) => scene.deleted_by));
        return {
          scenes: summaries.map((summary, index) => {
            const deletedAt = new Date(scenes[index].deleted_at!);
            return {
              ...summary,
              deletedAt,
              deletedBy: scenes[index].deleted_by
                ? names.get(scenes[index].deleted_by!) || null
                : null,
              purgeAt: new Date(deletedAt.getTime() + days * 24 * 3600 * 1000),
            };
          }),
        };
      }
      return { scenes: summaries };
    },
  );

  // ---------------------------------------------------------------------------
  // scenes
  // ---------------------------------------------------------------------------

  app.post(
    "/api/scenes",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const name = cleanName(body.name) || "Unbenannte Szene";
      const userId = request.auth!.user.id;

      let collectionId =
        typeof body.collectionId === "string" ? body.collectionId : null;
      if (!collectionId) {
        // "Meine Szenen" of the workspace the dashboard shows
        const { workspace } = await workspaceOf(
          request,
          "member",
          body.workspaceId,
        );
        collectionId = (await ensurePersonalCollection(userId, workspace.id))
          .id;
      }
      const loaded = await loadCollection(
        actor(request),
        collectionId,
        reply,
        "editor",
      );
      if (!loaded) {
        return;
      }

      const key = generateSceneKey();
      const scene = await db
        .insertInto("scenes")
        .values({
          id: randomToken(12),
          workspace_id: loaded.collection.workspace_id,
          collection_id: loaded.collection.id,
          name,
          created_by: userId,
          updated_by: userId,
          key_sealed: sealSceneKey(masterKey, key),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // a new scene counts as visited, so it shows up under "recent"
      await db
        .insertInto("scene_visits")
        .values({ user_id: userId, scene_id: scene.id })
        .execute();

      ctx.events.record({
        type: "scene.created",
        actor: request.auth!.user,
        request,
        workspaceId: scene.workspace_id,
        collectionId: scene.collection_id,
        sceneId: scene.id,
        data: { name },
      });

      const [summary] = await sceneSummaries(
        [scene],
        new Map([[loaded.collection.id, loaded.collection]]),
      );
      return reply.code(201).send({ scene: summary, key });
    },
  );

  app.get<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      await db
        .insertInto("scene_visits")
        .values({ user_id: request.auth!.user.id, scene_id: access.scene.id })
        .onConflict((oc) =>
          oc
            .columns(["user_id", "scene_id"])
            .doUpdateSet({ visited_at: sql`now()` }),
        )
        .execute();
      const [summary] = await sceneSummaries(
        [access.scene],
        new Map([[access.collection.id, access.collection]]),
      );
      reply.header("cache-control", "no-store");
      return {
        scene: {
          ...summary,
          role: access.role,
          canManage: access.canManage,
        },
        key: openSceneKey(masterKey, access.scene.key_sealed),
      };
    },
  );

  app.patch<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;
      const access = await loadScene(request, reply, "editor");
      if (!access) {
        return;
      }
      const changes: {
        name?: string;
        collection_id?: string;
        workspace_id?: string;
      } = {};

      if (body.name !== undefined) {
        const name = cleanName(body.name);
        if (!name) {
          return sendError(
            reply,
            400,
            "invalid_name",
            "Bitte einen Namen angeben.",
          );
        }
        changes.name = name;
      }

      if (body.collectionId !== undefined) {
        if (!access.canManage) {
          return sendError(
            reply,
            403,
            "forbidden",
            "Dafür fehlen dir die Rechte.",
          );
        }
        const target = await loadCollection(
          actor(request),
          String(body.collectionId),
          reply,
          "editor",
        );
        if (!target) {
          return;
        }
        changes.collection_id = target.collection.id;
        changes.workspace_id = target.collection.workspace_id;
      }

      if (!Object.keys(changes).length) {
        return sendError(reply, 400, "nothing_to_change");
      }
      await db
        .updateTable("scenes")
        .set({ ...changes, updated_at: sql`now()` })
        .where("id", "=", access.scene.id)
        .execute();
      if (
        changes.workspace_id &&
        changes.workspace_id !== access.scene.workspace_id
      ) {
        // into another workspace: its policies apply from now on
        await clearForbiddenSharing(
          db,
          policies(await workspaceById(changes.workspace_id)),
          { sceneIds: [access.scene.id] },
        );
      }
      if (
        changes.collection_id &&
        changes.collection_id !== access.scene.collection_id
      ) {
        recheckLiveAccess([access.scene.id]);
        ctx.events.record({
          type: "scene.moved",
          actor: request.auth!.user,
          request,
          workspaceId: changes.workspace_id,
          collectionId: changes.collection_id,
          sceneId: access.scene.id,
          data: {
            name: changes.name || access.scene.name,
            from: access.collection.name,
            fromCollectionId: access.collection.id,
          },
        });
      }
      if (changes.name && changes.name !== access.scene.name) {
        ctx.events.record({
          type: "scene.renamed",
          actor: request.auth!.user,
          request,
          workspaceId: access.scene.workspace_id,
          collectionId: access.scene.collection_id,
          sceneId: access.scene.id,
          data: { name: changes.name, before: access.scene.name },
        });
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(
          reply,
          403,
          "forbidden",
          "Dafür fehlen dir die Rechte.",
        );
      }
      await db
        .updateTable("scenes")
        .set({ deleted_at: sql`now()`, deleted_by: request.auth!.user.id })
        .where("id", "=", access.scene.id)
        .execute();
      ctx.realtime.closeSceneRoom(access.scene.id);
      ctx.events.record({
        type: "scene.deleted",
        actor: request.auth!.user,
        request,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name },
      });
      return reply.code(204).send();
    },
  );

  // --- content (end-to-end encrypted with the scene key) ----------------------

  app.get<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/content",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      reply.header("cache-control", "no-store");
      const scene = await db
        .selectFrom("scenes")
        .select(["iv", "ciphertext", "revision", "scene_version"])
        .where("id", "=", access.scene.id)
        .executeTakeFirstOrThrow();
      if (Number(scene.revision) === 0 || !scene.iv || !scene.ciphertext) {
        return sendError(reply, 404, "no_content");
      }
      return {
        sceneVersion: Number(scene.scene_version),
        revision: Number(scene.revision),
        iv: scene.iv.toString("base64"),
        ciphertext: scene.ciphertext.toString("base64"),
      };
    },
  );

  app.put<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/content",
    { preHandler: requireAuth, bodyLimit: config.limits.maxSceneBytes },
    async (request, reply) => {
      const access = await loadScene(request, reply, "editor");
      if (!access) {
        return;
      }
      const body = request.body as Record<string, unknown> | undefined;
      const expected = body?.expectedRevision;
      if (
        !body ||
        typeof body.sceneVersion !== "number" ||
        // bigint columns: reject what Postgres can't take (500 otherwise)
        !isCounter(Math.trunc(body.sceneVersion)) ||
        typeof body.iv !== "string" ||
        typeof body.ciphertext !== "string" ||
        !isBase64(body.iv) ||
        !isBase64(body.ciphertext) ||
        !(expected === null || isCounter(expected))
      ) {
        return sendError(reply, 400, "invalid_body");
      }
      reply.header("cache-control", "no-store");
      // the content now replaced becomes a version (at most every few minutes)
      await ctx.lifecycle.keepVersion(access.scene.id);
      const updated = await db
        .updateTable("scenes")
        .set({
          scene_version: Math.trunc(body.sceneVersion),
          revision: sql`revision + 1`,
          iv: Buffer.from(body.iv, "base64"),
          ciphertext: Buffer.from(body.ciphertext, "base64"),
          updated_by: request.auth!.user.id,
          updated_at: sql`now()`,
        })
        .where("id", "=", access.scene.id)
        .where("revision", "=", String(expected === null ? 0 : expected))
        .returning("revision")
        .executeTakeFirst();
      if (!updated) {
        return sendError(reply, 409, "conflict", "scene was changed meanwhile");
      }
      ctx.events.recordEdit({
        actor: request.auth!.user,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name },
      });
      return { revision: Number(updated.revision) };
    },
  );

  // --- files of a scene (encrypted in the browser) ----------------------------

  app.put<{ Params: { sceneId: string; fileId: string } }>(
    "/api/scenes/:sceneId/files/:fileId",
    { preHandler: requireAuth, bodyLimit: config.limits.maxFileBytes },
    async (request, reply) => {
      if (!FILE_ID_RE.test(request.params.fileId)) {
        return sendError(reply, 400, "invalid_path");
      }
      const access = await loadScene(request, reply, "editor");
      if (!access) {
        return;
      }
      const data = request.body;
      if (!Buffer.isBuffer(data) || data.byteLength === 0) {
        return sendError(reply, 400, "empty_body");
      }
      const created = await blobs.putIfAbsent(
        `files/scenes/${access.scene.id}/${request.params.fileId}`,
        data,
        {
          contentType: "application/octet-stream",
          createdBy: request.auth!.user.id,
        },
      );
      return reply.code(created ? 201 : 200).send({ ok: true });
    },
  );

  app.get<{ Params: { sceneId: string; fileId: string } }>(
    "/api/scenes/:sceneId/files/:fileId",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!FILE_ID_RE.test(request.params.fileId)) {
        return sendError(reply, 400, "invalid_path");
      }
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      const blob = await blobs.get(
        `files/scenes/${access.scene.id}/${request.params.fileId}`,
      );
      if (!blob) {
        return sendError(reply, 404, "not_found");
      }
      return reply
        .header("cache-control", "private, max-age=31536000, immutable")
        .type("application/octet-stream")
        .send(blob.data);
    },
  );

  // --- thumbnails (encrypted at rest with the scene key) ----------------------

  for (const type of THUMBNAIL_TYPES) {
    if (!app.hasContentTypeParser(type)) {
      app.addContentTypeParser(type, { parseAs: "buffer" }, (_r, body, done) =>
        done(null, body),
      );
    }
  }

  app.put<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/thumbnail",
    { preHandler: requireAuth, bodyLimit: MAX_THUMBNAIL_BYTES },
    async (request, reply) => {
      const access = await loadScene(request, reply, "editor");
      if (!access) {
        return;
      }
      const contentType = String(request.headers["content-type"] || "");
      const data = request.body;
      if (
        !THUMBNAIL_TYPES.has(contentType) ||
        !Buffer.isBuffer(data) ||
        !data.length
      ) {
        return sendError(reply, 400, "invalid_thumbnail");
      }
      const key = openSceneKey(masterKey, access.scene.key_sealed);
      await blobs.put(
        `thumbnails/scenes/${access.scene.id}`,
        encryptWithSceneKey(key, data),
        { contentType, createdBy: request.auth!.user.id },
      );
      await db
        .updateTable("scenes")
        .set({ thumbnail_updated_at: sql`now()` })
        .where("id", "=", access.scene.id)
        .execute();
      return { ok: true };
    },
  );

  app.get<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/thumbnail",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      const blob = await blobs.get(`thumbnails/scenes/${access.scene.id}`);
      if (!blob) {
        return sendError(reply, 404, "not_found");
      }
      const key = openSceneKey(masterKey, access.scene.key_sealed);
      return (
        reply
          // URLs carry the thumbnail's timestamp, so they can be cached
          .header("cache-control", "private, max-age=86400")
          .type(blob.contentType || "image/png")
          .send(decryptWithSceneKey(key, blob.data))
      );
    },
  );

  // --- sharing: people and groups ---------------------------------------------

  app.get<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/grants",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      const rows = await db
        .selectFrom("scene_grants")
        .select(["principal_type", "principal", "role"])
        .where("scene_id", "=", access.scene.id)
        .orderBy("principal_type")
        .execute();
      const { readLinks, directSharing } = policies(
        await workspaceById(access.scene.workspace_id),
      );
      return {
        grants: await grantsWithNames(rows),
        canManage: access.canManage,
        collection: {
          id: access.collection.id,
          name: access.collection.name,
          kind: access.collection.kind,
        },
        // what the workspace allows (T5): the dialog hides the rest
        policies: { readLinks, directSharing },
        readLinkUrl:
          access.canManage && access.scene.read_link_token
            ? new URL(
                `/v/${access.scene.read_link_token}`,
                config.publicUrl,
              ).toString()
            : null,
      };
    },
  );

  app.put<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/grants",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(
          reply,
          403,
          "forbidden",
          "Dafür fehlen dir die Rechte.",
        );
      }
      const grants = parseGrants(
        (request.body as Record<string, unknown>)?.grants,
        ["viewer", "editor"],
      );
      if (!grants || !(await validateUserGrants(grants))) {
        return sendError(reply, 400, "invalid_grants");
      }
      if (
        grants.length &&
        !policies(await workspaceById(access.scene.workspace_id)).directSharing
      ) {
        return sendError(
          reply,
          403,
          "policy",
          "In diesem Workspace lassen sich einzelne Szenen nicht direkt teilen. Bitte über eine Collection freigeben.",
        );
      }
      const userId = request.auth!.user.id;
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("scene_grants")
          .where("scene_id", "=", access.scene.id)
          .execute();
        if (grants.length) {
          await trx
            .insertInto("scene_grants")
            .values(
              grants.map((grant) => ({
                scene_id: access.scene.id,
                principal_type: grant.type,
                principal: grant.principal,
                role: grant.role as "viewer" | "editor",
                created_by: userId,
              })),
            )
            .execute();
        }
      });
      recheckLiveAccess([access.scene.id]);
      ctx.events.record({
        type: "share.scene_grants",
        actor: request.auth!.user,
        request,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: {
          name: access.scene.name,
          grants: grants.map(
            (grant) => `${grant.type}:${grant.principal}:${grant.role}`,
          ),
        },
      });
      return { ok: true };
    },
  );

  // --- read-only links (all signed-in employees) ------------------------------

  app.post<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/read-link",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(
          reply,
          403,
          "forbidden",
          "Dafür fehlen dir die Rechte.",
        );
      }
      if (!policies(await workspaceById(access.scene.workspace_id)).readLinks) {
        return sendError(
          reply,
          403,
          "policy",
          "In diesem Workspace sind Nur-Lese-Links abgeschaltet.",
        );
      }
      const token = randomToken(16);
      await db
        .updateTable("scenes")
        .set({ read_link_token: token })
        .where("id", "=", access.scene.id)
        .execute();
      if (access.scene.read_link_token) {
        // a new link locks out everyone who came through the old one
        recheckLiveAccess([access.scene.id]);
      }
      ctx.events.record({
        type: "share.read_link_created",
        actor: request.auth!.user,
        request,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name },
      });
      return { url: new URL(`/v/${token}`, config.publicUrl).toString() };
    },
  );

  app.delete<{ Params: { sceneId: string } }>(
    "/api/scenes/:sceneId/read-link",
    { preHandler: requireAuth },
    async (request, reply) => {
      const access = await loadScene(request, reply, "viewer");
      if (!access) {
        return;
      }
      if (!access.canManage) {
        return sendError(
          reply,
          403,
          "forbidden",
          "Dafür fehlen dir die Rechte.",
        );
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("scenes")
          .set({ read_link_token: null })
          .where("id", "=", access.scene.id)
          .execute();
        await trx
          .deleteFrom("scene_link_viewers")
          .where("scene_id", "=", access.scene.id)
          .execute();
      });
      recheckLiveAccess([access.scene.id]);
      ctx.events.record({
        type: "share.read_link_deleted",
        actor: request.auth!.user,
        request,
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { token: string } }>(
    "/api/read-links/:token",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { token } = request.params;
      if (!/^[a-zA-Z0-9_-]{16,64}$/.test(token)) {
        return sendError(reply, 404, "not_found");
      }
      const scene = await db
        .selectFrom("scenes")
        .select(["id", "workspace_id"])
        .where("read_link_token", "=", token)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (
        !scene ||
        !policies(await workspaceById(scene.workspace_id)).readLinks
      ) {
        return sendError(
          reply,
          404,
          "not_found",
          "Dieser Link ist nicht mehr gültig.",
        );
      }
      await db
        .insertInto("scene_link_viewers")
        .values({ scene_id: scene.id, user_id: request.auth!.user.id, token })
        .onConflict((oc) =>
          oc.columns(["scene_id", "user_id"]).doUpdateSet({ token }),
        )
        .execute();
      return { sceneId: scene.id };
    },
  );

  // --- people and groups to share with ----------------------------------------

  app.get("/api/directory", { preHandler: requireAuth }, async (request) => {
    const q = searchText((request.query as Record<string, unknown>).q);
    if (q.length < 2) {
      return { users: [], groups: [] };
    }
    const pattern = containsPattern(q);
    const users = await db
      .selectFrom("users")
      .select(["id", "name", "email", "username"])
      .where("disabled_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("name", "ilike", pattern),
          eb("email", "ilike", pattern),
          eb("username", "ilike", pattern),
        ]),
      )
      .orderBy("name")
      .limit(8)
      .execute();
    const groups = await sql<{ name: string }>`
      select name from (select distinct unnest(groups) as name from users) known
      where name ilike ${pattern}
      order by name
      limit 8
    `.execute(db);
    return { users, groups: groups.rows.map((row) => row.name) };
  });
};
