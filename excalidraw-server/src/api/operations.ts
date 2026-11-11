/**
 * Scene operations shared by the REST API and the MCP server, on top of the
 * workspace service and the editor's element logic (vendor/elements.mjs).
 */
import {
  addSkeletons,
  deleteElements,
  diagramSkeletons,
  replaceAll,
  UnknownElementError,
  updateElements,
} from "../../vendor/elements.mjs";
import { randomToken } from "../util/crypto.js";
import { HttpError } from "../util/http.js";

import type {
  Change,
  DiagramSpec,
  ElementUpdate,
  SceneElement,
  Skeleton,
} from "../../vendor/elements.mjs";
import type { Actor } from "../workspace/access.js";
import type { WorkspaceService } from "../workspace/service.js";

const round = (value: unknown) =>
  typeof value === "number" ? Math.round(value * 10) / 10 : value;

const bindingId = (binding: unknown) =>
  binding && typeof binding === "object"
    ? (binding as { elementId?: string }).elementId ?? null
    : null;

/** what callers need to know about an element */
export const summarize = (element: SceneElement) => ({
  id: element.id,
  type: element.type,
  x: round(element.x),
  y: round(element.y),
  width: round(element.width),
  height: round(element.height),
  ...(typeof element.text === "string" ? { text: element.text } : {}),
  ...(element.containerId ? { containerId: element.containerId } : {}),
  ...(element.type === "arrow" || element.type === "line"
    ? {
        start: bindingId(element.startBinding),
        end: bindingId(element.endBinding),
      }
    : {}),
  ...(element.isDeleted ? { isDeleted: true } : {}),
});

/**
 * The drawing as a language model reads it best: shapes with their labels,
 * arrows with what they connect, free text, frames. Labels are folded into
 * their shapes.
 */
export const describeElements = (
  elements: readonly SceneElement[],
  limit = 500,
) => {
  const live = elements.filter((element) => !element.isDeleted);
  const byId = new Map(live.map((element) => [element.id, element]));
  const labelOf = (element: SceneElement) => {
    const bound = (element.boundElements || []).find(
      (entry) => entry.type === "text",
    );
    const text = bound ? byId.get(bound.id) : undefined;
    return typeof text?.text === "string" ? text.text : undefined;
  };
  const items = live
    .filter((element) => !(element.type === "text" && element.containerId))
    .map((element) => {
      const base: Record<string, unknown> = {
        id: element.id,
        type: element.type,
        x: Math.round(element.x),
        y: Math.round(element.y),
        width: Math.round(element.width),
        height: Math.round(element.height),
      };
      if (element.type === "text") {
        base.text = element.text;
      } else {
        const label = labelOf(element);
        if (label !== undefined) {
          base.label = label;
        }
      }
      if (element.type === "arrow" || element.type === "line") {
        const from = bindingId(element.startBinding);
        const to = bindingId(element.endBinding);
        if (from) {
          base.from = from;
        }
        if (to) {
          base.to = to;
        }
      }
      if (element.type === "frame" && element.name) {
        base.name = element.name;
      }
      if (element.frameId) {
        base.frameId = element.frameId;
      }
      for (const key of ["strokeColor", "backgroundColor"] as const) {
        const value = element[key];
        if (
          typeof value === "string" &&
          value !== "transparent" &&
          value !== "#1e1e1e" &&
          value !== "#000000"
        ) {
          base[key] = value;
        }
      }
      if (typeof element.link === "string" && element.link) {
        base.link = element.link;
      }
      return base;
    });

  const bounds = live.length
    ? {
        minX: Math.round(Math.min(...live.map((el) => el.x))),
        minY: Math.round(Math.min(...live.map((el) => el.y))),
        maxX: Math.round(Math.max(...live.map((el) => el.x + el.width))),
        maxY: Math.round(Math.max(...live.map((el) => el.y + el.height))),
      }
    : null;
  return {
    elementCount: items.length,
    bounds,
    truncated: items.length > limit,
    elements: items.slice(0, limit),
  };
};

