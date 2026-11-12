/**
 * Company fonts (E3): app admins upload fonts (TrueType, OpenType, WOFF2);
 * everyone gets them in the editor's font menu, and exports embed them like
 * the editor's own fonts. Served from here, never from the internet.
 *
 *   GET    /api/fonts               the fonts, with their metrics
 *   GET    /api/fonts/:id.woff2     a font file
 *   POST   /api/admin/fonts?family= upload (raw file), app admins
 *   DELETE /api/admin/fonts/:id     remove, app admins
 */
import { sql } from "kysely";

import { FontFileError, prepareCompanyFont } from "../../vendor/elements.mjs";
import { HttpError } from "../util/http.js";
import { queryParam } from "../util/validate.js";

import type { AppContext } from "../context.js";
import type { FontMetrics } from "../db/schema.js";
import type { RenderFont } from "../render/renderer.js";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

export const MAX_FONT_BYTES = 10 * 1024 * 1024;
export const MAX_FONTS = 20;

/** names the editor already uses, and the generic CSS families */
const TAKEN = [
  "virgil",
  "helvetica",
  "cascadia",
  "excalifont",
  "nunito",
  "lilita one",
  "comic shanns",
  "liberation sans",
  "assistant",
  "xiaolai",
  "segoe ui emoji",
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "emoji",
  "math",
  "inherit",
  "initial",
  "unset",
];

/**
 * A family name that works unquoted in a CSS font shorthand (the editor
 * writes "20px Firma Sans, sans-serif"): words of letters and digits, none
 * starting with a digit.
 */
const FAMILY_RE = /^[\p{L}][\p{L}\p{N}-]*( [\p{L}][\p{L}\p{N}-]*){0,4}$/u;

export interface CompanyFont {
  id: number;
  family: string;
  url: string;
  metrics: FontMetrics;
}

/** how long a server instance trusts its list (others may change it) */
const LIST_TTL_MS = 10_000;

export const createCompanyFonts = (ctx: AppContext) => {
  const { db } = ctx;
  let cached: { at: number; fonts: CompanyFont[] } | null = null;
  let forRenderer: { key: string; fonts: RenderFont[] } = {
    key: "",
    fonts: [],
  };

  const describe = (row: {
    id: number;
    family: string;
    metrics: FontMetrics;
    created_at: Date;
  }): CompanyFont => ({
    id: row.id,
    family: row.family,
    // the timestamp keeps caches honest if an id ever came back
    url: `/api/fonts/${row.id}.woff2?v=${new Date(row.created_at).getTime()}`,
    metrics: row.metrics,
  });

  const list = async () => {
    if (!cached || Date.now() - cached.at > LIST_TTL_MS) {
      const rows = await db
        .selectFrom("company_fonts")
        .select(["id", "family", "metrics", "created_at"])
        .orderBy("family")
        .execute();
      cached = { at: Date.now(), fonts: rows.map(describe) };
    }
    return cached.fonts;
  };

  return {
    list,
    /** the fonts with their files, for the server's renderer */
    forRenderer: async () => {
      const fonts = await list();
      const key = fonts.map((font) => font.url).join(" ");
      if (key !== forRenderer.key) {
        const rows = fonts.length
          ? await db
              .selectFrom("company_fonts")
              .select(["id", "family", "metrics", "file"])
              .where(
                "id",
                "in",
                fonts.map((font) => font.id),
              )
              .execute()
          : [];
        forRenderer = {
          key,
          fonts: rows.map((row) => ({
            id: row.id,
            family: row.family,
            metrics: row.metrics,
            woff2: new Uint8Array(row.file),
          })),
        };
      }
      return forRenderer;
    },
    forget: () => {
      cached = null;
    },
  };
};

export type CompanyFonts = ReturnType<typeof createCompanyFonts>;

