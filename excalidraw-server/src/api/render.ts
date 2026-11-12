/**
 * Scenes as images for documentation pipelines and scripts (I3): SVG and
 * PNG rendered on the server, and the command line tool that uses them.
 *
 *   GET /api/v1/scenes/:sceneId/image?format=svg|png&frame=&theme=&scale=
 *   GET /api/v1/cli    the command line tool (one file, Node 20 or newer)
 */
import { readFile } from "node:fs/promises";

import { RenderError, renderScene } from "../../vendor/elements.mjs";
import { HttpError } from "../util/http.js";
import { queryParam } from "../util/validate.js";
import { actorOf } from "../workspace/access.js";

import { apiRateLimit } from "./routes.js";

import type { AppContext } from "../context.js";
import type { WorkspaceService } from "../workspace/service.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

/** renders one after the other; more than this waiting: busy */
const MAX_WAITING = 8;

const createQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  return <T>(task: () => Promise<T>): Promise<T> => {
    if (waiting >= MAX_WAITING) {
      throw new HttpError(
        503,
        "busy",
        "Gerade werden viele Bilder erzeugt. Bitte gleich noch einmal.",
      );
    }
    waiting++;
    const run = tail.then(task, task);
    tail = run.catch(() => {}).finally(() => waiting--);
    return run;
  };
};

/** where the command line tool lies: next to the bundle, or in the sources */
const CLI_CANDIDATES = [
  new URL("./cli/excalidraw.mjs", import.meta.url),
  new URL("../../cli/excalidraw.mjs", import.meta.url),
];

const safeFileName = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ._-]+/gu, "_")
    .slice(0, 80)
    .trim() || "szene";

export const registerRenderRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  services: { workspace: WorkspaceService },
  requireToken: preHandlerHookHandler,
) => {
  const { config } = ctx;
  const queue = createQueue();
  const actor = (request: FastifyRequest) => actorOf(request.auth!.user);

  app.get<{ Params: { sceneId: string } }>(
    "/api/v1/scenes/:sceneId/image",
    {
      preHandler: requireToken,
      // per token like every API call, but rendering costs: fewer
      config: {
        rateLimit: {
          ...apiRateLimit(ctx).rateLimit,
          max: Math.min(30, config.api.rateLimitPerMinute),
        },
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const format = queryParam(query.format) ?? "svg";
      if (format !== "svg" && format !== "png") {
        throw new HttpError(400, "invalid_format", "format: svg oder png.");
      }
      const frame = queryParam(query.frame);
      if (frame !== undefined && (!frame.trim() || frame.length > 200)) {
        throw new HttpError(400, "invalid_frame", "frame: Name oder id.");
      }
      const theme = queryParam(query.theme) ?? "light";
      if (theme !== "light" && theme !== "dark") {
        throw new HttpError(400, "invalid_theme", "theme: light oder dark.");
      }
      const background = queryParam(query.background) ?? "true";
      if (background !== "true" && background !== "false") {
        throw new HttpError(
          400,
          "invalid_background",
          "background: true oder false.",
        );
      }
      const scale = Number(queryParam(query.scale) ?? "1");
      if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
        throw new HttpError(400, "invalid_scale", "scale: 1 bis 4.");
      }

      const access = await services.workspace.sceneFor(
        actor(request),
        request.params.sceneId,
        "viewer",
      );
      const { key, elements } = await services.workspace.readContent(access);
      const live = elements.filter((element) => !element.isDeleted);
      const { files } = await services.workspace.readFiles(
        access.scene.id,
        key,
        live,
      );
      let result: { svg: string } | { png: Buffer };
      try {
        result = await queue(() =>
          renderScene(
            { elements: live, files },
            {
              format,
              frame,
              theme,
              background: background === "true",
              scale,
            },
          ),
        );
      } catch (error) {
        if (error instanceof RenderError) {
          throw new HttpError(
            error.code === "frame_not_found" ? 404 : 422,
            error.code,
            error.message,
          );
        }
        throw error;
      }
      const fileName = `${safeFileName(access.scene.name)}.${format}`;
      reply
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header(
          "content-disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        );
      if ("svg" in result) {
        // opened directly in a browser, an SVG is a document of this
        // origin: it may show itself and nothing else
        return reply
          .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
          )
          .type("image/svg+xml; charset=utf-8")
          .send(result.svg);
      }
      return reply.type("image/png").send(result.png);
    },
  );

  app.get("/api/v1/cli", async (_request, reply) => {
    for (const candidate of CLI_CANDIDATES) {
      try {
        const source = await readFile(candidate, "utf8");
        return reply
          .header("cache-control", "no-cache")
          .header(
            "content-disposition",
            'attachment; filename="excalidraw.mjs"',
          )
          .type("text/javascript; charset=utf-8")
          .send(source);
      } catch {
        // next place
      }
    }
    throw new HttpError(
      404,
      "not_found",
      "Das Kommandozeilen-Tool fehlt im Image.",
    );
  });
};
