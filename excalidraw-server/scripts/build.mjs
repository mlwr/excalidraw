// Bundles the server into a single ESM file, so the runtime image needs
// nothing but Node.js, this file and the renderer's thread (no
// node_modules).
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false,
  legalComments: "external",
  // optional native add-ons of pg and ws, not used
  external: ["pg-native", "bufferutil", "utf-8-validate"],
  // some bundled CommonJS dependencies call require() at runtime
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

// the renderer runs in a thread of its own (src/render/renderer.ts), from
// the file next to the server
await copyFile(
  path.join(server, "vendor/render-worker.mjs"),
  path.join(server, "dist/render-worker.mjs"),
);

// the licenses of what the element bundles carry belong to the notices
const notices = [];
for (const file of [
  "dist/server.mjs.LEGAL.txt",
  "vendor/elements.mjs.LEGAL.txt",
  "vendor/render-worker.mjs.LEGAL.txt",
]) {
  try {
    notices.push((await readFile(path.join(server, file), "utf8")).trim());
  } catch {
    // no legal comments there
  }
}
await writeFile(
  path.join(server, "dist/server.mjs.LEGAL.txt"),
  `${[...new Set(notices.filter(Boolean))].join("\n\n")}\n`,
);
