/**
 * Libraries on the server (L1, L2):
 * - personal: one per person, on every device (instead of the browser)
 * - team: one or more per team collection, maintained by its editors,
 *   usable by everyone who sees the collection
 * - company: per workspace, maintained by its admins, usable by all members
 *
 * Items are stored encrypted like scenes (own key, sealed with the master
 * key) and leave the server only to people who may use the library.
 */
import { sql } from "kysely";

import {
  decryptWithSceneKey,
  encryptWithSceneKey,
  generateSceneKey,
  openSceneKey,
  sealSceneKey,
} from "../util/crypto.js";
import { geometryProblem, LIBRARY_LIMITS } from "../../vendor/elements.mjs";
import { HttpError } from "../util/http.js";
import {
  containsPattern,
  hasControlChars,
  queryParam,
  searchText,
} from "../util/validate.js";

import {
  accessibleCollections,
  actorOf,
  atLeast,
  collectionRole,
} from "./access.js";
import { listWorkspaces, workspaceAccess } from "./workspaces.js";

import type { AppContext } from "../context.js";
import type { Database, LibraryKind } from "../db/schema.js";
import type { Actor } from "./access.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import type { Selectable } from "kysely";

type LibraryRow = Selectable<Database["libraries"]>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 2000;
const MAX_ELEMENTS_PER_ITEM = 5000;

const notFound = () =>
  new HttpError(404, "not_found", "Bibliothek nicht gefunden.");

const cleanName = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 100 ||
    hasControlChars(value)
  ) {
    throw new HttpError(400, "invalid_name", "Name: 1 bis 100 Zeichen.");
  }
  return value.replace(/\s+/g, " ").trim();
};

/**
 * library items as the editor stores them: checked for shape and for sane
 * sizes (whoever adds a library draws its items), not drawn
 */
const parseItems = (value: unknown, maxBytes: number) => {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    throw new HttpError(
      400,
      "invalid_items",
      `items: höchstens ${MAX_ITEMS} Einträge.`,
    );
  }
  for (const item of value as Record<string, unknown>[]) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      item.id.length > 200 ||
      !Array.isArray(item.elements) ||
      item.elements.length > MAX_ELEMENTS_PER_ITEM ||
      (item.name !== undefined &&
        (typeof item.name !== "string" || item.name.length > 500))
    ) {
      throw new HttpError(
        400,
        "invalid_items",
        "Ungültiger Bibliothekseintrag.",
      );
    }
    for (const element of item.elements as unknown[]) {
      const problem =
        element && typeof element === "object"
          ? geometryProblem(element as Record<string, unknown>, LIBRARY_LIMITS)
          : "kein Element";
      if (problem) {
        throw new HttpError(
          400,
          "invalid_items",
          `Ungültiger Bibliothekseintrag: ${problem}.`,
        );
      }
    }
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) {
    throw new HttpError(
      413,
      "library_too_large",
      "Die Bibliothek ist zu groß.",
    );
  }
  return { items: value as unknown[], json };
};

