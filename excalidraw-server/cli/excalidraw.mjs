#!/usr/bin/env node
/**
 * Excalidraw im Intranet: Kommandozeilen-Tool (I3).
 *
 * Szenen auflisten, als .excalidraw exportieren und importieren, als SVG
 * oder PNG rendern, etwa für Doku-Pipelines. Braucht Node.js 20 oder neuer
 * und sonst nichts. Herunterladen aus der App: <App>/api/v1/cli
 *
 *   export EXCALIDRAW_URL=https://excalidraw.intranet.example
 *   export EXCALIDRAW_TOKEN=exc_...   (App: Menü → API-Tokens)
 *   node excalidraw.mjs render <Szenen-ID> --format png -o diagramm.png
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const HELP = `Excalidraw im Intranet: Kommandozeile

Aufruf: node excalidraw.mjs <Befehl> [Optionen]

Umgebung:
  EXCALIDRAW_URL     Adresse der App, z. B. https://excalidraw.intranet.example
  EXCALIDRAW_TOKEN   API-Token (in der App: Menü → API-Tokens)

Befehle:
  whoami                          wem das Token gehört
  collections                     Collections auflisten
  scenes [--collection ID] [--search TEXT]
                                  Szenen auflisten
  export SZENE [-o DATEI]         Szene als .excalidraw speichern
  import DATEI [--collection ID] [--name NAME]
                                  neue Szene aus einer .excalidraw-Datei
  update SZENE DATEI              Szene durch eine .excalidraw-Datei ersetzen
  render SZENE [-o DATEI] [--format svg|png] [--frame NAME]
         [--theme light|dark] [--scale 1-4] [--transparent]
                                  Szene oder einen Frame als Bild speichern
  export-all (--collection ID | --workspace ID) -o DATEI.zip
                                  ganze Collection oder Workspace als ZIP

Optionen:
  --json        Listen und Ergebnisse als JSON
  -h, --help    diese Hilfe

SZENE ist die ID aus der Adresse einer Szene (…/s/<ID>) oder die ganze Adresse.
`;

class UsageError extends Error {}

const fail = (message, code = 1) => {
  process.stderr.write(`excalidraw: ${message}\n`);
  process.exit(code);
};

const settings = () => {
  const base = process.env.EXCALIDRAW_URL;
  const token = process.env.EXCALIDRAW_TOKEN;
  if (!base) {
    throw new UsageError("EXCALIDRAW_URL fehlt (Adresse der App).");
  }
  if (!token) {
    throw new UsageError("EXCALIDRAW_TOKEN fehlt (API-Token aus der App).");
  }
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new UsageError(`EXCALIDRAW_URL ist keine Adresse: ${base}`);
  }
  return { url, token };
};

const api = async (path, init = {}) => {
  const { url, token } = settings();
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.message || message;
    } catch {
      // keep the status
    }
    throw new Error(message);
  }
  return response;
};

const json = async (path, init) => (await api(path, init)).json();

/** a scene id, also from a pasted link (…/s/<id>) */
const sceneId = (value) => {
  if (!value) {
    throw new UsageError("Welche Szene? (ID oder Adresse)");
  }
  const match = /\/s\/([A-Za-z0-9_-]{8,64})/.exec(value);
  const id = match ? match[1] : value;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    throw new UsageError(`Keine Szenen-ID: ${value}`);
  }
  return id;
};

const output = (data, asJson, lines) => {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "");
  }
};

