// Bundles the server into a single ESM file, so the runtime image needs
// nothing but Node.js and this file (no node_modules).
import { build } from "esbuild";

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