export const registerFontRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  requireAuth: preHandlerHookHandler,
) => {
  const { db } = ctx;
  const fonts = ctx.fonts;

  const requireAppAdmin = (request: FastifyRequest) => {
    if (!request.auth?.user.is_admin) {
      throw new HttpError(403, "forbidden", "Nur für App-Admins.");
    }
  };

  // public like the editor's own fonts: embedded scenes need them, too
  app.get("/api/fonts", async (_request, reply) => {
    reply.header("cache-control", "no-cache");
    return { fonts: await fonts.list() };
  });

  app.get<{ Params: { file: string } }>(
    "/api/fonts/:file",
    async (request, reply) => {
      const match = /^(\d{1,9})\.woff2$/.exec(request.params.file);
      const row = match
        ? await db
            .selectFrom("company_fonts")
            .select(["file", "created_at"])
            .where("id", "=", Number(match[1]))
            .executeTakeFirst()
        : undefined;
      if (!row) {
        throw new HttpError(404, "not_found", "Diese Schrift gibt es nicht.");
      }
      return reply
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .type("font/woff2")
        .send(row.file);
    },
  );

  app.post(
    "/api/admin/fonts",
    { preHandler: requireAuth, bodyLimit: MAX_FONT_BYTES },
    async (request, reply) => {
      requireAppAdmin(request);
      const family = (
        queryParam((request.query as Record<string, unknown>).family) || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (
        family.length > 40 ||
        !FAMILY_RE.test(family) ||
        TAKEN.includes(family.toLowerCase())
      ) {
        throw new HttpError(
          400,
          "invalid_family",
          "Name: Wörter aus Buchstaben und Ziffern (z. B. „Firma Sans“), nicht wie eine eingebaute Schrift.",
        );
      }
      if (!Buffer.isBuffer(request.body) || !request.body.length) {
        throw new HttpError(
          400,
          "invalid_file",
          "Bitte die Schriftdatei als application/octet-stream senden.",
        );
      }
      const active = await db
        .selectFrom("company_fonts")
        .select([sql<number>`count(*)::int`.as("count")])
        .executeTakeFirstOrThrow();
      if (active.count >= MAX_FONTS) {
        throw new HttpError(
          400,
          "too_many",
          `Höchstens ${MAX_FONTS} Firmenschriften.`,
        );
      }
      let prepared: Awaited<ReturnType<typeof prepareCompanyFont>>;
      try {
        prepared = await prepareCompanyFont(new Uint8Array(request.body));
      } catch (error) {
        if (error instanceof FontFileError) {
          throw new HttpError(400, "invalid_font", error.message);
        }
        throw error;
      }
      let row;
      try {
        row = await db
          .insertInto("company_fonts")
          .values({
            family,
            file: Buffer.from(prepared.woff2),
            size: prepared.woff2.byteLength,
            metrics: JSON.stringify(prepared.metrics),
            created_by: request.auth!.user.id,
          })
          .returning(["id", "family", "metrics", "created_at"])
          .executeTakeFirstOrThrow();
      } catch (error: any) {
        if (error?.code === "23505") {
          throw new HttpError(
            409,
            "family_taken",
            `Es gibt schon eine Schrift „${family}“.`,
          );
        }
        throw error;
      }
      fonts.forget();
      ctx.events.record({
        type: "admin.font_added",
        actor: request.auth!.user,
        request,
        target: String(row.id),
        data: { family, size: prepared.woff2.byteLength },
      });
      return reply.code(201).send({
        font: (await fonts.list()).find((font) => font.id === row.id),
      });
    },
  );

  app.delete<{ Params: { fontId: string } }>(
    "/api/admin/fonts/:fontId",
    { preHandler: requireAuth },
    async (request, reply) => {
      requireAppAdmin(request);
      const id = /^\d{1,9}$/.test(request.params.fontId)
        ? Number(request.params.fontId)
        : -1;
      // gone for good, file and who uploaded it (ids are never reused)
      const removed = await db
        .deleteFrom("company_fonts")
        .where("id", "=", id)
        .returning(["id", "family"])
        .executeTakeFirst();
      if (!removed) {
        throw new HttpError(404, "not_found", "Diese Schrift gibt es nicht.");
      }
      fonts.forget();
      ctx.events.record({
        type: "admin.font_removed",
        actor: request.auth!.user,
        request,
        target: String(removed.id),
        data: { family: removed.family },
      });
      return reply.code(204).send();
    },
  );
};