const readDocument = async (file) => {
  let document;
  try {
    document = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${file}: keine lesbare .excalidraw-Datei (${error.message})`,
    );
  }
  if (!document || !Array.isArray(document.elements)) {
    throw new UsageError(`${file}: keine .excalidraw-Datei (elements fehlt).`);
  }
  return document;
};

const commands = {
  async whoami(_args, options) {
    const me = await json("/api/v1/me");
    output(me, options.json, [
      `${me.user.name}${me.user.username ? ` (${me.user.username})` : ""}`,
    ]);
  },

  async collections(_args, options) {
    const { collections } = await json("/api/v1/collections");
    output(
      collections,
      options.json,
      collections.map(
        (collection) =>
          `${collection.id}  ${collection.name}${
            collection.kind === "personal" ? " (Meine Szenen)" : ""
          }`,
      ),
    );
  },

  async scenes(_args, options) {
    // page by page (the API returns at most 100 at a time)
    const scenes = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const query = new URLSearchParams({
        limit: "100",
        offset: String(offset),
      });
      if (options.collection) {
        query.set("collectionId", options.collection);
      }
      if (options.search) {
        query.set("q", options.search);
      }
      const page = (await json(`/api/v1/scenes?${query}`)).scenes;
      scenes.push(...page);
      if (page.length < 100) {
        break;
      }
    }
    output(
      scenes,
      options.json,
      scenes.map(
        (scene) =>
          `${scene.id}  ${scene.name}${
            scene.collection ? `  [${scene.collection.name}]` : ""
          }`,
      ),
    );
  },

  async export(args, options) {
    const id = sceneId(args[0]);
    const document = await json(`/api/v1/scenes/${id}/content`);
    const text = JSON.stringify(document, null, 2);
    if (options.output && options.output !== "-") {
      await writeFile(options.output, text);
      process.stderr.write(`gespeichert: ${options.output}\n`);
    } else {
      process.stdout.write(`${text}\n`);
    }
  },

  async import(args, options) {
    if (!args[0]) {
      throw new UsageError("Welche Datei?");
    }
    const document = await readDocument(args[0]);
    const name =
      options.name ||
      args[0]
        .split(/[\\/]/)
        .pop()
        .replace(/\.excalidraw(\.json)?$/i, "");
    const { scene } = await json("/api/v1/scenes", {
      method: "POST",
      body: JSON.stringify({
        name,
        ...(options.collection ? { collectionId: options.collection } : {}),
        content: { elements: document.elements, files: document.files || {} },
      }),
    });
    output(scene, options.json, [`${scene.id}  ${scene.name}`]);
  },

  async update(args, options) {
    const id = sceneId(args[0]);
    if (!args[1]) {
      throw new UsageError("Welche Datei?");
    }
    const document = await readDocument(args[1]);
    const result = await json(`/api/v1/scenes/${id}/content`, {
      method: "PUT",
      body: JSON.stringify({
        elements: document.elements,
        files: document.files || {},
      }),
    });
    output(result, options.json, [`aktualisiert: ${id}`]);
  },

  async render(args, options) {
    const id = sceneId(args[0]);
    const format =
      options.format ||
      (options.output && /\.png$/i.test(options.output) ? "png" : "svg");
    if (format !== "svg" && format !== "png") {
      throw new UsageError("--format: svg oder png");
    }
    const query = new URLSearchParams({ format });
    if (options.frame) {
      query.set("frame", options.frame);
    }
    if (options.theme) {
      query.set("theme", options.theme);
    }
    if (options.scale) {
      query.set("scale", options.scale);
    }
    if (options.transparent) {
      query.set("background", "false");
    }
    const response = await api(`/api/v1/scenes/${id}/image?${query}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = options.output || `${id}.${format}`;
    if (file === "-") {
      process.stdout.write(bytes);
      return;
    }
    await writeFile(file, bytes);
    process.stderr.write(`gespeichert: ${file}\n`);
  },

  async "export-all"(_args, options) {
    if (!options.collection === !options.workspace) {
      throw new UsageError("Entweder --collection oder --workspace angeben.");
    }
    if (!options.output) {
      throw new UsageError("-o DATEI.zip fehlt.");
    }
    const query = new URLSearchParams(
      options.collection
        ? { collection: options.collection }
        : { workspace: options.workspace },
    );
    const response = await api(`/api/v1/export?${query}`);
    await writeFile(options.output, Buffer.from(await response.arrayBuffer()));
    process.stderr.write(`gespeichert: ${options.output}\n`);
  },
};

const main = async () => {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        collection: { type: "string" },
        workspace: { type: "string" },
        search: { type: "string" },
        name: { type: "string" },
        format: { type: "string" },
        frame: { type: "string" },
        theme: { type: "string" },
        scale: { type: "string" },
        transparent: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(`${error.message}\n\n${HELP}`, 2);
  }
  const [command, ...args] = parsed.positionals;
  if (parsed.values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  const run = commands[command];
  if (!run) {
    fail(`unbekannter Befehl „${command}“\n\n${HELP}`, 2);
  }
  try {
    await run(args, parsed.values);
  } catch (error) {
    if (error instanceof UsageError) {
      fail(error.message, 2);
    }
    fail(error.message || String(error));
  }
};

await main();
