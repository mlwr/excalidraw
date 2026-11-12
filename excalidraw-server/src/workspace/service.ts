/**
 * Workspace operations for the REST API (/api/v1) and the MCP server: the
 * same access model as the browser routes (workspace/access.ts), but errors
 * are thrown as HttpError instead of written to a reply.
 */
import { sql } from "kysely";

import {
  generateSceneKey,
  openSceneKey,
  randomToken,
  sealSceneKey,
} from "../util/crypto.js";
import { HttpError } from "../util/http.js";
import { containsPattern, singleLine } from "../util/validate.js";

import {
  accessibleCollections,
  atLeast,
  collectionRole,
  grantMatches,
  maxRole,
  SCENE_META_COLUMNS,
  sceneAccess,
} from "./access.js";
import {
  decodeFile,
  decryptElements,
  encodeFile,
  encryptElements,
  sceneVersionOf,
} from "./content.js";

import type { AppContext } from "../context.js";
import type { Collection } from "../db/schema.js";
import type { Actor, Role, SceneAccess, SceneMeta } from "./access.js";
import type { Change, SceneElement } from "../../vendor/elements.mjs";

export const SCENE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
export const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 200;
const MAX_SAVE_ATTEMPTS = 5;

/** image types the editor accepts as files */
export const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export const notFound = (what = "Szene") =>
  new HttpError(404, "not_found", `${what} nicht gefunden oder kein Zugriff.`);
const forbidden = () =>
  new HttpError(403, "forbidden", "Dafür fehlen dir die Rechte.");

export const cleanName = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const name = singleLine(value).replace(/\s+/g, " ").trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
};

export interface SceneFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export type SceneSort = "updated" | "created" | "name";

