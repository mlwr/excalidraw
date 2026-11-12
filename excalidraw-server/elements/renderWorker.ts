/**
 * Intranet fork (I3): the server's renderer in a process of its own. A
 * scene that is costly to draw (or to unpack) stalls or kills this
 * process, not the server; the server ends it when it takes too long and
 * starts a new one (src/render/renderer.ts). It gets no secrets: no
 * environment, only scenes. Bundled into vendor/render-worker.mjs.
 *
 * Messages in:  { type: "setup", fontDirectory, fonts }
 *               { type: "fonts", fonts }
 *               { type: "scene", id, scene, options }
 *               { type: "preview", id, items }
 * Messages out: { id, ok: true, svg, rss } | { id, ok: true, png, rss }
 *               { id, ok: false, code, message, rss }
 */

import { writeFileSync } from "node:fs";

import {
  configureRenderFonts,
  registerRenderFont,
  RenderError,
  renderLibraryPreview,
  renderScene,
  unregisterRenderFont,
} from "./render";

import type { FontMetrics } from "./fonts";
import type { RenderOptions } from "./render";

interface RenderFont {
  id: number;
  family: string;
  metrics: FontMetrics;
  woff2: Uint8Array;
}

type Message =
  | { type: "setup"; fontDirectory: string | null; fonts: RenderFont[] }
  | { type: "fonts"; fonts: RenderFont[] }
  | {
      type: "scene";
      id: number;
      scene: { elements: unknown[]; files: Record<string, unknown> };
      options: RenderOptions;
    }
  | {
      type: "preview";
      id: number;
      items: { elements?: unknown[] }[];
    };

const send = (message: Record<string, unknown>) =>
  process.send?.({ ...message, rss: process.memoryUsage.rss() });

/** company fonts known to this process (E3), by id */
const registered = new Set<number>();
const syncFonts = (fonts: readonly RenderFont[]) => {
  const current = new Set(fonts.map((font) => font.id));
  for (const id of registered) {
    if (!current.has(id)) {
      unregisterRenderFont(id);
      registered.delete(id);
    }
  }
  for (const font of fonts) {
    if (!registered.has(font.id)) {
      registerRenderFont(font);
      registered.add(font.id);
    }
  }
};

// the server is gone: so is its renderer
process.on("disconnect", () => process.exit(0));

// short of memory, the kernel ends this process first, not the server
// (raising one's own score needs no rights; Linux only)
try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // elsewhere: limits on heap and time still apply
}

process.on("message", async (message: Message) => {
  if (message.type === "setup") {
    configureRenderFonts(message.fontDirectory);
    syncFonts(message.fonts || []);
    return;
  }
  if (message.type === "fonts") {
    syncFonts(message.fonts);
    return;
  }
  const { id } = message;
  try {
    if (message.type === "preview") {
      send({ id, ok: true, svg: await renderLibraryPreview(message.items) });
      return;
    }
    const result = await renderScene(message.scene, message.options);
    send({ id, ok: true, ...result });
  } catch (error) {
    send({
      id,
      ok: false,
      code: error instanceof RenderError ? error.code : "failed",
      message:
        error instanceof RenderError
          ? error.message
          : String((error as Error)?.message || error),
    });
  }
});