/** errors of the element logic are the caller's (bad elements) */
const guarded =
  (change: (elements: SceneElement[]) => Change) =>
  (elements: SceneElement[]) => {
    try {
      return change(elements);
    } catch (error) {
      if (error instanceof UnknownElementError) {
        throw new HttpError(404, "unknown_element", error.message, {
          ids: error.ids,
        });
      }
      throw new HttpError(
        400,
        "invalid_elements",
        `Die Elemente lassen sich nicht übernehmen: ${String(
          (error as Error)?.message || error,
        ).slice(0, 300)}`,
      );
    }
  };

const createdIn = (before: readonly SceneElement[], result: Change) => {
  const known = new Set(before.map((element) => element.id));
  return result.changed.filter((element) => !known.has(element.id));
};

export const createSceneOperations = (workspace: WorkspaceService) => {
  const addElements = async (
    actor: Actor,
    sceneId: string,
    skeletons: Skeleton[],
  ) => {
    let created: SceneElement[] = [];
    const result = await workspace.changeContent(
      actor,
      sceneId,
      guarded((elements) => {
        const change = addSkeletons(elements, skeletons);
        created = createdIn(elements, change);
        return change;
      }),
    );
    return {
      revision: result.revision,
      created: created.map(summarize),
      changed: result.changed.map(summarize),
    };
  };

  /** a laid out diagram, placed right of what is already there */
  const addDiagram = async (
    actor: Actor,
    sceneId: string,
    spec: DiagramSpec,
  ) => {
    // fresh element ids for the node ids the caller chose
    const prefix = randomToken(6);
    const ids = new Map(
      spec.nodes.map((node) => [node.id, `${prefix}-${node.id}`]),
    );
    let created: SceneElement[] = [];
    const result = await workspace.changeContent(
      actor,
      sceneId,
      guarded((elements) => {
        const live = elements.filter((element) => !element.isDeleted);
        const origin = live.length
          ? {
              x: Math.max(...live.map((el) => el.x + el.width)) + 200,
              y: Math.min(...live.map((el) => el.y)),
            }
          : { x: 0, y: 0 };
        const change = addSkeletons(
          elements,
          diagramSkeletons({
            ...spec,
            origin,
            nodes: spec.nodes.map((node) => ({
              ...node,
              id: ids.get(node.id)!,
            })),
            edges: spec.edges.map((edge) => ({
              ...edge,
              from: ids.get(edge.from)!,
              to: ids.get(edge.to)!,
            })),
          }),
        );
        created = createdIn(elements, change);
        return change;
      }),
    );
    return {
      revision: result.revision,
      nodes: Object.fromEntries(ids),
      created: created.map(summarize),
    };
  };

  const update = async (
    actor: Actor,
    sceneId: string,
    updates: ElementUpdate[],
  ) => {
    const result = await workspace.changeContent(
      actor,
      sceneId,
      guarded((elements) => updateElements(elements, updates)),
    );
    return {
      revision: result.revision,
      changed: result.changed.map(summarize),
    };
  };

  const remove = async (actor: Actor, sceneId: string, ids: string[]) => {
    const result = await workspace.changeContent(
      actor,
      sceneId,
      guarded((elements) => deleteElements(elements, ids)),
    );
    return {
      revision: result.revision,
      changed: result.changed.map(summarize),
    };
  };

  /** replace the drawing (import); image files first, so editors find them */
  const replace = async (
    actor: Actor,
    sceneId: string,
    input: {
      elements: unknown[];
      files?: unknown;
      expectedRevision?: number | null;
    },
  ) => {
    const access = await workspace.sceneFor(actor, sceneId, "editor");
    const { key } = workspace.readContent(access);
    const storedFiles = await workspace.storeFiles(
      access.scene.id,
      key,
      input.files,
      actor.id,
    );
    const result = await workspace.changeContent(
      actor,
      sceneId,
      guarded((elements) => replaceAll(elements, input.elements)),
      { expectedRevision: input.expectedRevision },
    );
    return {
      revision: result.revision,
      changedElements: result.changed.length,
      storedFiles,
    };
  };

  return { addElements, addDiagram, update, remove, replace };
};

export type SceneOperations = ReturnType<typeof createSceneOperations>;
