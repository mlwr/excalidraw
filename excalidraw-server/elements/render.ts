/**
 * Intranet fork (I3): scenes as SVG and PNG on the server, for the REST API
 * and the command line tool (documentation pipelines).
 *
 * - SVG: the editor's own export (shapes, frames, images, fonts embedded and
 *   reduced to the characters used), built in a light DOM (linkedom).
 * - PNG: that SVG, rasterized by resvg (WebAssembly) with the fonts the SVG
 *   embeds, unpacked to TrueType.
 *
 * Fonts come from the built app (STATIC_DIR/fonts); nothing is fetched from
 * the network.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { parseHTML } from "linkedom";

import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { Fonts } from "@excalidraw/excalidraw/fonts/Fonts";
import { exportScene } from "@excalidraw/excalidraw/scene/export";
import loadWoff2 from "@excalidraw/excalidraw/subset/woff2/woff2-loader";

// resvg's WebAssembly, embedded by the build (binary loader, wasm.d.ts)
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export interface RenderOptions {
  format: "svg" | "png";
  /** id or name of a frame: only this frame */
  frame?: string;
  theme?: "light" | "dark";
  /** false: transparent */
  background?: boolean;
  /** pixels per scene pixel (1 to 4) */
  scale?: number;
}

export class RenderError extends Error {
  constructor(
    public readonly code: "frame_not_found" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

/** largest PNG (pixels); its memory is four bytes per pixel */
export const MAX_PNG_PIXELS = 16_000_000;
const MAX_PNG_SIDE = 8192;

// --- fonts from the built app -------------------------------------------------

const FONT_BASE = "file:///excalidraw-fonts/";
let fontFiles: Map<string, string> | null = null;
/** E3: the company's fonts, by file name */
const companyFonts = new Map<string, Uint8Array>();

/** a company font for renderings (E3), as the editor registers it */
export const registerRenderFont = (font: {
  id: number;
  family: string;
  metrics: {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineHeight: number;
  };
  woff2: Uint8Array;
}) => {
  const name = `company-${font.id}.woff2`;
  companyFonts.set(name, font.woff2);
  Fonts.registerCompanyFont({
    family: font.family,
    id: font.id,
    url: name,
    metrics: font.metrics,
  });
};

/** a removed company font: text in it falls back */
export const unregisterRenderFont = (id: number) => {
  companyFonts.delete(`company-${id}.woff2`);
};

/**
 * Where the app's fonts are (STATIC_DIR/fonts). Without, SVGs name their
 * fonts but do not embed them, and PNGs show text in no font at all.
 */
export const configureRenderFonts = (directory: string | null) => {
  fontFiles = null;
  fallbackFont = null;
  if (!directory) {
    return;
  }
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".woff2")) {
        files.set(entry.name, full);
      }
    }
  };
  walk(directory);
  fontFiles = files.size ? files : null;
};

/** what the editor's font code sees as its window (see build-elements.mjs) */
(globalThis as any).__excalidrawFonts = {
  EXCALIDRAW_ASSET_PATH: FONT_BASE,
  fetch: async (url: URL | string) => {
    const name = decodeURIComponent(
      new URL(String(url)).pathname.split("/").pop() || "",
    );
    const company = companyFonts.get(name);
    if (company) {
      return new Response(company.slice());
    }
    const file = fontFiles?.get(name);
    if (!file) {
      throw new Error(`font not available: ${name}`);
    }
    return new Response(new Uint8Array(readFileSync(file)));
  },
  // the editor registers its fonts as FontFace objects; only their sources
  // matter here
  FontFace: class {
    status = "unloaded";
    // as in browsers: the whole of Unicode unless the face says otherwise
    unicodeRange = "U+0-10FFFF";
    constructor(
      public family: string,
      public source: string,
      descriptors: Record<string, string> = {},
    ) {
      Object.assign(this, descriptors);
    }
    load() {
      this.status = "loaded";
      return Promise.resolve(this);
    }
  },
};

// --- rendering ------------------------------------------------------------------

const findFrame = (
  elements: readonly NonDeletedExcalidrawElement[],
  frame: string,
) =>
  (elements.find(
    (element) =>
      (element.type === "frame" || element.type === "magicframe") &&
      element.id === frame,
  ) ||
    elements.find(
      (element) =>
        (element.type === "frame" || element.type === "magicframe") &&
        (element as ExcalidrawFrameLikeElement).name?.trim() === frame.trim(),
    )) as ExcalidrawFrameLikeElement | undefined;

const renderSvg = async (
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles,
  options: RenderOptions,
  /** PNG: fonts are needed even if only to unpack them again */
  forPng: boolean,
) => {
  const exportingFrame = options.frame
    ? findFrame(elements, options.frame)
    : null;
  if (options.frame && !exportingFrame) {
    throw new RenderError(
      "frame_not_found",
      `Kein Frame „${options.frame}“ in dieser Szene.`,
    );
  }
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const svg = (await exportScene({
    type: "svg",
    data: {
      elements,
      appState: { viewBackgroundColor: "#ffffff" } as any,
      files,
    },
    config: {
      theme: options.theme === "dark" ? "dark" : "light",
      ...(options.background === false ? { canvasBackgroundColor: false } : {}),
      ...(exportingFrame ? { exportingFrame } : {}),
      scale: forPng ? 1 : options.scale || 1,
      ...(fontFiles || companyFonts.size
        ? {}
        : { skipInliningFonts: true as const }),
      environment: {
        document: document as unknown as Document,
        // fonts are embedded, not loaded into a browser
        loadFonts: async () => {},
      },
    } as any,
  })) as unknown as SVGSVGElement;
  // fonts that could not be read here would point to this server's disk
  return svg.outerHTML.replace(
    /@font-face \{ font-family: [^;]+; src: url\(file:[^)]*\); \}/g,
    "",
  );
};

