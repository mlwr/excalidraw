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
  accessibleCollections,
  actorOf,
  atLeast,
  collectionRole,
  grantMatches,
  sceneAccess,
} from "./access.js";

import type { AppContext } from "../context.js";
import type {
  Collection,
  GrantRole,
  PrincipalType,
  Scene,
} from "../db/schema.js";
import type { Actor, Role } from "./access.js";
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
  const name = value.replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
};

const isBase64 = (value: string) => /^[A-Za-z0-9+/]*={0,2}$/.test(value);

const parseGrants = (
  value: unknown,
  allowedRoles: GrantRole[],
): GrantInput[] | null => {
  if (!Array.isArray(value) || value.length > 200) {
    return null;
  }
  const grants: GrantInput[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const { type, principal, role } = item as Record<string, unknown>;
    if (
      (type !== "user" && type !== "group") ||
      typeof principal !== "string" ||
      !principal.trim() ||
      principal.length > 500 ||
      !allowedRoles.includes(role as GrantRole) ||
      (type === "user" && !UUID_RE.test(principal))
    ) {
      return null;
    }
    const key = `${type}:${principal}`;
    if (!seen.has(key)) {
      seen.add(key);
      grants.push({
        type,
        principal: principal.trim(),
        role: role as GrantRole,
      });
    }
  }
  return grants;
};

export const registerWorkspaceRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, blobs, config } = ctx;
  const masterKey = config.dataEncryptionKey;

  const actor = (request: FastifyRequest): Actor => actorOf(request.auth!.user);

  const defaultWorkspaceId = async () =>
    (
      await db
        .selectFrom("workspaces")
        .select("id")
        .where("slug", "=", "default")
        .executeTakeFirstOrThrow()
    ).id;

  const ensurePersonalCollection = async (userId: string) => {
    await db
      .insertInto("collections")
      .values({
        workspace_id: await defaultWorkspaceId(),
        name: "Meine Szenen",
        kind: "personal",
        owner_id: userId,
        created_by: userId,
      })
      .onConflict((oc) =>
        oc.column("owner_id").where("kind", "=", "personal").doNothing(),
      )
      .execute();
    return db
      .selectFrom("collections")
      .selectAll()
      .where("kind", "=", "personal")
      .where("owner_id", "=", userId)
      .executeTakeFirstOrThrow();
  };

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
    scenes: Scene[],
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

  // ---------------------------------------------------------------------------
  // workspace overview
  // ---------------------------------------------------------------------------

  app.get("/api/workspace", { preHandler: requireAuth }, async (request) => {
    await ensurePersonalCollection(request.auth!.user.id);
    const collections = await accessibleCollections(db, actor(request));
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
    return {
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
      const collection = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("collections")
          .values({
            workspace_id: await defaultWorkspaceId(),
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
      if (!grants.some((grant) => grant.role === "manager")) {
        return sendError(
          reply,
          400,
          "manager_required",
          "Mindestens eine Person oder Gruppe muss die Collection verwalten.",
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
      const query = request.query as Record<string, string | undefined>;
      const current = actor(request);
      const search = (query.q || "").trim().slice(0, 100);
      const sort =
        query.sort === "name" || query.sort === "created"
          ? query.sort
          : "updated";

      let scenes: Scene[] = [];
      const access = new Map<string, { role: Role; canManage: boolean }>();
      const mode = query.collection
        ? "collection"
        : query.view === "shared"
        ? "shared"
        : "recent";

      if (mode === "collection" && query.collection) {
        const loaded = await loadCollection(
          current,
          query.collection,
          reply,
          "viewer",
        );
        if (!loaded) {
          return;
        }
        let builder = db
          .selectFrom("scenes")
          .selectAll()
          .where("collection_id", "=", loaded.collection.id)
          .where("deleted_at", "is", null);
        if (search) {
          builder = builder.where("name", "ilike", `%${search}%`);
        }
        scenes = await builder.limit(500).execute();
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
          .selectAll()
          .where("deleted_at", "is", null)
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
          builder = builder.where("name", "ilike", `%${search}%`);
        }
        scenes = await builder.limit(500).execute();
        for (const scene of scenes) {
          const result = await sceneAccess(db, current, scene.id);
          if (result) {
            access.set(scene.id, {
              role: result.role,
              canManage: result.canManage,
            });
          }
        }
      } else {
        // recently visited by me
        const visited = await db
          .selectFrom("scene_visits")
          .innerJoin("scenes", "scenes.id", "scene_visits.scene_id")
          .selectAll("scenes")
          .where("scene_visits.user_id", "=", current.id)
          .where("scenes.deleted_at", "is", null)
          .orderBy("scene_visits.visited_at", "desc")
          .limit(30)
          .execute();
        const allowed: Scene[] = [];
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

      if (mode !== "recent") {
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
      return {
        scenes: await sceneSummaries(scenes, collections, {
          withPresence: true,
          access,
        }),
      };
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
        collectionId = (await ensurePersonalCollection(userId)).id;
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
      const changes: { name?: string; collection_id?: string } = {};

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
      }

      if (!Object.keys(changes).length) {
        return sendError(reply, 400, "nothing_to_change");
      }
      await db
        .updateTable("scenes")
        .set({ ...changes, updated_at: sql`now()` })
        .where("id", "=", access.scene.id)
        .execute();
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
        .set({ deleted_at: sql`now()` })
        .where("id", "=", access.scene.id)
        .execute();
      ctx.realtime.closeSceneRoom(access.scene.id);
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
      const { scene } = access;
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
        typeof body.iv !== "string" ||
        typeof body.ciphertext !== "string" ||
        !isBase64(body.iv) ||
        !isBase64(body.ciphertext) ||
        !(expected === null || typeof expected === "number")
      ) {
        return sendError(reply, 400, "invalid_body");
      }
      reply.header("cache-control", "no-store");
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
      return {
        grants: await grantsWithNames(rows),
        canManage: access.canManage,
        collection: {
          id: access.collection.id,
          name: access.collection.name,
          kind: access.collection.kind,
        },
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
      const token = randomToken(16);
      await db
        .updateTable("scenes")
        .set({ read_link_token: token })
        .where("id", "=", access.scene.id)
        .execute();
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
        .select("id")
        .where("read_link_token", "=", token)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!scene) {
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
    const q = String((request.query as Record<string, unknown>).q || "")
      .trim()
      .slice(0, 100);
    if (q.length < 2) {
      return { users: [], groups: [] };
    }
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
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
