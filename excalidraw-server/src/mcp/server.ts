/**
 * MCP server (Model Context Protocol) for AI assistants, at /mcp: Streamable
 * HTTP, stateless, signed in with a personal API token. Every tool acts with
 * the rights of the token's person; read tokens can only use reading tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { apiRateLimit } from "../api/routes.js";
import { describeElements } from "../api/operations.js";
import {
  diagramSpec,
  idList,
  SKELETON_TYPES,
  skeletonList,
  updateList,
} from "../api/validate.js";
import { HttpError } from "../util/http.js";
import { actorOf } from "../workspace/access.js";
import { cleanName } from "../workspace/service.js";

import type { SceneOperations } from "../api/operations.js";
import type { AuthContext } from "../auth/sessions.js";
import type { AppContext } from "../context.js";
import type { CommentService } from "../workspace/comments.js";
import type { WorkspaceService } from "../workspace/service.js";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

const INSTRUCTIONS = `Excalidraw workspace of the company intranet: hand-drawn style diagrams ("scenes") in collections, shared with colleagues.

- Find scenes with search_scenes, read them with get_scene (shapes with labels, arrows with what they connect).
- For flowcharts, processes, org charts, architectures: create_diagram with nodes and edges; the server lays them out and binds the arrows. Add it to an existing scene with sceneId, or create a new scene with name.
- For free placement use add_elements (element skeletons: rectangle/ellipse/diamond with "label", "text", "arrow" with start/end ids, "frame").
- Change labels, colors, positions with update_elements; delete with delete_elements. Element ids come from get_scene or from earlier results.
- People who have a scene open see every change immediately.
- Write labels and comments in the language the user writes in. Every result contains the scene URL; share it with the user.`;

const fillStyle = z.enum(["hachure", "cross-hatch", "solid", "zigzag"]);
const strokeStyle = z.enum(["solid", "dashed", "dotted"]);

const skeleton = z.object({
  type: z.enum(SKELETON_TYPES),
  id: z
    .string()
    .optional()
    .describe(
      "your own id, to connect arrows to this element in the same call",
    ),
  x: z
    .number()
    .optional()
    .describe("left, in scene pixels (not needed for bound arrows)"),
  y: z.number().optional().describe("top, in scene pixels"),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional().describe('only for type "text"'),
  label: z
    .object({ text: z.string(), fontSize: z.number().optional() })
    .optional()
    .describe("text inside a shape or on an arrow"),
  start: z
    .object({ id: z.string() })
    .optional()
    .describe("arrow/line: id of the element it starts at (new or existing)"),
  end: z
    .object({ id: z.string() })
    .optional()
    .describe("arrow/line: id of the element it points to (new or existing)"),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe("unbound line/arrow: points relative to x/y"),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: fillStyle.optional(),
  strokeStyle: strokeStyle.optional(),
  strokeWidth: z.number().optional(),
  roughness: z
    .number()
    .optional()
    .describe("0 = clean, 1 = hand-drawn (default), 2 = sketchy"),
  opacity: z.number().optional(),
  fontSize: z.number().optional(),
  children: z
    .array(z.string())
    .optional()
    .describe("frame: ids of the elements inside"),
  name: z.string().optional().describe("frame: title"),
});

const elementUpdate = z.object({
  id: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z
    .string()
    .optional()
    .describe("new text, or new label of a shape/arrow"),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: fillStyle.optional(),
  strokeStyle: strokeStyle.optional(),
  strokeWidth: z.number().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  fontSize: z.number().optional(),
  link: z.string().nullable().optional(),
});

const diagramNode = z.object({
  id: z.string().describe("short id, used by edges"),
  label: z.string(),
  shape: z
    .enum(["rectangle", "ellipse", "diamond"])
    .optional()
    .describe("diamond for decisions, ellipse for start/end"),
  backgroundColor: z
    .string()
    .optional()
    .describe(
      'e.g. "#a5d8ff" (blue), "#b2f2bb" (green), "#ffec99" (yellow), "#ffc9c9" (red)',
    ),
  strokeColor: z.string().optional(),
});

const diagramEdge = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  strokeStyle: strokeStyle.optional(),
});

type Tool = Parameters<McpServer["registerTool"]>[2];

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }],
});

const failure = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

export const createMcpServer = (
  services: {
    workspace: WorkspaceService;
    operations: SceneOperations;
    comments: CommentService;
  },
  auth: AuthContext,
) => {
  const { workspace, operations, comments } = services;
  const actor = actorOf(auth.user);
  const canWrite = auth.token?.scope === "write";
  const server = new McpServer(
    { name: "excalidraw-intranet", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  /** errors become tool results the model can read and react to */
  const tool =
    <Args>(write: boolean, run: (args: Args) => Promise<unknown>) =>
    async (args: Args) => {
      if (write && !canWrite) {
        return failure(
          "This API token is read-only. Ask the user for a token with write access.",
        );
      }
      try {
        return result(await run(args));
      } catch (error) {
        if (error instanceof HttpError) {
          return failure(
            `${error.message}${
              error.extra?.ids
                ? ` (${(error.extra.ids as string[]).join(", ")})`
                : ""
            }`,
          );
        }
        throw error;
      }
    };

  const sceneLink = async (sceneId: string) => {
    const access = await workspace.sceneFor(actor, sceneId, "viewer");
    return {
      id: access.scene.id,
      name: access.scene.name,
      url: workspace.sceneUrl(access.scene.id),
    };
  };

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        'Collections (folders) the user can access, with their role and number of scenes. "personal" is the user\'s private collection.',
      annotations: { readOnlyHint: true },
    },
    tool(false, async () => ({
      collections: await workspace.listCollections(actor),
    })) as Tool,
  );

  server.registerTool(
    "search_scenes",
    {
      title: "Search scenes",
      description:
        "Find scenes (drawings) by name, newest first. Without query: the most recently changed scenes.",
      inputSchema: {
        query: z.string().optional(),
        collectionId: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(
      false,
      async (args: { query?: string; collectionId?: string; limit?: number }) =>
        workspace.listScenes(actor, {
          query: args.query?.trim().slice(0, 100) || undefined,
          collectionId: args.collectionId,
          limit: args.limit ?? 20,
          offset: 0,
        }),
    ) as Tool,
  );

  server.registerTool(
    "get_scene",
    {
      title: "Read a scene",
      description:
        "A scene's metadata and its drawing: shapes with their labels, arrows with the ids they connect (from/to), free text, frames. Coordinates in scene pixels, y grows downwards.",
      inputSchema: { sceneId: z.string() },
      annotations: { readOnlyHint: true },
    },
    tool(false, async (args: { sceneId: string }) => {
      const access = await workspace.sceneFor(actor, args.sceneId, "viewer");
      const { elements, revision } = workspace.readContent(access);
      return {
        scene: { ...(await workspace.describeAccess(access)), revision },
        drawing: describeElements(elements),
      };
    }) as Tool,
  );

  server.registerTool(
    "create_scene",
    {
      title: "Create a scene",
      description:
        "Create an empty scene (in the user's personal collection unless collectionId is given). For a diagram use create_diagram instead.",
      inputSchema: {
        name: z.string(),
        collectionId: z.string().optional(),
      },
    },
    tool(true, async (args: { name: string; collectionId?: string }) => {
      const { scene } = await workspace.createScene(actor, {
        name: cleanName(args.name) || "Unbenannte Szene",
        collectionId: args.collectionId,
      });
      return { scene: await sceneLink(scene.id) };
    }) as Tool,
  );

  server.registerTool(
    "create_diagram",
    {
      title: "Create a diagram",
      description:
        "Lay out a diagram from nodes and edges (flowchart, process, dependencies, org chart) and draw it with labelled shapes and bound arrows. With sceneId it is added next to the existing drawing, otherwise a new scene named `name` is created. Returns the element id of every node.",
      inputSchema: {
        sceneId: z.string().optional(),
        name: z
          .string()
          .optional()
          .describe("name of the new scene (without sceneId)"),
        collectionId: z.string().optional(),
        direction: z
          .enum(["TB", "LR"])
          .optional()
          .describe("TB = top to bottom (default), LR = left to right"),
        nodes: z.array(diagramNode).min(1).max(500),
        edges: z.array(diagramEdge).max(2000).optional(),
      },
    },
    tool(
      true,
      async (args: {
        sceneId?: string;
        name?: string;
        collectionId?: string;
        direction?: "TB" | "LR";
        nodes: unknown[];
        edges?: unknown[];
      }) => {
        const spec = diagramSpec({
          nodes: args.nodes,
          edges: args.edges ?? [],
          direction: args.direction,
        });
        const sceneId =
          args.sceneId ||
          (
            await workspace.createScene(actor, {
              name: cleanName(args.name) || "Diagramm",
              collectionId: args.collectionId,
            })
          ).scene.id;
        const added = await operations.addDiagram(actor, sceneId, spec);
        return {
          scene: await sceneLink(sceneId),
          nodes: added.nodes,
          elementCount: added.created.length,
        };
      },
    ) as Tool,
  );

  server.registerTool(
    "add_elements",
    {
      title: "Add elements",
      description:
        "Add shapes, text, arrows and frames to a scene, in the editor's skeleton format. Shapes get text with label.text. Arrows connect elements with start.id/end.id: ids of elements in this call or already in the scene. Returns the created elements with their final ids.",
      inputSchema: {
        sceneId: z.string(),
        elements: z.array(skeleton).min(1).max(2000),
      },
    },
    tool(true, async (args: { sceneId: string; elements: unknown[] }) => {
      const added = await operations.addElements(
        actor,
        args.sceneId,
        skeletonList(args.elements),
      );
      return { scene: await sceneLink(args.sceneId), created: added.created };
    }) as Tool,
  );

  server.registerTool(
    "update_elements",
    {
      title: "Change elements",
      description:
        "Change elements by id: text or label, position (labels and arrows follow), size, colors, style.",
      inputSchema: {
        sceneId: z.string(),
        updates: z.array(elementUpdate).min(1).max(2000),
      },
    },
    tool(true, async (args: { sceneId: string; updates: unknown[] }) => {
      const changed = await operations.update(
        actor,
        args.sceneId,
        updateList(args.updates),
      );
      return { scene: await sceneLink(args.sceneId), changed: changed.changed };
    }) as Tool,
  );

  server.registerTool(
    "delete_elements",
    {
      title: "Delete elements",
      description:
        "Delete elements by id, with their labels. Arrows that pointed at them stay, unbound.",
      inputSchema: {
        sceneId: z.string(),
        ids: z.array(z.string()).min(1).max(2000),
      },
      annotations: { destructiveHint: true },
    },
    tool(true, async (args: { sceneId: string; ids: string[] }) => {
      const removed = await operations.remove(
        actor,
        args.sceneId,
        idList(args.ids),
      );
      return {
        scene: await sceneLink(args.sceneId),
        changed: removed.changed.length,
      };
    }) as Tool,
  );

  server.registerTool(
    "update_scene",
    {
      title: "Rename or move a scene",
      description: "Rename a scene, or move it into another collection.",
      inputSchema: {
        sceneId: z.string(),
        name: z.string().optional(),
        collectionId: z.string().optional(),
      },
    },
    tool(
      true,
      async (args: {
        sceneId: string;
        name?: string;
        collectionId?: string;
      }) => ({
        scene: await workspace.updateScene(actor, args.sceneId, {
          name: args.name,
          collectionId: args.collectionId,
        }),
      }),
    ) as Tool,
  );

  server.registerTool(
    "list_comments",
    {
      title: "Read comments",
      description:
        "Comment threads of a scene with their replies. A thread is pinned to an element (elementId, x/y relative to it) or to a point.",
      inputSchema: {
        sceneId: z.string(),
        status: z.enum(["open", "resolved", "all"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    tool(
      false,
      async (args: {
        sceneId: string;
        status?: "open" | "resolved" | "all";
      }) => ({
        threads: await comments.list(
          actor,
          args.sceneId,
          args.status ?? "open",
        ),
      }),
    ) as Tool,
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment",
      description:
        "Write a comment: as a new thread pinned to an element (elementId) or a point (x, y), or as a reply to a thread (threadId).",
      inputSchema: {
        sceneId: z.string(),
        text: z.string(),
        elementId: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        threadId: z.string().optional().describe("reply to this thread"),
      },
    },
    tool(
      true,
      async (args: {
        sceneId: string;
        text: string;
        elementId?: string;
        x?: number;
        y?: number;
        threadId?: string;
      }) => {
        if (args.threadId) {
          return {
            thread: await comments.reply(actor, args.threadId, {
              text: args.text,
            }),
          };
        }
        let position = { x: args.x, y: args.y };
        if (args.elementId && (args.x === undefined || args.y === undefined)) {
          // the element's top right corner
          const access = await workspace.sceneFor(
            actor,
            args.sceneId,
            "viewer",
          );
          const element = workspace
            .readContent(access)
            .elements.find((el) => el.id === args.elementId && !el.isDeleted);
          if (!element) {
            throw new HttpError(
              404,
              "unknown_element",
              `Unknown element ${args.elementId}`,
            );
          }
          position = { x: element.width, y: 0 };
        }
        return {
          thread: await comments.createThread(actor, args.sceneId, {
            text: args.text,
            elementId: args.elementId,
            ...position,
          }),
        };
      },
    ) as Tool,
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment thread",
      description: "Mark a comment thread as resolved, or open it again.",
      inputSchema: {
        threadId: z.string(),
        resolved: z.boolean().optional(),
      },
    },
    tool(true, async (args: { threadId: string; resolved?: boolean }) => ({
      thread: await comments.setResolved(
        actor,
        args.threadId,
        args.resolved ?? true,
      ),
    })) as Tool,
  );

  return server;
};

export const registerMcp = (
  app: FastifyInstance,
  ctx: AppContext,
  services: {
    workspace: WorkspaceService;
    operations: SceneOperations;
    comments: CommentService;
  },
  requireToken: preHandlerHookHandler,
) => {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    const server = createMcpServer(services, request.auth!);
    // stateless: one server and transport per request, answers as JSON
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
    }
  };

  app.post(
    "/mcp",
    {
      preHandler: requireToken,
      config: apiRateLimit(ctx),
      bodyLimit: 10 * 1024 * 1024,
    },
    handle,
  );
  // stateless server: no event stream to open, no session to end
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
};
