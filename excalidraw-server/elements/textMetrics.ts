/**
 * Intranet fork: text measurement on the server, where there is no canvas.
 * Widths come from the shipped fonts' advance widths (fontWidths.json).
 * Imported by both bundles: the element logic (index.ts) and the renderer's
 * thread (renderWorker.ts).
 */
import { setCustomTextMetricsProvider } from "@excalidraw/element/textMeasurements";

import fontWidths from "./fontWidths.json";

interface WidthTable {
  fallback: number;
  widths: Map<number, number>;
}

const TABLES = new Map<string, WidthTable>(
  Object.entries(
    fontWidths as Record<
      string,
      { fallback: number; chars: string; widths: number[] }
    >,
  ).map(([family, table]) => [
    family,
    {
      fallback: table.fallback,
      widths: new Map(
        [...table.chars].map((char, i) => [
          char.codePointAt(0)!,
          table.widths[i],
        ]),
      ),
    },
  ]),
);

const FONT_STRING_RE = /^(\d+(?:\.\d+)?)px\s+(.*)$/;

/** width of one line of text in px, from the shipped fonts' advance widths */
export const measureLine = (text: string, fontString: string) => {
  const match = FONT_STRING_RE.exec(fontString);
  const size = match ? Number(match[1]) : 20;
  const family = (match ? match[2] : "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  const table = TABLES.get(family) || TABLES.get("Excalifont")!;
  let em = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    em +=
      table.widths.get(code) ??
      // emoji, then CJK and other full-width scripts
      (code >= 0x1f000 ? 1.2 : code >= 0x2e80 ? 1 : table.fallback);
  }
  return em * size;
};

setCustomTextMetricsProvider({ getLineWidth: measureLine });
