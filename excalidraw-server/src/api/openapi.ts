/** OpenAPI description of /api/v1, served at /api/v1/openapi.json */
import type { Config } from "../config.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({
  content: { "application/json": { schema } },
});
const ok = (description: string, schema?: object) => ({
  description,
  ...(schema ? json(schema) : {}),
});
const errors = {
  "400": ok("Ungültige Eingabe", ref("Error")),
  "401": ok("Token fehlt, ungültig, abgelaufen oder widerrufen", ref("Error")),
  "403": ok("Keine Berechtigung oder Lese-Token", ref("Error")),
  "404": ok("Nicht gefunden oder kein Zugriff", ref("Error")),
  "429": ok("Zu viele Anfragen"),
};
const sceneId = {
  name: "sceneId",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const listParams = [
  {
    name: "q",
    in: "query",
    schema: { type: "string" },
    description: "Suche im Namen",
  },
  {
    name: "sort",
    in: "query",
    schema: { enum: ["updated", "created", "name"] },
  },
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
];

export const openApiDocument = (config: Config) => ({
  openapi: "3.1.0",
  info: {
    title: "Excalidraw Intranet API",
    version: "1",
    description:
      "Szenen, Collections und Kommentare des Workspace. Anmeldung mit einem persönlichen API-Token (in der App unter „API-Tokens“), es gelten die Rechte seiner Person. Lese-Tokens dürfen nur GET.",
  },
  servers: [{ url: new URL("/api/v1", config.publicUrl).toString() }],
  security: [{ token: [] }],
  components: {
    securitySchemes: {
      token: { type: "http", scheme: "bearer", description: "exc_…" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          message: { type: "string" },
        },
      },
      Collection: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          kind: { enum: ["personal", "team"] },
          role: { enum: ["viewer", "editor", "manager"] },
          sceneCount: { type: "integer" },
        },
      },
      Person: {
        type: ["object", "null"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      Scene: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          url: { type: "string", format: "uri" },
          collection: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              kind: { type: "string" },
            },
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          createdBy: ref("Person"),
          updatedBy: ref("Person"),
          revision: { type: "integer" },
          role: { enum: ["viewer", "editor"] },
          canManage: { type: "boolean" },
          hasReadLink: { type: "boolean" },
        },
      },
      SceneList: {
        type: "object",
        properties: {
          scenes: { type: "array", items: ref("Scene") },
          total: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
      Skeleton: {
        type: "object",
        description:
          "Element im Skelett-Format des Editors (convertToExcalidrawElements). Formen mit label werden beschriftet, Pfeile mit start/end an Elemente gebunden (auch an vorhandene, per id).",
        required: ["type"],
        properties: {
          type: {
            enum: [
              "rectangle",
              "ellipse",
              "diamond",
              "text",
              "arrow",
              "line",
              "frame",
            ],
          },
          id: {
            type: "string",
            description: "frei wählbar, für Verweise im selben Aufruf",
          },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          text: { type: "string", description: "nur für type text" },
          label: {
            type: "object",
            properties: {
              text: { type: "string" },
              fontSize: { type: "number" },
            },
          },
          start: { type: "object", properties: { id: { type: "string" } } },
          end: { type: "object", properties: { id: { type: "string" } } },
          strokeColor: { type: "string" },
          backgroundColor: { type: "string" },
          fillStyle: { enum: ["hachure", "cross-hatch", "solid", "zigzag"] },
          strokeStyle: { enum: ["solid", "dashed", "dotted"] },
          fontSize: { type: "number" },
          children: {
            type: "array",
            items: { type: "string" },
            description: "Rahmen: ids der Elemente darin",
          },
          name: { type: "string", description: "Rahmen: Titel" },
        },
      },
      ElementUpdate: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          text: { type: "string", description: "Text oder Beschriftung" },
          strokeColor: { type: "string" },
          backgroundColor: { type: "string" },
          fillStyle: { enum: ["hachure", "cross-hatch", "solid", "zigzag"] },
          strokeStyle: { enum: ["solid", "dashed", "dotted"] },
          strokeWidth: { type: "number" },
          roughness: { type: "number" },
          opacity: { type: "number" },
          fontSize: { type: "number" },
          link: { type: ["string", "null"] },
        },
      },
      ElementSummary: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          text: { type: "string" },
          containerId: { type: "string" },
          start: { type: ["string", "null"] },
          end: { type: ["string", "null"] },
        },
      },
      Diagram: {
        type: "object",
        required: ["nodes"],
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "label"],
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                shape: { enum: ["rectangle", "ellipse", "diamond"] },
                backgroundColor: { type: "string" },
                strokeColor: { type: "string" },
              },
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              required: ["from", "to"],
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                label: { type: "string" },
                strokeStyle: { enum: ["solid", "dashed", "dotted"] },
              },
            },
          },
          direction: { enum: ["TB", "LR"], default: "TB" },
        },
      },
      ExcalidrawDocument: {
        type: "object",
        description: "Inhalt einer .excalidraw-Datei",
        properties: {
          type: { const: "excalidraw" },
          version: { type: "integer" },
          elements: { type: "array", items: { type: "object" } },
          files: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                id: { type: "string" },
                mimeType: { type: "string" },
                dataURL: { type: "string" },
                created: { type: "integer" },
              },
            },
          },
          revision: { type: "integer" },
        },
      },
      Thread: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          x: { type: "number" },
          y: { type: "number" },
          elementId: { type: ["string", "null"] },
          resolved: { type: "boolean" },
          createdBy: ref("Person"),
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                author: ref("Person"),
                createdAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
  },
  paths: {
    "/me": {
      get: {
        summary: "Eigene Person und Token",
        responses: { "200": ok("OK"), ...errors },
      },
    },
    "/collections": {
      get: {
        summary: "Collections mit Zugriff",
        responses: {
          "200": ok("OK", {
            type: "object",
            properties: {
              collections: { type: "array", items: ref("Collection") },
            },
          }),
          ...errors,
        },
      },
    },
    "/collections/{collectionId}/scenes": {
      get: {
        summary: "Szenen einer Collection",
        parameters: [
          {
            name: "collectionId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          ...listParams,
        ],
        responses: { "200": ok("OK", ref("SceneList")), ...errors },
      },
    },
    "/scenes": {
      get: {
        summary: "Alle Szenen mit Zugriff",
        parameters: listParams,
        responses: { "200": ok("OK", ref("SceneList")), ...errors },
      },
      post: {
        summary:
          "Szene anlegen: leer, aus Skeletten oder aus einer .excalidraw-Datei",
        requestBody: json({
          type: "object",
          properties: {
            name: { type: "string" },
            collectionId: {
              type: "string",
              description: "Standard: Meine Szenen",
            },
            elements: { type: "array", items: ref("Skeleton") },
            content: ref("ExcalidrawDocument"),
          },
        }),
        responses: { "201": ok("Angelegt"), ...errors },
      },
    },
    "/scenes/{sceneId}": {
      get: {
        summary: "Szene",
        parameters: [sceneId],
        responses: { "200": ok("OK"), ...errors },
      },
      patch: {
        summary: "Umbenennen oder verschieben",
        parameters: [sceneId],
        requestBody: json({
          type: "object",
          properties: {
            name: { type: "string" },
            collectionId: { type: "string" },
          },
        }),
        responses: { "200": ok("OK"), ...errors },
      },
      delete: {
        summary: "Löschen",
        parameters: [sceneId],
        responses: { "204": ok("Gelöscht"), ...errors },
      },
    },
    "/scenes/{sceneId}/content": {
      get: {
        summary: "Inhalt als .excalidraw-Dokument",
        parameters: [
          sceneId,
          {
            name: "files",
            in: "query",
            schema: { enum: ["true", "false"] },
            description: "Bilder mitliefern (Standard true)",
          },
        ],
        responses: { "200": ok("OK", ref("ExcalidrawDocument")), ...errors },
      },
      put: {
        summary:
          "Inhalt ersetzen; geöffnete Editoren übernehmen die Änderung sofort",
        parameters: [sceneId],
        requestBody: json({
          type: "object",
          required: ["elements"],
          properties: {
            elements: { type: "array", items: { type: "object" } },
            files: { type: "object" },
            expectedRevision: {
              type: "integer",
              description: "409, wenn die Szene inzwischen geändert wurde",
            },
          },
        }),
        responses: {
          "200": ok("OK"),
          "409": ok("Inzwischen geändert", ref("Error")),
          ...errors,
        },
      },
    },
    "/scenes/{sceneId}/elements": {
      post: {
        summary: "Elemente hinzufügen (Skelett-Format)",
        parameters: [sceneId],
        requestBody: json({
          type: "object",
          required: ["elements"],
          properties: { elements: { type: "array", items: ref("Skeleton") } },
        }),
        responses: { "201": ok("Hinzugefügt"), ...errors },
      },
      patch: {
        summary: "Elemente ändern: Text, Position, Größe, Stil",
        parameters: [sceneId],
        requestBody: json({
          type: "object",
          required: ["updates"],
          properties: {
            updates: { type: "array", items: ref("ElementUpdate") },
          },
        }),
        responses: { "200": ok("OK"), ...errors },
      },
      delete: {
        summary: "Elemente löschen (mit Beschriftung)",
        parameters: [
          sceneId,
          {
            name: "ids",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "kommagetrennt",
          },
        ],
        responses: { "200": ok("OK"), ...errors },
      },
    },
    "/scenes/{sceneId}/diagram": {
      post: {
        summary:
          "Diagramm aus Knoten und Kanten automatisch anordnen und hinzufügen",
        parameters: [sceneId],
        requestBody: json(ref("Diagram")),
        responses: { "201": ok("Hinzugefügt"), ...errors },
      },
    },
    "/scenes/{sceneId}/comments": {
      get: {
        summary: "Kommentare",
        parameters: [
          sceneId,
          {
            name: "status",
            in: "query",
            schema: { enum: ["open", "resolved", "all"] },
          },
        ],
        responses: {
          "200": ok("OK", {
            type: "object",
            properties: { threads: { type: "array", items: ref("Thread") } },
          }),
          ...errors,
        },
      },
      post: {
        summary: "Kommentar an einer Stelle oder einem Element",
        parameters: [sceneId],
        requestBody: json({
          type: "object",
          required: ["text", "x", "y"],
          properties: {
            text: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            elementId: {
              type: "string",
              description:
                "x/y sind dann relativ zur linken oberen Ecke des Elements",
            },
          },
        }),
        responses: { "201": ok("Angelegt"), ...errors },
      },
    },
    "/comment-threads/{threadId}": {
      patch: {
        summary: "Erledigt setzen oder verschieben",
        parameters: [
          {
            name: "threadId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: json({
          type: "object",
          properties: { resolved: { type: "boolean" } },
        }),
        responses: { "200": ok("OK"), ...errors },
      },
      delete: {
        summary: "Thread löschen",
        parameters: [
          {
            name: "threadId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "204": ok("Gelöscht"), ...errors },
      },
    },
    "/comment-threads/{threadId}/comments": {
      post: {
        summary: "Antworten",
        parameters: [
          {
            name: "threadId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: json({
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
        }),
        responses: { "201": ok("Angelegt"), ...errors },
      },
    },
    "/search": {
      get: {
        summary:
          "Suche in Namen, Texten der Zeichnungen und Kommentaren (Wortanfänge, alle Wörter müssen vorkommen)",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 2 },
          },
          {
            name: "workspace",
            in: "query",
            description: "ID oder Kurzname; ohne: alle Workspaces",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": ok("Höchstens 50 Treffer mit Textausschnitt", {
            type: "object",
            properties: {
              total: { type: "integer" },
              results: {
                type: "array",
                items: {
                  allOf: [
                    ref("Scene"),
                    {
                      type: "object",
                      properties: {
                        snippet: {
                          type: "object",
                          nullable: true,
                          properties: {
                            kind: {
                              type: "string",
                              enum: ["drawing", "comment"],
                            },
                            text: { type: "string" },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
          ...errors,
        },
      },
    },
    "/export": {
      get: {
        summary:
          "ZIP mit allen sichtbaren Szenen eines Workspaces oder einer Collection (.excalidraw mit Bildern, manifest.json)",
        parameters: [
          {
            name: "workspace",
            in: "query",
            description: "ID oder Kurzname; ohne: der allgemeine Workspace",
            schema: { type: "string" },
          },
          { name: "collection", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ZIP-Datei",
            content: {
              "application/zip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          ...errors,
        },
      },
    },
  },
});
