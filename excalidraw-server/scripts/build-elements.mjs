// Bundles elements/index.ts -- the editor's element logic for the server --
// with the editor packages into vendor/elements.mjs. Runs before the server
// is started, tested or built (see package.json).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const packages = path.join(root, "packages");

// the editor packages assume a browser here and there; in Node each of their
// modules gets an empty local `window` (feature checks then see no browser)
const nodeShim = {
  name: "excalidraw-node-shim",
  setup(esbuild) {
    esbuild.onLoad(
      {
        filter:
          /[\\/]packages[\\/](common|element|math|utils|fractional-indexing|excalidraw)[\\/].*\.tsx?$/,
      },
      async (args) => {
        let prefix = "var window;\n";
        // I3, rendering: the font code reads fonts through the window,
        // fetch and FontFace that elements/render.ts provides
        if (/[\\/]fonts[\\/]ExcalidrawFontFace\.ts$/.test(args.path)) {
          // (looked up on use: the module may load before render.ts ran)
          prefix =
            "var window = new Proxy({}, { get: (_, key) => (globalThis.__excalidrawFonts || {})[key] });\n" +
            "var fetch = (...args) => (window.fetch || globalThis.fetch)(...args);\n" +
            "var FontFace = function (...args) { return new (window.FontFace || globalThis.FontFace)(...args); };\n";
        }
        // the WebAssembly glue of the font tools asks for these in Node
        if (/[\\/]subset[\\/]/.test(args.path)) {
          prefix +=
            "var __dirname = import.meta.dirname, __filename = import.meta.filename;\n";
        }
        return {
          contents: `${prefix}${await fs.readFile(args.path, "utf8")}`,
          loader: args.path.endsWith("x") ? "tsx" : "ts",
        };
      },
    );
  },
};

// font files are only names here: elements/render.ts reads them from the
// built app (STATIC_DIR/fonts)
const fontNames = {
  name: "excalidraw-font-names",
  setup(esbuild) {
    esbuild.onLoad({ filter: /\.woff2$/ }, (args) => ({
      contents: `export default ${JSON.stringify(path.basename(args.path))};`,
      loader: "js",
    }));
  },
};

await build({
  entryPoints: [path.join(here, "../elements/index.ts")],
  outfile: path.join(here, "../vendor/elements.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "none",
  alias: {
    "@excalidraw/common": path.join(packages, "common/src"),
    "@excalidraw/element": path.join(packages, "element/src"),
    "@excalidraw/excalidraw": path.join(packages, "excalidraw"),
    "@excalidraw/fractional-indexing": path.join(
      packages,
      "fractional-indexing/src",
    ),
    "@excalidraw/math": path.join(packages, "math/src"),
    "@excalidraw/utils": path.join(packages, "utils/src"),
    "@excalidraw/laser-pointer": path.join(packages, "laser-pointer/src"),
  },
  define: {
    "import.meta.env": JSON.stringify({
      MODE: "production",
      DEV: false,
      PROD: true,
      // no font downloads from the internet (B5)
      VITE_APP_ASSETS_FALLBACK_URL: "",
    }),
  },
  plugins: [nodeShim, fontNames],
  // resvg's WebAssembly (PNG rendering) travels inside the bundle
  loader: { ".wasm": "binary" },
  logLevel: "warning",
});
