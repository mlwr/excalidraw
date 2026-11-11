// Generates elements/fontWidths.json: advance widths (in em) of the fonts the
// editor ships, so the server measures text like the browser does (labels of
// shapes created through the API and the MCP server).
//
//   node excalidraw-server/scripts/font-metrics.mjs
//
// Run it again only when the fonts in packages/excalidraw/fonts change.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Font } = require("fonteditor-core");
const wawoff = require("wawoff2");

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(here, "../../packages/excalidraw/fonts");
const outFile = path.resolve(here, "../elements/fontWidths.json");

// family name as in the editor's font strings -> directory with its woff2 files
const FAMILIES = {
  Virgil: "Virgil",
  Cascadia: "Cascadia",
  Excalifont: "Excalifont",
  Nunito: "Nunito",
  "Lilita One": "Lilita",
  "Comic Shanns": "ComicShanns",
  "Liberation Sans": "Liberation",
  Assistant: "Assistant",
};

// Latin, punctuation, currency, arrows, math, box drawing, shapes, symbols
const RANGES = [
  [0x20, 0x7e],
  [0xa0, 0x17f],
  [0x2010, 0x205e],
  [0x20a0, 0x20bf],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x2500, 0x257f],
  [0x25a0, 0x25ff],
  [0x2600, 0x27bf],
];

const load = async (file) => {
  const ttf = new Uint8Array(
    await wawoff.decompress(await fs.promises.readFile(file)),
  ).buffer;
  try {
    return Font.create(ttf, { type: "ttf" }).get();
  } catch {
    return Font.create(ttf, { type: "otf" }).get();
  }
};

const result = {};
for (const [family, dir] of Object.entries(FAMILIES)) {
  const files = fs
    .readdirSync(path.join(fontsDir, dir))
    .filter((name) => name.endsWith(".woff2"))
    .sort();
  const advance = new Map();
  for (const file of files) {
    const font = await load(path.join(fontsDir, dir, file));
    const unitsPerEm = font.head.unitsPerEm;
    for (const glyph of font.glyf) {
      for (const code of glyph.unicode || []) {
        if (!advance.has(code)) {
          advance.set(code, glyph.advanceWidth / unitsPerEm);
        }
      }
    }
  }
  let chars = "";
  const widths = [];
  for (const [from, to] of RANGES) {
    for (let code = from; code <= to; code++) {
      if (advance.has(code)) {
        chars += String.fromCodePoint(code);
        widths.push(Math.round(advance.get(code) * 10000) / 10000);
      }
    }
  }
  const lower = [..."abcdefghijklmnopqrstuvwxyz"].map(
    (char) => advance.get(char.codePointAt(0)) || 0,
  );
  const fallback =
    Math.round((lower.reduce((sum, w) => sum + w, 0) / lower.length) * 10000) /
    10000;
  result[family] = { fallback, chars, widths };
  console.log(`${family}: ${widths.length} characters, fallback ${fallback}`);
}

fs.writeFileSync(outFile, `${JSON.stringify(result)}\n`);
console.log(`written ${path.relative(process.cwd(), outFile)}`);
