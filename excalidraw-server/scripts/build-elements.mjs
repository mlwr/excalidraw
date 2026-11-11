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
      async (args) => ({
        contents: `var window;\n${await fs.readFile(args.path, "utf8")}`,
        loader: args.path.endsWith("x") ? "tsx" : "ts",
      }),
    );
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
    }),
  },
  plugins: [nodeShim],
  logLevel: "warning",
});
