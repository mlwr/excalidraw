/**
 * Editor settings the app admins manage (E2): which web pages may be
 * embedded in scenes. Internal pages (wiki, dashboards, GitLab) by host;
 * the external services the editor knows (YouTube, Figma, ...) only if
 * switched on, since the intranet app makes no calls to the internet by
 * default (B5).
 *
 * The same list goes into the Content-Security-Policy (frame-src) of the
 * app, so the browser refuses any other frame, too.
 */
import { sql } from "kysely";

import type { AppContext } from "../context.js";

export interface EmbedSettings {
  /** host patterns: "wiki.intranet.example", "*.intranet.example:8443" */
  allowedHosts: string[];
  /** YouTube, Vimeo, Figma and the other services the editor knows */
  external: boolean;
}

export const MAX_EMBED_HOSTS = 50;

/** frame sources of the external services the editor embeds as iframes */
export const EXTERNAL_FRAME_SOURCES = [
  "https://www.youtube.com",
  "https://youtube.com",
  "https://player.vimeo.com",
  "https://vimeo.com",
  "https://drive.google.com",
  "https://www.figma.com",
  "https://figma.com",
  "https://*.simplepdf.eu",
  "https://stackblitz.com",
  "https://www.val.town",
  "https://val.town",
  "https://giphy.com",
  "https://forms.microsoft.com",
  "https://www.instagram.com",
  "https://link.excalidraw.com",
];

const HOST_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(:\d{1,5})?$/;

/**
 * A host as admins write it ("https://wiki.intranet.example/",
 * "*.intranet.example") in the form the app and the CSP use, or null.
 * Only https: the app itself runs on https, browsers block http frames.
 */
export const parseHostPattern = (input: string): string | null => {
  let value = input.trim().toLowerCase();
  if (value.startsWith("https://")) {
    value = value.slice("https://".length);
  } else if (value.includes("://")) {
    return null;
  }
  value = value.replace(/\/+$/, "");
  if (!HOST_RE.test(value) || value.length > 253) {
    return null;
  }
  // a wildcard needs at least two labels after it ("*.example.com")
  if (value.startsWith("*.") && value.split(".").length < 3) {
    return null;
  }
  const port = value.match(/:(\d+)$/)?.[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) {
    return null;
  }
  return value;
};

const DEFAULTS: EmbedSettings = { allowedHosts: [], external: false };

const CACHE_MS = 10_000;

export const createEditorSettings = (ctx: AppContext) => {
  const { db, config } = ctx;
  let cached: { at: number; value: EmbedSettings } | null = null;

  const embeds = async (): Promise<EmbedSettings> => {
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.value;
    }
    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "embeds")
      .executeTakeFirst();
    const stored = (row?.value || {}) as Partial<EmbedSettings>;
    const value: EmbedSettings = {
      allowedHosts: Array.isArray(stored.allowedHosts)
        ? stored.allowedHosts.filter(
            (host): host is string =>
              typeof host === "string" && parseHostPattern(host) === host,
          )
        : DEFAULTS.allowedHosts,
      external: stored.external === true,
    };
    cached = { at: Date.now(), value };
    return value;
  };

  const saveEmbeds = async (value: EmbedSettings, userId: string) => {
    const json = JSON.stringify(value);
    await db
      .insertInto("settings")
      .values({ key: "embeds", value: json, updated_by: userId })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: json,
          updated_by: userId,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    cached = null;
  };

  /** frame-src of the app: configured origins plus what the admins allow */
  const frameSources = async () => {
    const current = await embeds();
    return [
      ...new Set([
        ...config.cspFrameSrc,
        ...current.allowedHosts.map((host) => `https://${host}`),
        ...(current.external ? EXTERNAL_FRAME_SOURCES : []),
      ]),
    ];
  };

  return { embeds, saveEmbeds, frameSources };
};

export type EditorSettings = ReturnType<typeof createEditorSettings>;