export const registerLibraryRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config } = ctx;
  const options = { preHandler: requireAuth };
  const actor = (request: FastifyRequest): Actor => actorOf(request.auth!.user);
  const body = (request: FastifyRequest) =>
    (request.body && typeof request.body === "object"
      ? request.body
      : {}) as Record<string, unknown>;

  const personalLibrary = async (userId: string) => {
    await db
      .insertInto("libraries")
      .values({
        kind: "personal",
        owner_id: userId,
        name: "Meine Bibliothek",
        key_sealed: sealSceneKey(config.dataEncryptionKey, generateSceneKey()),
        created_by: userId,
      })
      .onConflict((oc) =>
        oc.column("owner_id").where("kind", "=", "personal").doNothing(),
      )
      .execute();
    return db
      .selectFrom("libraries")
      .selectAll()
      .where("kind", "=", "personal")
      .where("owner_id", "=", userId)
      .executeTakeFirstOrThrow();
  };

  /** what the actor may do with a library: "none", "use" or "edit" */
  const rightsOn = async (current: Actor, library: LibraryRow) => {
    if (library.kind === "personal") {
      return library.owner_id === current.id ? "edit" : "none";
    }
    if (library.kind === "collection") {
      const collection = await db
        .selectFrom("collections")
        .selectAll()
        .where("id", "=", library.collection_id!)
        .executeTakeFirst();
      if (!collection || collection.kind !== "team") {
        return "none";
      }
      const role = await collectionRole(db, current, collection);
      return atLeast(role, "editor")
        ? "edit"
        : atLeast(role, "viewer")
        ? "use"
        : "none";
    }
    const workspace = await db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", library.workspace_id!)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!workspace) {
      return "none";
    }
    const access = await workspaceAccess(db, current, workspace);
    return access === "admin" ? "edit" : access === "member" ? "use" : "none";
  };

  /** a library and the actor's rights; 404 without at least "use" */
  const libraryFor = async (
    request: FastifyRequest,
    id: string,
    minimum: "use" | "edit",
  ) => {
    const current = actor(request);
    const library =
      id === "personal"
        ? await personalLibrary(current.id)
        : UUID_RE.test(id)
        ? await db
            .selectFrom("libraries")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst()
        : undefined;
    if (!library) {
      throw notFound();
    }
    const rights = await rightsOn(current, library);
    if (rights === "none") {
      throw notFound();
    }
    if (minimum === "edit" && rights !== "edit") {
      throw new HttpError(
        403,
        "forbidden",
        "Diese Bibliothek pflegen nur ihre Verantwortlichen.",
      );
    }
    return { library, rights };
  };

  const describe = async (library: LibraryRow, rights: "use" | "edit") => {
    const scope =
      library.kind === "collection"
        ? await db
            .selectFrom("collections")
            .select(["id", "name", "workspace_id"])
            .where("id", "=", library.collection_id!)
            .executeTakeFirst()
        : library.kind === "workspace"
        ? await db
            .selectFrom("workspaces")
            .select(["id", "name"])
            .where("id", "=", library.workspace_id!)
            .executeTakeFirst()
        : null;
    return {
      id: library.id,
      kind: library.kind,
      name: library.name,
      scope: scope ? { id: scope.id, name: scope.name } : null,
      canEdit: rights === "edit",
      items: library.items,
      revision: Number(library.revision),
      updatedAt: library.updated_at,
    };
  };

  const readItems = (library: LibraryRow) => {
    if (!library.content) {
      return [];
    }
    const key = openSceneKey(config.dataEncryptionKey, library.key_sealed);
    return JSON.parse(
      decryptWithSceneKey(key, library.content).toString("utf8"),
    );
  };

  const record = (
    request: FastifyRequest,
    library: LibraryRow,
    change: string,
    extra: Record<string, unknown> = {},
  ) => {
    // the personal library is nobody else's business
    if (library.kind === "personal") {
      return;
    }
    ctx.events.record({
      type: "library.changed",
      actor: request.auth!.user,
      request,
      workspaceId: library.workspace_id,
      collectionId: library.collection_id,
      target: library.id,
      data: { name: library.name, change, ...extra },
    });
  };

  // --- routes --------------------------------------------------------------------

  /** every library I may use: mine, my teams', my workspaces' */
  app.get("/api/libraries", options, async (request, reply) => {
    const current = actor(request);
    const personal = await personalLibrary(current.id);
    const collections = (await accessibleCollections(db, current)).filter(
      (item) => item.collection.kind === "team",
    );
    const workspaces = (await listWorkspaces(db, current)).filter(
      (item) => item.access === "member" || item.access === "admin",
    );
    const shared =
      collections.length || workspaces.length
        ? await db
            .selectFrom("libraries")
            .selectAll()
            .where((eb) =>
              eb.or([
                ...(collections.length
                  ? [
                      eb.and([
                        eb("kind", "=", "collection"),
                        eb(
                          "collection_id",
                          "in",
                          collections.map((item) => item.collection.id),
                        ),
                      ]),
                    ]
                  : []),
                ...(workspaces.length
                  ? [
                      eb.and([
                        eb("kind", "=", "workspace"),
                        eb(
                          "workspace_id",
                          "in",
                          workspaces.map((item) => item.workspace.id),
                        ),
                      ]),
                    ]
                  : []),
              ]),
            )
            .orderBy("kind", "desc")
            .orderBy("name")
            .execute()
        : [];
    const roleOf = new Map(
      collections.map((item) => [item.collection.id, item.role]),
    );
    const adminOf = new Set(
      workspaces
        .filter((item) => item.access === "admin")
        .map((item) => item.workspace.id),
    );
    const result = [await describe(personal, "edit")];
    for (const library of shared) {
      const edit =
        library.kind === "collection"
          ? atLeast(roleOf.get(library.collection_id!) || "none", "editor")
          : adminOf.has(library.workspace_id!);
      result.push(await describe(library, edit ? "edit" : "use"));
    }
    reply.header("cache-control", "no-store");
    return {
      libraries: result,
      // where I could start a new shared library
      canCreate: {
        collections: collections
          .filter((item) => atLeast(item.role, "editor"))
          .map((item) => ({
            id: item.collection.id,
            name: item.collection.name,
          })),
        workspaces: workspaces
          .filter((item) => item.access === "admin")
          .map((item) => ({
            id: item.workspace.id,
            name: item.workspace.name,
          })),
      },
    };
  });

  app.get<{ Params: { libraryId: string } }>(
    "/api/libraries/:libraryId",
    options,
    async (request, reply) => {
      const { library, rights } = await libraryFor(
        request,
        request.params.libraryId,
        "use",
      );
      reply.header("cache-control", "no-store");
      return {
        library: await describe(library, rights as "use" | "edit"),
        libraryItems: readItems(library),
      };
    },
  );

  app.put<{ Params: { libraryId: string } }>(
    "/api/libraries/:libraryId",
    { ...options, bodyLimit: config.limits.maxSceneBytes + 1024 * 1024 },
    async (request) => {
      const { library } = await libraryFor(
        request,
        request.params.libraryId,
        "edit",
      );
      const input = body(request);
      const { items, json } = parseItems(
        input.libraryItems,
        config.limits.maxSceneBytes,
      );
      const expected = input.expectedRevision;
      const key = openSceneKey(config.dataEncryptionKey, library.key_sealed);
      const content = encryptWithSceneKey(key, Buffer.from(json, "utf8"));
      let update = db
        .updateTable("libraries")
        .set({
          content,
          items: items.length,
          size: content.length,
          revision: sql`revision + 1`,
          updated_by: request.auth!.user.id,
          updated_at: sql`now()`,
        })
        .where("id", "=", library.id);
      if (typeof expected === "number") {
        update = update.where("revision", "=", String(expected));
      }
      const saved = await update.returning("revision").executeTakeFirst();
      if (!saved) {
        throw new HttpError(
          409,
          "conflict",
          "Die Bibliothek wurde inzwischen geändert.",
          { revision: Number(library.revision) },
        );
      }
      record(request, library, "items", { items: items.length });
      return { revision: Number(saved.revision) };
    },
  );

  /** a new team or company library */
  app.post("/api/libraries", options, async (request, reply) => {
    const current = actor(request);
    const input = body(request);
    const name = cleanName(input.name);
    let values: {
      kind: LibraryKind;
      collection_id: string | null;
      workspace_id: string | null;
    };
    if (typeof input.collectionId === "string") {
      const collection = UUID_RE.test(input.collectionId)
        ? await db
            .selectFrom("collections")
            .selectAll()
            .where("id", "=", input.collectionId)
            .executeTakeFirst()
        : undefined;
      if (
        !collection ||
        collection.kind !== "team" ||
        !atLeast(await collectionRole(db, current, collection), "editor")
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "Team-Bibliotheken legen Personen an, die die Collection bearbeiten dürfen.",
        );
      }
      values = {
        kind: "collection",
        collection_id: collection.id,
        workspace_id: collection.workspace_id,
      };
    } else if (typeof input.workspaceId === "string") {
      const workspace = UUID_RE.test(input.workspaceId)
        ? await db
            .selectFrom("workspaces")
            .selectAll()
            .where("id", "=", input.workspaceId)
            .where("deleted_at", "is", null)
            .executeTakeFirst()
        : undefined;
      if (
        !workspace ||
        (await workspaceAccess(db, current, workspace)) !== "admin"
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "Bibliotheken für einen ganzen Workspace legen dessen Admins an.",
        );
      }
      values = {
        kind: "workspace",
        collection_id: null,
        workspace_id: workspace.id,
      };
    } else {
      throw new HttpError(
        400,
        "invalid_input",
        "collectionId oder workspaceId angeben.",
      );
    }
    const created = await db
      .insertInto("libraries")
      .values({
        ...values,
        name,
        key_sealed: sealSceneKey(config.dataEncryptionKey, generateSceneKey()),
        created_by: current.id,
        updated_by: current.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    record(request, created, "created");
    return reply.code(201).send({ library: await describe(created, "edit") });
  });

  app.patch<{ Params: { libraryId: string } }>(
    "/api/libraries/:libraryId",
    options,
    async (request) => {
      const { library } = await libraryFor(
        request,
        request.params.libraryId,
        "edit",
      );
      if (library.kind === "personal") {
        throw new HttpError(
          400,
          "personal",
          "Die eigene Bibliothek heißt immer so.",
        );
      }
      const name = cleanName(body(request).name);
      await db
        .updateTable("libraries")
        .set({
          name,
          updated_at: sql`now()`,
          updated_by: request.auth!.user.id,
        })
        .where("id", "=", library.id)
        .execute();
      record(request, library, "renamed", { before: library.name, name });
      return { library: await describe({ ...library, name }, "edit") };
    },
  );

  app.delete<{ Params: { libraryId: string } }>(
    "/api/libraries/:libraryId",
    options,
    async (request, reply) => {
      const { library } = await libraryFor(
        request,
        request.params.libraryId,
        "edit",
      );
      if (library.kind === "personal") {
        throw new HttpError(400, "personal", "Die eigene Bibliothek bleibt.");
      }
      await db.deleteFrom("libraries").where("id", "=", library.id).execute();
      record(request, library, "deleted");
      return reply.code(204).send();
    },
  );

  // --- the company's catalog (L3) --------------------------------------------
  // Everyone signed in browses it, publishes libraries into it (from a file
  // or one of their libraries) and adds them to their own or a team
  // library. Who published an entry, and app admins, change or remove it.

  type CatalogRow = Selectable<Database["library_catalog"]>;

  const MAX_DESCRIPTION = 1000;

  const cleanDescription = (value: unknown) => {
    if (value === undefined || value === null) {
      return "";
    }
    if (
      typeof value !== "string" ||
      value.length > MAX_DESCRIPTION ||
      hasControlChars(value.replace(/[\n\r\t]/g, " "))
    ) {
      throw new HttpError(
        400,
        "invalid_description",
        `Beschreibung: höchstens ${MAX_DESCRIPTION} Zeichen.`,
      );
    }
    return value.trim();
  };

  const catalogEntry = async (id: string) => {
    const row = UUID_RE.test(id)
      ? await db
          .selectFrom("library_catalog")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst()
      : undefined;
    if (!row) {
      throw new HttpError(404, "not_found", "Nicht im Katalog.");
    }
    return row;
  };

  const mayChange = (request: FastifyRequest, row: CatalogRow) =>
    request.auth!.user.is_admin || row.created_by === request.auth!.user.id;

  const describeEntry = async (request: FastifyRequest, row: CatalogRow) => {
    const author = row.created_by
      ? await db
          .selectFrom("users")
          .select(["id", "name"])
          .where("id", "=", row.created_by)
          .executeTakeFirst()
      : undefined;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      items: row.items,
      downloads: row.downloads,
      author: author
        ? { id: author.id, name: author.name }
        : { id: null, name: "Gelöschte Person" },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      preview: row.preview
        ? `/api/library-catalog/${row.id}/preview?v=${new Date(
            row.updated_at,
          ).getTime()}`
        : null,
      canEdit: mayChange(request, row),
    };
  };

  const catalogItems = (row: CatalogRow) => {
    const key = openSceneKey(config.dataEncryptionKey, row.key_sealed);
    return JSON.parse(decryptWithSceneKey(key, row.content).toString("utf8"));
  };

  /** items and their preview, encrypted with the entry's key */
  const sealCatalog = async (
    sealedKey: Buffer,
    items: unknown[],
    json: string,
  ) => {
    const key = openSceneKey(config.dataEncryptionKey, sealedKey);
    let preview: Buffer | null = null;
    try {
      preview = encryptWithSceneKey(
        key,
        Buffer.from(await ctx.render.preview(items), "utf8"),
      );
    } catch (error) {
      // a library the renderer cannot draw is still a library
      ctx.log.warn({ err: error }, "library preview not rendered");
    }
    const content = encryptWithSceneKey(key, Buffer.from(json, "utf8"));
    return { content, preview, size: content.length, items: items.length };
  };

  /** the items to publish: sent along, or from one of my libraries */
  const itemsToPublish = async (
    request: FastifyRequest,
    input: Record<string, unknown>,
  ) => {
    if (typeof input.libraryId === "string") {
      // only who maintains a library hands it to the whole company
      const { library } = await libraryFor(request, input.libraryId, "edit");
      const items = readItems(library);
      return parseItems(items, config.limits.maxSceneBytes);
    }
    return parseItems(input.libraryItems, config.limits.maxSceneBytes);
  };

  const catalogLimit = {
    preHandler: requireAuth,
    bodyLimit: config.limits.maxSceneBytes + 1024 * 1024,
  };

  app.get("/api/library-catalog", options, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const search = searchText(queryParam(query.q));
    let builder = db.selectFrom("library_catalog").selectAll();
    if (search) {
      const pattern = containsPattern(search);
      builder = builder.where((eb) =>
        eb.or([
          eb("name", "ilike", pattern),
          eb("description", "ilike", pattern),
        ]),
      );
    }
    const rows = await builder
      .orderBy("updated_at", "desc")
      .limit(200)
      .execute();
    reply.header("cache-control", "no-store");
    return {
      entries: await Promise.all(
        rows.map((row) => describeEntry(request, row)),
      ),
    };
  });

  app.post("/api/library-catalog", catalogLimit, async (request, reply) => {
    const input = body(request);
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const { items, json } = await itemsToPublish(request, input);
    if (!items.length) {
      throw new HttpError(400, "empty", "Die Bibliothek ist leer.");
    }
    const keySealed = sealSceneKey(
      config.dataEncryptionKey,
      generateSceneKey(),
    );
    const sealed = await sealCatalog(keySealed, items, json);
    const row = await db
      .insertInto("library_catalog")
      .values({
        name,
        description,
        key_sealed: keySealed,
        content: sealed.content,
        preview: sealed.preview,
        items: sealed.items,
        size: sealed.size,
        created_by: request.auth!.user.id,
        updated_by: request.auth!.user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.events.record({
      type: "library_catalog.published",
      actor: request.auth!.user,
      request,
      target: row.id,
      data: { name, items: row.items },
    });
    return reply.code(201).send({ entry: await describeEntry(request, row) });
  });

  app.patch<{ Params: { entryId: string } }>(
    "/api/library-catalog/:entryId",
    catalogLimit,
    async (request) => {
      const row = await catalogEntry(request.params.entryId);
      if (!mayChange(request, row)) {
        throw new HttpError(
          403,
          "forbidden",
          "Nur wer den Eintrag veröffentlicht hat, ändert ihn.",
        );
      }
      const input = body(request);
      const changes: Partial<{
        name: string;
        description: string;
        content: Buffer;
        preview: Buffer | null;
        items: number;
        size: number;
      }> = {};
      if (input.name !== undefined) {
        changes.name = cleanName(input.name);
      }
      if (input.description !== undefined) {
        changes.description = cleanDescription(input.description);
      }
      if (input.libraryItems !== undefined || input.libraryId !== undefined) {
        const { items, json } = await itemsToPublish(request, input);
        if (!items.length) {
          throw new HttpError(400, "empty", "Die Bibliothek ist leer.");
        }
        Object.assign(changes, await sealCatalog(row.key_sealed, items, json));
      }
      const updated = await db
        .updateTable("library_catalog")
        .set({
          ...changes,
          updated_by: request.auth!.user.id,
          updated_at: sql`now()`,
        })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      ctx.events.record({
        type: "library_catalog.updated",
        actor: request.auth!.user,
        request,
        target: row.id,
        data: { name: updated.name, items: updated.items },
      });
      return { entry: await describeEntry(request, updated) };
    },
  );

  app.delete<{ Params: { entryId: string } }>(
    "/api/library-catalog/:entryId",
    options,
    async (request, reply) => {
      const row = await catalogEntry(request.params.entryId);
      if (!mayChange(request, row)) {
        throw new HttpError(
          403,
          "forbidden",
          "Nur wer den Eintrag veröffentlicht hat, entfernt ihn.",
        );
      }
      await db.deleteFrom("library_catalog").where("id", "=", row.id).execute();
      ctx.events.record({
        type: "library_catalog.removed",
        actor: request.auth!.user,
        request,
        target: row.id,
        data: { name: row.name },
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { entryId: string } }>(
    "/api/library-catalog/:entryId/preview",
    options,
    async (request, reply) => {
      const row = await catalogEntry(request.params.entryId);
      if (!row.preview) {
        throw new HttpError(404, "not_found", "Keine Vorschau.");
      }
      const key = openSceneKey(config.dataEncryptionKey, row.key_sealed);
      return reply
        .header("cache-control", "private, max-age=86400")
        .header("x-content-type-options", "nosniff")
        .header(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
        )
        .type("image/svg+xml; charset=utf-8")
        .send(decryptWithSceneKey(key, row.preview));
    },
  );

  /** the library as an .excalidrawlib file (also for #addLibrary links) */
  app.get<{ Params: { entryId: string } }>(
    "/api/library-catalog/:entryId/download",
    options,
    async (request, reply) => {
      const row = await catalogEntry(request.params.entryId);
      await db
        .updateTable("library_catalog")
        .set({ downloads: sql`downloads + 1` })
        .where("id", "=", row.id)
        .execute();
      const fileName = `${row.name.replace(
        /[^\p{L}\p{N} ._-]+/gu,
        "_",
      )}.excalidrawlib`;
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        )
        .type("application/vnd.excalidrawlib+json")
        .send(
          JSON.stringify({
            type: "excalidrawlib",
            version: 2,
            source: config.publicUrl.origin,
            libraryItems: catalogItems(row),
          }),
        );
    },
  );

  /** add an entry's items to my or a team library (new ones first) */
  app.post<{ Params: { entryId: string } }>(
    "/api/library-catalog/:entryId/add",
    options,
    async (request) => {
      const row = await catalogEntry(request.params.entryId);
      const input = body(request);
      const target =
        typeof input.libraryId === "string" ? input.libraryId : "personal";
      const { library } = await libraryFor(request, target, "edit");
      type Item = { id: string; name?: unknown; elements?: unknown };
      const current = readItems(library) as Item[];
      const mine = new Map(current.map((item) => [item.id, item]));
      // the same item: same id, same drawing and name (an author's update
      // replaces the old copy)
      const drawing = (item: Item) =>
        JSON.stringify([item.elements ?? null, item.name ?? null]);
      const offered = catalogItems(row) as Item[];
      const added = offered.filter((item) => !mine.has(item.id));
      const updated = new Map(
        offered
          .filter(
            (item) =>
              mine.has(item.id) &&
              drawing(item) !== drawing(mine.get(item.id)!),
          )
          .map((item) => [item.id, { ...item, status: "published" }]),
      );
      if (!added.length && !updated.size) {
        // nothing new: nothing written, no download counted
        return {
          added: 0,
          updated: 0,
          revision: Number(library.revision),
        };
      }
      const { items, json } = parseItems(
        [
          ...added.map((item) => ({ ...item, status: "published" })),
          ...current.map((item) => updated.get(item.id) ?? item),
        ],
        config.limits.maxSceneBytes,
      );
      const key = openSceneKey(config.dataEncryptionKey, library.key_sealed);
      const content = encryptWithSceneKey(key, Buffer.from(json, "utf8"));
      const saved = await db
        .updateTable("libraries")
        .set({
          content,
          items: items.length,
          size: content.length,
          revision: sql`revision + 1`,
          updated_by: request.auth!.user.id,
          updated_at: sql`now()`,
        })
        .where("id", "=", library.id)
        .where("revision", "=", library.revision)
        .returning("revision")
        .executeTakeFirst();
      if (!saved) {
        throw new HttpError(
          409,
          "conflict",
          "Die Bibliothek wurde gerade geändert. Bitte noch einmal.",
        );
      }
      await db
        .updateTable("library_catalog")
        .set({ downloads: sql`downloads + 1` })
        .where("id", "=", row.id)
        .execute();
      record(request, library, "items", { items: items.length });
      return {
        added: added.length,
        updated: updated.size,
        revision: Number(saved.revision),
      };
    },
  );
};
