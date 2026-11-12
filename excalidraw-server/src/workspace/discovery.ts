/**
 * Finding and taking out:
 * - search over all scenes of a workspace (W6): names, texts, comments
 * - export as a ZIP of .excalidraw files with their images (W9)
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import { Zip, ZipDeflate } from "fflate";

import { HttpError } from "../util/http.js";
import { queryParam, searchText } from "../util/validate.js";

import { actorOf } from "./access.js";
import { policiesOf, resolveWorkspace } from "./workspaces.js";

import type { AppContext } from "../context.js";
import type { Actor } from "./access.js";
import type { WorkspaceService } from "./service.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const PAGE = 100;
/** search results that get a snippet (each one decrypts a scene) */
const SNIPPETS = 12;

/** a file name that works on every system */
const safeName = (name: string) =>
  name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 100) || "Szene";

export const createDiscovery = (
  ctx: AppContext,
  workspace: WorkspaceService,
) => {
  const { config } = ctx;

  /** search the scenes of a workspace the actor can see */
  const search = async (
    current: Actor,
    options: { workspaceId?: string; query: string; limit?: number },
  ) => {
    const query = searchText(options.query);
    if (query.length < 2) {
      return { total: 0, results: [] };
    }
    const { total, scenes } = await workspace.listScenes(current, {
      workspaceId: options.workspaceId,
      query,
      contentHashes: config.search.content
        ? ctx.search.queryHashes(query)
        : null,
      sort: "updated",
      limit: options.limit ?? 30,
      offset: 0,
    });
    // snippets decrypt scenes: only for the first results
    const results = [];
    for (const [index, scene] of scenes.entries()) {
      results.push({
        ...scene,
        snippet:
          config.search.content && index < SNIPPETS
            ? await ctx.search.snippetOf(scene.id, query)
            : null,
      });
    }
    return { total, results };
  };

  /** every scene id the actor may export, with its folder name */
  const exportable = async (
    current: Actor,
    scope: { workspaceId?: string; collectionId?: string },
  ) => {
    const items: { id: string; folder: string }[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await workspace.listScenes(current, {
        workspaceId: scope.workspaceId,
        collectionId: scope.collectionId,
        sort: "name",
        limit: PAGE,
        offset,
      });
      for (const scene of page.scenes) {
        const own =
          scene.collection.kind === "personal" &&
          scene.role === "editor" &&
          scene.canManage;
        items.push({
          id: scene.id,
          folder:
            scene.collection.kind === "personal"
              ? own
                ? "Meine Szenen"
                : "Mit mir geteilt"
              : scene.collection.name,
        });
      }
      if (page.scenes.length < PAGE) {
        break;
      }
    }
    return items;
  };

  /** stream a ZIP: one .excalidraw file per scene, with its images */
  const sendZip = async (
    reply: FastifyReply,
    current: Actor,
    items: { id: string; folder: string }[],
    fileName: string,
  ) => {
    const stream = new PassThrough();
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        stream.destroy(error);
        return;
      }
      if (stream.destroyed) {
        return; // the download was cancelled
      }
      stream.write(Buffer.from(chunk));
      if (final) {
        stream.end();
      }
    });
    reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(
          fileName,
        )}`,
      )
      .header("cache-control", "no-store");
    const sent = reply.send(stream);

    // the download ended early (closed tab): stop reading scenes
    let aborted = false;
    stream.once("close", () => {
      aborted = !stream.writableFinished;
    });

    const add = async (path: string, data: string) => {
      const entry = new ZipDeflate(path, { level: 6 });
      zip.add(entry);
      entry.push(Buffer.from(data, "utf8"), true);
      if (stream.writableNeedDrain && !stream.destroyed) {
        // "close" too: a client that went away never drains
        await Promise.race([once(stream, "drain"), once(stream, "close")]);
      }
    };

    const taken = new Set<string>();
    const manifest = [];
    const unreadable: { id: string; name: string }[] = [];
    try {
      for (const item of items) {
        if (aborted || stream.destroyed) {
          break;
        }
        const access = await workspace
          .sceneFor(current, item.id, "viewer")
          .catch(() => null);
        if (!access) {
          continue; // gone or access lost while exporting
        }
        let content;
        try {
          const { key, elements, revision } = await workspace.readContent(
            access,
          );
          const live = elements.filter((element) => !element.isDeleted);
          content = {
            revision,
            live,
            ...(await workspace.readFiles(access.scene.id, key, live)),
          };
        } catch (error) {
          // one broken scene must not break the whole export
          ctx.log.warn(
            { err: error, sceneId: access.scene.id },
            "scene not exported",
          );
          unreadable.push({ id: access.scene.id, name: access.scene.name });
          continue;
        }
        const { revision, live, files, omitted } = content;
        let path = `${safeName(item.folder)}/${safeName(access.scene.name)}`;
        for (let n = 2; taken.has(path.toLowerCase()); n++) {
          path = `${safeName(item.folder)}/${safeName(
            access.scene.name,
          )} (${n})`;
        }
        taken.add(path.toLowerCase());
        await add(
          `${path}.excalidraw`,
          JSON.stringify({
            type: "excalidraw",
            version: 2,
            source: config.publicUrl.origin,
            elements: live,
            appState: { viewBackgroundColor: "#ffffff", gridSize: null },
            files,
          }),
        );
        manifest.push({
          file: `${path}.excalidraw`,
          id: access.scene.id,
          name: access.scene.name,
          collection: access.collection.name,
          url: workspace.sceneUrl(access.scene.id),
          createdAt: access.scene.created_at,
          updatedAt: access.scene.updated_at,
          revision,
          ...(omitted.length ? { filesOmitted: omitted } : {}),
        });
      }
      await add(
        "manifest.json",
        JSON.stringify(
          {
            exportedAt: new Date(),
            source: config.publicUrl.origin,
            scenes: manifest,
            ...(unreadable.length ? { unreadable } : {}),
          },
          null,
          2,
        ),
      );
      zip.end();
    } catch (error) {
      stream.destroy(error as Error);
    }
    return { sent, count: manifest.length };
  };

  return { search, exportable, sendZip };
};

export type Discovery = ReturnType<typeof createDiscovery>;

export const registerDiscoveryRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  discovery: Discovery,
  requireAuth: preHandlerHookHandler,
) => {
  const { db, config } = ctx;
  const actor = (request: FastifyRequest) => actorOf(request.auth!.user);

  /** requests per minute and session (not per address: many share one) */
  const perSession = (name: string, max: number) => ({
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => {
        const session = request.cookies?.[config.session.cookieName];
        return session
          ? `${name}:${createHash("sha256").update(session).digest("hex")}`
          : request.ip;
      },
    },
  });

  app.get(
    "/api/search",
    // each search decrypts scenes for its snippets
    { preHandler: requireAuth, config: perSession("search", 120) },
    async (request, reply) => {
      const current = actor(request);
      const query = request.query as Record<string, unknown>;
      const { workspace } = await resolveWorkspace(
        db,
        current,
        queryParam(query.workspace),
      );
      reply.header("cache-control", "no-store");
      const found = await discovery.search(current, {
        workspaceId: workspace.id,
        query: queryParam(query.q) || "",
      });
      // the dashboard shows results like its scene lists (with thumbnails)
      const ids = found.results.map((scene) => scene.id);
      const thumbnails = new Map(
        (ids.length
          ? await db
              .selectFrom("scenes")
              .select(["id", "thumbnail_updated_at"])
              .where("id", "in", ids)
              .execute()
          : []
        ).map((row) => [row.id, row.thumbnail_updated_at]),
      );
      return {
        total: found.total,
        results: found.results.map(
          ({ url, revision, createdBy, updatedBy, ...scene }) => {
            const thumbnail = thumbnails.get(scene.id);
            return {
              ...scene,
              createdBy: createdBy?.name ?? null,
              updatedBy: updatedBy?.name ?? null,
              thumbnailUrl: thumbnail
                ? `/api/scenes/${scene.id}/thumbnail?v=${new Date(
                    thumbnail,
                  ).getTime()}`
                : null,
              activeUsers: [],
            };
          },
        ),
      };
    },
  );

  /** everything I can see in a workspace, or one collection */
  app.get(
    "/api/export",
    {
      preHandler: requireAuth,
      config: perSession("export", 6),
    },
    async (request, reply) => {
      const current = actor(request);
      const query = request.query as Record<string, unknown>;
      const { workspace, access } = await resolveWorkspace(
        db,
        current,
        queryParam(query.workspace),
      );
      const policies = policiesOf(workspace, {
        trashRetentionDays: config.retention.trashDays,
      });
      if (!policies.export && access !== "admin") {
        throw new HttpError(
          403,
          "policy",
          "In diesem Workspace dürfen nur Admins exportieren.",
        );
      }
      const collectionId = queryParam(query.collection);
      const items = await discovery.exportable(current, {
        workspaceId: workspace.id,
        collectionId,
      });
      const date = new Date().toISOString().slice(0, 10);
      const { count } = await discovery.sendZip(
        reply,
        current,
        items,
        `excalidraw-${workspace.slug}-${date}.zip`,
      );
      ctx.events.record({
        type: "workspace.exported",
        actor: request.auth!.user,
        request,
        workspaceId: workspace.id,
        collectionId: collectionId ?? null,
        data: {
          scenes: count,
          scope: collectionId ? "collection" : "workspace",
        },
      });
      return reply;
    },
  );
};