let resvgReady: Promise<void> | null = null;

/**
 * Text in a font the SVG does not embed (frame names in Helvetica, fonts
 * that failed) gets Liberation Sans, which has Helvetica's metrics.
 */
const FALLBACK_FONT = "Liberation Sans";
let fallbackFont: Promise<Uint8Array | null> | null = null;

const loadFallbackFont = () =>
  (fallbackFont ??= (async () => {
    const name = [...(fontFiles?.keys() || [])].find((file) =>
      file.startsWith("LiberationSans-Regular"),
    );
    if (!name) {
      return null;
    }
    const { decompress } = await loadWoff2();
    const woff2 = Uint8Array.from(readFileSync(fontFiles!.get(name)!));
    return decompress(woff2.buffer);
  })().catch(() => null));

/** the fonts an SVG embeds, as TrueType for resvg */
const embeddedFonts = async (svg: string) => {
  const { decompress } = await loadWoff2();
  const fonts: Uint8Array[] = [];
  const fallback = await loadFallbackFont();
  if (fallback) {
    fonts.push(fallback);
  }
  for (const match of svg.matchAll(
    /url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g,
  )) {
    const woff2 = Uint8Array.from(Buffer.from(match[1], "base64"));
    try {
      fonts.push(decompress(woff2.buffer));
    } catch {
      // a font that does not unpack: its text falls back
    }
  }
  return fonts;
};

const rasterize = async (svg: string, scale: number) => {
  resvgReady ??= initWasm(resvgWasm as Uint8Array);
  await resvgReady;
  const width = Number(/\swidth="([\d.]+)"/.exec(svg)?.[1] || 0);
  const height = Number(/\sheight="([\d.]+)"/.exec(svg)?.[1] || 0);
  if (
    width * height * scale * scale > MAX_PNG_PIXELS ||
    Math.max(width, height) * scale > MAX_PNG_SIDE
  ) {
    throw new RenderError(
      "too_large",
      "Das Bild wäre zu groß. Bitte einen Frame wählen oder scale verkleinern.",
    );
  }
  const fonts = await embeddedFonts(svg);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      fontBuffers: fonts,
      loadSystemFonts: false,
      defaultFontFamily: FALLBACK_FONT,
      sansSerifFamily: FALLBACK_FONT,
    },
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
  try {
    const image = resvg.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
};

/** a scene (its elements and images) as an SVG text or a PNG */
export const renderScene = async (
  scene: { elements: readonly unknown[]; files: Record<string, unknown> },
  options: RenderOptions,
): Promise<{ svg: string } | { png: Buffer }> => {
  const elements = restoreElements(
    scene.elements as ExcalidrawElement[],
    null,
  ).filter((element) => !element.isDeleted) as NonDeletedExcalidrawElement[];
  const files = scene.files as unknown as BinaryFiles;
  const scale = Math.min(4, Math.max(1, options.scale || 1));
  if (options.format === "svg") {
    return {
      svg: await renderSvg(elements, files, { ...options, scale }, false),
    };
  }
  const svg = await renderSvg(elements, files, options, true);
  return { png: await rasterize(svg, scale) };
};

// --- library previews (L3) ------------------------------------------------------

const PREVIEW_CELL = 120;
const PREVIEW_GAP = 16;
const PREVIEW_COLUMNS = 4;

/**
 * The first items of a library side by side, each scaled into its own cell,
 * as an SVG for the catalog. Rendered here, never taken from an upload.
 */
export const renderLibraryPreview = async (
  items: readonly { elements?: readonly unknown[] }[],
  max = 8,
): Promise<string> => {
  const cells: string[] = [];
  for (const item of items) {
    if (cells.length >= max) {
      break;
    }
    if (!Array.isArray(item?.elements) || !item.elements.length) {
      continue;
    }
    const rendered = await renderScene(
      { elements: item.elements, files: {} },
      { format: "svg", background: false },
    );
    if (!("svg" in rendered)) {
      continue;
    }
    const { svg } = rendered;
    const width = Number(/\swidth="([\d.]+)"/.exec(svg)?.[1] || 0);
    const height = Number(/\sheight="([\d.]+)"/.exec(svg)?.[1] || 0);
    if (!width || !height) {
      continue;
    }
    const index = cells.length;
    const x = (index % PREVIEW_COLUMNS) * (PREVIEW_CELL + PREVIEW_GAP);
    const y =
      Math.floor(index / PREVIEW_COLUMNS) * (PREVIEW_CELL + PREVIEW_GAP);
    const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
    cells.push(
      `<svg x="${x}" y="${y}" width="${PREVIEW_CELL}" height="${PREVIEW_CELL}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`,
    );
  }
  const columns = Math.min(PREVIEW_COLUMNS, Math.max(1, cells.length));
  const rows = Math.max(1, Math.ceil(cells.length / PREVIEW_COLUMNS));
  const width = columns * PREVIEW_CELL + (columns - 1) * PREVIEW_GAP;
  const height = rows * PREVIEW_CELL + (rows - 1) * PREVIEW_GAP;
  return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${cells.join(
    "",
  )}</svg>`;
};
