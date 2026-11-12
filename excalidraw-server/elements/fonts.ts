/**
 * Intranet fork (E3): company fonts. An uploaded TrueType, OpenType or WOFF2
 * file becomes WOFF2 (what the editor loads, subsets and embeds), with the
 * metrics the editor needs to place text.
 */
import loadWoff2 from "@excalidraw/excalidraw/subset/woff2/woff2-loader";

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineHeight: number;
}

export class FontFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontFileError";
  }
}

const tag = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** head and hhea of a TrueType / OpenType font */
const sfntMetrics = (bytes: Uint8Array): FontMetrics => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) {
    throw new FontFileError("Die Schriftdatei ist unvollständig.");
  }
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    if (record + 16 > bytes.byteLength) {
      throw new FontFileError("Die Schriftdatei ist beschädigt.");
    }
    tables.set(tag(bytes, record), view.getUint32(record + 8));
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  if (
    head === undefined ||
    hhea === undefined ||
    head + 20 > bytes.byteLength ||
    hhea + 10 > bytes.byteLength
  ) {
    throw new FontFileError("Der Schrift fehlen Angaben zur Zeilenhöhe.");
  }
  const unitsPerEm = view.getUint16(head + 18);
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  const lineGap = view.getInt16(hhea + 8);
  if (unitsPerEm < 16 || unitsPerEm > 16384 || ascender <= descender) {
    throw new FontFileError("Die Schrift hat ungültige Maße.");
  }
  const natural = (ascender - descender + Math.max(0, lineGap)) / unitsPerEm;
  return {
    unitsPerEm,
    ascender,
    descender,
    // the editor's own fonts use 1.15 to 1.35
    lineHeight:
      natural >= 1 && natural <= 2.5 ? Math.round(natural * 100) / 100 : 1.25,
  };
};

/** an uploaded font file as WOFF2, with its metrics */
export const prepareCompanyFont = async (
  file: Uint8Array,
): Promise<{ woff2: Uint8Array; metrics: FontMetrics }> => {
  const magic = tag(file, 0);
  const { compress, decompress } = await loadWoff2();
  if (magic === "wOF2") {
    let sfnt: Uint8Array;
    try {
      sfnt = decompress(file.slice().buffer);
    } catch {
      throw new FontFileError("Die WOFF2-Datei lässt sich nicht lesen.");
    }
    return { woff2: file, metrics: sfntMetrics(sfnt) };
  }
  if (magic === "\0\u0001\0\0" || magic === "OTTO" || magic === "true") {
    const metrics = sfntMetrics(file);
    let woff2: Uint8Array;
    try {
      woff2 = compress(file.slice().buffer);
    } catch {
      throw new FontFileError("Die Schrift lässt sich nicht umwandeln.");
    }
    if (!woff2.byteLength) {
      throw new FontFileError("Die Schrift lässt sich nicht umwandeln.");
    }
    return { woff2, metrics };
  }
  throw new FontFileError(
    "Nur TrueType (.ttf), OpenType (.otf) oder WOFF2 (.woff2).",
  );
};