export const createWorkspaceService = (ctx: AppContext) => {
  const { db, config, blobs } = ctx;
  const masterKey = config.dataEncryptionKey;

  const defaultWorkspaceId = async () =>
    (
      await db
        .selectFrom("workspaces")
        .select("id")
        .where("slug", "=", "default")
        .executeTakeFirstOrThrow()
    ).id;

  /** the person who acts, for events */
  const person = (actor: Actor) => ({ id: actor.id, name: actor.name || "" });

  /** "Meine Szenen" of a person in a workspace (default workspace) */
  const ensurePersonalCollection = async (
    userId: string,
    workspaceId?: string,
  ) => {
    const workspace = workspaceId || (await defaultWorkspaceId());
    await db
      .insertInto("collections")
      .values({
        workspace_id: workspace,
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
      .where("workspace_id", "=", workspace)
      .executeTakeFirstOrThrow();
  };

  const collectionFor = async (
    actor: Actor,
    collectionId: string,
    minimum: Role,
  ) => {
    if (!UUID_RE.test(collectionId)) {
      throw notFound("Collection");
    }
    const collection = await db
      .selectFrom("collections")
      .selectAll()
      .where("id", "=", collectionId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!collection) {
      throw notFound("Collection");
    }
    const role = await collectionRole(db, actor, collection);
    if (role === "none") {
      throw notFound("Collection");
    }
    if (!atLeast(role, minimum)) {
      throw forbidden();
    }
    return { collection, role };
  };

  const sceneFor = async (
    actor: Actor,
    sceneId: string,
    minimum: Role,
  ): Promise<SceneAccess> => {
    if (typeof sceneId !== "string" || !SCENE_ID_RE.test(sceneId)) {
      throw notFound();
    }
    const access = await sceneAccess(db, actor, sceneId);
    if (!access || access.role === "none") {
      throw notFound();
    }
    if (!atLeast(access.role, minimum)) {
      throw forbidden();
    }
    return access;
  };

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

  const sceneUrl = (sceneId: string) =>
    new URL(`/s/${sceneId}`, config.publicUrl).toString();

  /** what clients of the API see of a scene */
  const describeScenes = async (
    items: {
      scene: SceneMeta;
      collection: Collection;
      role: Role;
      canManage: boolean;
    }[],
  ) => {
    const names = await userNames(
      items.flatMap(({ scene }) => [scene.created_by, scene.updated_by]),
    );
    const person = (id: string | null) =>
      id ? { id, name: names.get(id) || null } : null;
    return items.map(({ scene, collection, role, canManage }) => ({
      id: scene.id,
      name: scene.name,
      url: sceneUrl(scene.id),
      collection: {
        id: collection.id,
        name: collection.name,
        kind: collection.kind,
      },
      createdAt: scene.created_at,
      updatedAt: scene.updated_at,
      createdBy: person(scene.created_by),
      updatedBy: person(scene.updated_by),
      revision: Number(scene.revision),
      role: role === "manager" ? "editor" : role,
      canManage,
      hasReadLink: !!scene.read_link_token,
    }));
  };

  const describeAccess = async (access: SceneAccess) =>
    (
      await describeScenes([
        {
          scene: access.scene,
          collection: access.collection,
          role: access.role,
          canManage: access.canManage,
        },
      ])
    )[0];

  const listCollections = async (actor: Actor, workspaceId?: string) => {
    await ensurePersonalCollection(actor.id, workspaceId);
    const collections = await accessibleCollections(db, actor, workspaceId);
    const counts = await db
      .selectFrom("scenes")
      .select(["collection_id", sql<number>`count(*)::int`.as("count")])
      .where(
        "collection_id",
        "in",
        collections.map((item) => item.collection.id),
      )
      .where("deleted_at", "is", null)
      .groupBy("collection_id")
      .execute();
    const countMap = new Map(
      counts.map((row) => [row.collection_id, row.count]),
    );
    return collections.map(({ collection, role }) => ({
      id: collection.id,
      name: collection.name,
      kind: collection.kind,
      role,
      sceneCount: countMap.get(collection.id) || 0,
    }));
  };

  /** scenes in the actor's collections and scenes shared with them directly */
  const listScenes = async (
    actor: Actor,
    options: {
      collectionId?: string;
      /** only this workspace (all workspaces without it) */
      workspaceId?: string;
      query?: string;
      /** search index hashes: scenes whose texts contain the query */
      contentHashes?: string[] | null;
      sort?: SceneSort;
      limit: number;
      offset: number;
    },
  ) => {
    let accessible: { collection: Collection; role: Role }[];
    if (options.collectionId) {
      accessible = [await collectionFor(actor, options.collectionId, "viewer")];
    } else {
      await ensurePersonalCollection(actor.id, options.workspaceId);
      accessible = await accessibleCollections(db, actor, options.workspaceId);
    }
    const collectionRoles = new Map(
      accessible.map(({ collection, role }) => [collection.id, role]),
    );
    const collections = new Map(
      accessible.map(({ collection }) => [collection.id, collection]),
    );
    const collectionIds = [...collections.keys()];

    let base = db
      .selectFrom("scenes")
      .where("deleted_at", "is", null)
      .where((eb) =>
        options.collectionId
          ? eb("collection_id", "in", collectionIds)
          : eb.or([
              eb("collection_id", "in", collectionIds),
              eb.exists(
                eb
                  .selectFrom("scene_grants")
                  .select(sql`1`.as("one"))
                  .whereRef("scene_grants.scene_id", "=", "scenes.id")
                  .where(grantMatches(actor)),
              ),
            ]),
      );
    if (options.workspaceId) {
      base = base.where("workspace_id", "=", options.workspaceId);
    }
    if (options.query) {
      const pattern = containsPattern(options.query);
      const hashes = options.contentHashes;
      base = base.where((eb) =>
        hashes?.length
          ? eb.or([
              eb("name", "ilike", pattern),
              eb.exists(
                eb
                  .selectFrom("scene_search")
                  .select(sql`1`.as("one"))
                  .whereRef("scene_search.scene_id", "=", "scenes.id")
                  .where(
                    sql<boolean>`scene_search.tokens @> ${hashes}::bigint[]`,
                  ),
              ),
            ])
          : eb("name", "ilike", pattern),
      );
    }
    const { total } = await base
      .select(sql<number>`count(*)::int`.as("total"))
      .executeTakeFirstOrThrow();
    const column =
      options.sort === "name"
        ? "name"
        : options.sort === "created"
        ? "created_at"
        : "updated_at";
    const rows = await base
      .select(SCENE_META_COLUMNS)
      .orderBy(column, options.sort === "name" ? "asc" : "desc")
      .orderBy("id")
      .limit(options.limit)
      .offset(options.offset)
      .execute();

    // the same rights as sceneAccess(), for the whole page at once
    const direct = new Map<string, Role>();
    if (rows.length) {
      const grants = await db
        .selectFrom("scene_grants")
        .select(["scene_id", "role"])
        .where(
          "scene_id",
          "in",
          rows.map((row) => row.id),
        )
        .where(grantMatches(actor))
        .execute();
      for (const grant of grants) {
        direct.set(
          grant.scene_id,
          maxRole([direct.get(grant.scene_id) || "none", grant.role as Role]),
        );
      }
    }
    const unknown = [
      ...new Set(
        rows
          .map((row) => row.collection_id)
          .filter((id) => !collections.has(id)),
      ),
    ];
    if (unknown.length) {
      const more = await db
        .selectFrom("collections")
        .selectAll()
        .where("id", "in", unknown)
        .execute();
      more.forEach((collection) => collections.set(collection.id, collection));
    }
    const items = rows
      .map((scene) => {
        const fromCollection =
          collectionRoles.get(scene.collection_id) || "none";
        return {
          scene,
          collection: collections.get(scene.collection_id)!,
          role: maxRole([
            fromCollection === "manager" ? "editor" : fromCollection,
            direct.get(scene.id) || "none",
          ]),
          canManage: atLeast(fromCollection, "editor"),
        };
      })
      .filter((item) => item.role !== "none" && item.collection);
    return { total, scenes: await describeScenes(items) };
  };

  const createScene = async (
    actor: Actor,
    input: { name?: string | null; collectionId?: string | null },
  ) => {
    const collectionId =
      input.collectionId || (await ensurePersonalCollection(actor.id)).id;
    const { collection } = await collectionFor(actor, collectionId, "editor");
    const key = generateSceneKey();
    const scene = await db
      .insertInto("scenes")
      .values({
        id: randomToken(12),
        workspace_id: collection.workspace_id,
        collection_id: collection.id,
        name: input.name || "Unbenannte Szene",
        created_by: actor.id,
        updated_by: actor.id,
        key_sealed: sealSceneKey(masterKey, key),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.events.record({
      type: "scene.created",
      actor: person(actor),
      workspaceId: scene.workspace_id,
      collectionId: scene.collection_id,
      sceneId: scene.id,
      data: { name: scene.name, via: "api" },
    });
    return { scene, key, collection };
  };

  const updateScene = async (
    actor: Actor,
    sceneId: string,
    input: { name?: unknown; collectionId?: unknown },
  ) => {
    const access = await sceneFor(actor, sceneId, "editor");
    const changes: {
      name?: string;
      collection_id?: string;
      workspace_id?: string;
    } = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) {
        throw new HttpError(400, "invalid_name", "Bitte einen Namen angeben.");
      }
      changes.name = name;
    }
    if (input.collectionId !== undefined) {
      if (!access.canManage) {
        throw forbidden();
      }
      const target = await collectionFor(
        actor,
        String(input.collectionId),
        "editor",
      );
      changes.collection_id = target.collection.id;
      changes.workspace_id = target.collection.workspace_id;
    }
    if (!Object.keys(changes).length) {
      throw new HttpError(400, "nothing_to_change", "Nichts zu ändern.");
    }
    await db
      .updateTable("scenes")
      .set({ ...changes, updated_at: sql`now()` })
      .where("id", "=", access.scene.id)
      .execute();
    if (
      changes.collection_id &&
      changes.collection_id !== access.scene.collection_id
    ) {
      await ctx.realtime.recheckScenes([access.scene.id]).catch(() => {});
      ctx.events.record({
        type: "scene.moved",
        actor: person(actor),
        workspaceId: changes.workspace_id,
        collectionId: changes.collection_id,
        sceneId: access.scene.id,
        data: {
          name: changes.name || access.scene.name,
          from: access.collection.name,
          fromCollectionId: access.collection.id,
          via: "api",
        },
      });
    }
    if (changes.name && changes.name !== access.scene.name) {
      ctx.events.record({
        type: "scene.renamed",
        actor: person(actor),
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: changes.name, before: access.scene.name, via: "api" },
      });
    }
    return describeAccess(await sceneFor(actor, sceneId, "viewer"));
  };

  const deleteScene = async (actor: Actor, sceneId: string) => {
    const access = await sceneFor(actor, sceneId, "viewer");
    if (!access.canManage) {
      throw forbidden();
    }
    await db
      .updateTable("scenes")
      .set({ deleted_at: sql`now()`, deleted_by: actor.id })
      .where("id", "=", access.scene.id)
      .execute();
    ctx.realtime.closeSceneRoom(access.scene.id);
    ctx.events.record({
      type: "scene.deleted",
      actor: person(actor),
      workspaceId: access.scene.workspace_id,
      collectionId: access.scene.collection_id,
      sceneId: access.scene.id,
      data: { name: access.scene.name, via: "api" },
    });
  };

  const keyOf = (scene: SceneMeta) => openSceneKey(masterKey, scene.key_sealed);

  /** the drawing of a scene the actor may see (access checked before) */
  const readContent = async (access: SceneAccess) => {
    const key = keyOf(access.scene);
    const row = await db
      .selectFrom("scenes")
      .select(["iv", "ciphertext", "revision"])
      .where("id", "=", access.scene.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) {
      throw notFound();
    }
    const revision = Number(row.revision);
    return {
      key,
      revision,
      elements:
        revision === 0 || !row.iv || !row.ciphertext
          ? ([] as SceneElement[])
          : decryptElements(key, row.iv, row.ciphertext),
    };
  };

  /**
   * Change a scene's elements: read, change, write with the revision read
   * (others may save at the same time: then read again and redo the change),
   * then show the change in every open editor.
   */
  const changeContent = async (
    actor: Actor,
    sceneId: string,
    change: (elements: SceneElement[]) => Change,
    options: { expectedRevision?: number | null } = {},
  ) => {
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
      const access = await sceneFor(actor, sceneId, "editor");
      const { key, elements, revision } = await readContent(access);
      if (
        options.expectedRevision != null &&
        options.expectedRevision !== revision
      ) {
        throw new HttpError(
          409,
          "conflict",
          `Die Szene wurde inzwischen geändert (Revision ${revision}).`,
          { revision },
        );
      }
      const result = change(elements);
      if (!result.changed.length) {
        return { ...result, revision };
      }
      const json = Buffer.byteLength(JSON.stringify(result.elements));
      if (json > config.limits.maxSceneBytes) {
        throw new HttpError(413, "scene_too_large", "Die Szene ist zu groß.");
      }
      const { iv, data } = encryptElements(key, result.elements);
      await ctx.lifecycle.keepVersion(access.scene.id);
      const updated = await db
        .updateTable("scenes")
        .set({
          scene_version: sceneVersionOf(result.elements),
          revision: sql`revision + 1`,
          iv,
          ciphertext: data,
          updated_by: actor.id,
          updated_at: sql`now()`,
        })
        .where("id", "=", access.scene.id)
        .where("revision", "=", String(revision))
        .returning("revision")
        .executeTakeFirst();
      if (!updated) {
        continue;
      }
      ctx.realtime.broadcastSceneUpdate(access.scene.id, key, result.changed);
      ctx.events.recordEdit({
        actor: person(actor),
        workspaceId: access.scene.workspace_id,
        collectionId: access.scene.collection_id,
        sceneId: access.scene.id,
        data: { name: access.scene.name, via: "api" },
      });
      return { ...result, revision: Number(updated.revision) };
    }
    throw new HttpError(
      409,
      "conflict",
      "Die Szene wird gerade zu oft gleichzeitig geändert. Bitte erneut versuchen.",
    );
  };

  const fileKey = (sceneId: string, fileId: string) =>
    `files/scenes/${sceneId}/${fileId}`;

  /**
   * image files of the scene (data URLs), for export; files beyond the
   * scene size limit are left out (and named)
   */
  const readFiles = async (
    sceneId: string,
    key: string,
    elements: readonly SceneElement[],
  ) => {
    const ids = new Set(
      elements
        .filter(
          (element) =>
            element.type === "image" &&
            !element.isDeleted &&
            typeof element.fileId === "string" &&
            FILE_ID_RE.test(element.fileId),
        )
        .map((element) => element.fileId as string),
    );
    const files: Record<string, SceneFile> = {};
    const omitted: string[] = [];
    let total = 0;
    for (const id of ids) {
      if (total >= config.limits.maxSceneBytes) {
        omitted.push(id);
        continue;
      }
      const stored = await blobs.get(fileKey(sceneId, id));
      if (!stored) {
        continue;
      }
      try {
        // a data URL is at most maxFileBytes (the browser checks it before
        // uploading); inflating stops there
        const { metadata, dataURL } = decodeFile(
          key,
          stored.data,
          config.limits.maxFileBytes + 64 * 1024,
        );
        if (total + dataURL.length > config.limits.maxSceneBytes) {
          omitted.push(id);
          continue;
        }
        total += dataURL.length;
        files[id] = {
          id,
          mimeType: metadata.mimeType,
          dataURL,
          created: metadata.created,
        };
      } catch {
        // unreadable or oversized file: leave it out like a missing one
      }
    }
    return { files, omitted };
  };

  /** check image files that come with imported elements (data URLs) */
  const validateFiles = (files: unknown) => {
    if (files === undefined || files === null) {
      return [];
    }
    if (typeof files !== "object" || Array.isArray(files)) {
      throw new HttpError(400, "invalid_files", "files muss ein Objekt sein.");
    }
    return Object.entries(files as Record<string, any>).map(([id, value]) => {
      const mimeType = value?.mimeType;
      const dataURL = value?.dataURL;
      const match =
        typeof dataURL === "string"
          ? /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataURL)
          : null;
      if (
        !FILE_ID_RE.test(id) ||
        !IMAGE_MIME_TYPES.has(mimeType) ||
        !match ||
        match[1] !== mimeType
      ) {
        throw new HttpError(
          400,
          "invalid_file",
          `Datei ${id.slice(
            0,
            64,
          )}: erwartet wird ein Bild als data-URL (png, jpeg, gif, webp, svg).`,
        );
      }
      if (dataURL.length > config.limits.maxFileBytes) {
        throw new HttpError(413, "file_too_large", `Datei ${id} ist zu groß.`);
      }
      return {
        id,
        mimeType: mimeType as string,
        dataURL: dataURL as string,
        created: Number(value?.created) || Date.now(),
      };
    });
  };

  /** store checked image files of a scene (write-once, ids are hashes) */
  const storeFiles = async (
    sceneId: string,
    key: string,
    files: ReturnType<typeof validateFiles>,
    userId: string,
  ) => {
    let stored = 0;
    for (const file of files) {
      const created = await blobs.putIfAbsent(
        fileKey(sceneId, file.id),
        encodeFile(
          key,
          {
            id: file.id,
            mimeType: file.mimeType,
            created: file.created,
            lastRetrieved: Date.now(),
          },
          file.dataURL,
        ),
        { contentType: "application/octet-stream", createdBy: userId },
      );
      stored += created ? 1 : 0;
    }
    return stored;
  };

  /** remove a scene again that could not be filled (failed import) */
  const discardScene = async (sceneId: string) => {
    await db.deleteFrom("scenes").where("id", "=", sceneId).execute();
  };

  return {
    ensurePersonalCollection,
    collectionFor,
    sceneFor,
    sceneUrl,
    describeAccess,
    listCollections,
    listScenes,
    createScene,
    updateScene,
    deleteScene,
    readContent,
    changeContent,
    readFiles,
    validateFiles,
    storeFiles,
    discardScene,
  };
};

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
