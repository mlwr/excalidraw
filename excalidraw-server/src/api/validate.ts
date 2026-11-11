/** input checks for the REST API and the MCP server */
import { HttpError } from "../util/http.js";
import { queryParam } from "../util/validate.js";

import type {
  DiagramSpec,
  ElementUpdate,
  Skeleton,
} from "../../vendor/elements.mjs";

const bad = (code: string, message: string) =>
  new HttpError(400, code, message);

/** plain JSON of bounded size and depth with finite numbers */
export const isSaneJson = (value: unknown, depth = 0): boolean => {
  if (depth > 16) {
    return false;
  }
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) && Math.abs(value) <= 1e12;
    case "string":
      return value.length <= 100_000;
    case "boolean":
    case "undefined": // optional fields left out by schema validation
      return true;
    case "object":
      if (value === null) {
        return true;
      }
      if (Array.isArray(value)) {
        return (
          value.length <= 100_000 &&
          value.every((item) => isSaneJson(item, depth + 1))
        );
      }
      return (
        Object.keys(value).length <= 300 &&
        Object.values(value).every((item) => isSaneJson(item, depth + 1))
      );
    default:
      return false;
  }
};

export const pagination = (query: Record<string, unknown>) => {
  const limit = Number(queryParam(query.limit) ?? 50);
  const offset = Number(queryParam(query.offset) ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw bad("invalid_limit", "limit muss zwischen 1 und 100 liegen.");
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw bad("invalid_offset", "offset muss 0 oder größer sein.");
  }
  return { limit, offset };
};

export const sortOf = (value: unknown) => {
  const sort = queryParam(value) ?? "updated";
  if (sort !== "updated" && sort !== "created" && sort !== "name") {
    throw bad("invalid_sort", "sort ist updated, created oder name.");
  }
  return sort;
};

/** element types that can be created from skeletons */
export const SKELETON_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "frame",
] as const;

const NEEDS_POSITION = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "frame",
]);
const MAX_ELEMENTS = 2000;

export const skeletonList = (value: unknown): Skeleton[] => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ELEMENTS) {
    throw bad(
      "invalid_elements",
      `elements: eine Liste mit 1 bis ${MAX_ELEMENTS} Elementen.`,
    );
  }
  value.forEach((item, index) => {
    const where = `elements[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw bad("invalid_elements", `${where}: ein Objekt erwartet.`);
    }
    if (!isSaneJson(item)) {
      throw bad("invalid_elements", `${where}: ungültige Werte.`);
    }
    const type = (item as { type?: unknown }).type;
    if (!SKELETON_TYPES.includes(type as typeof SKELETON_TYPES[number])) {
      throw bad(
        "invalid_elements",
        `${where}: type muss einer von ${SKELETON_TYPES.join(", ")} sein.`,
      );
    }
    const { x, y } = item as { x?: unknown; y?: unknown };
    if (
      NEEDS_POSITION.has(type as string) &&
      (typeof x !== "number" || typeof y !== "number")
    ) {
      throw bad("invalid_elements", `${where}: x und y fehlen.`);
    }
    if (
      type === "text" &&
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      throw bad("invalid_elements", `${where}: text fehlt.`);
    }
    if (
      type === "frame" &&
      !Array.isArray((item as { children?: unknown }).children)
    ) {
      Object.assign(item, { children: [] });
    }
    const id = (item as { id?: unknown }).id;
    if (
      id !== undefined &&
      (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id))
    ) {
      throw bad(
        "invalid_elements",
        `${where}: id darf nur Buchstaben, Ziffern, _ und - enthalten.`,
      );
    }
  });
  return value as Skeleton[];
};

/** full elements as in an .excalidraw file */
export const elementList = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 50_000) {
    throw bad(
      "invalid_elements",
      "elements: eine Liste von Elementen erwartet.",
    );
  }
  value.forEach((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { id?: unknown }).id !== "string" ||
      typeof (item as { type?: unknown }).type !== "string" ||
      !isSaneJson(item)
    ) {
      throw bad(
        "invalid_elements",
        `elements[${index}]: kein gültiges Element.`,
      );
    }
  });
  return value;
};

const STYLE_ENUMS: Record<string, readonly string[]> = {
  fillStyle: ["hachure", "cross-hatch", "solid", "zigzag"],
  strokeStyle: ["solid", "dashed", "dotted"],
};
const COLOR_RE = /^(transparent|#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/;

export const updateList = (value: unknown): ElementUpdate[] => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ELEMENTS) {
    throw bad("invalid_updates", "updates: eine nicht leere Liste erwartet.");
  }
  return value.map((item, index) => {
    const where = `updates[${index}]`;
    if (!item || typeof item !== "object" || !isSaneJson(item)) {
      throw bad("invalid_updates", `${where}: ein Objekt erwartet.`);
    }
    const update = item as Record<string, unknown>;
    if (typeof update.id !== "string") {
      throw bad("invalid_updates", `${where}: id fehlt.`);
    }
    const result: Record<string, unknown> = { id: update.id };
    for (const key of ["x", "y", "width", "height"]) {
      if (update[key] !== undefined) {
        if (typeof update[key] !== "number") {
          throw bad("invalid_updates", `${where}: ${key} muss eine Zahl sein.`);
        }
        if (
          (key === "width" || key === "height") &&
          (update[key] as number) <= 0
        ) {
          throw bad(
            "invalid_updates",
            `${where}: ${key} muss größer als 0 sein.`,
          );
        }
        result[key] = update[key];
      }
    }
    if (update.text !== undefined) {
      if (typeof update.text !== "string" || update.text.length > 10_000) {
        throw bad("invalid_updates", `${where}: text ungültig.`);
      }
      result.text = update.text;
    }
    for (const key of ["strokeColor", "backgroundColor"]) {
      if (update[key] !== undefined) {
        if (
          typeof update[key] !== "string" ||
          !COLOR_RE.test(update[key] as string)
        ) {
          throw bad("invalid_updates", `${where}: ${key} ist keine Farbe.`);
        }
        result[key] = update[key];
      }
    }
    for (const [key, allowed] of Object.entries(STYLE_ENUMS)) {
      if (update[key] !== undefined) {
        if (!allowed.includes(update[key] as string)) {
          throw bad(
            "invalid_updates",
            `${where}: ${key} ist einer von ${allowed.join(", ")}.`,
          );
        }
        result[key] = update[key];
      }
    }
    const ranges: Record<string, [number, number]> = {
      strokeWidth: [0.5, 32],
      roughness: [0, 2],
      opacity: [0, 100],
      fontSize: [4, 400],
    };
    for (const [key, [min, max]] of Object.entries(ranges)) {
      if (update[key] !== undefined) {
        const number = update[key];
        if (typeof number !== "number" || number < min || number > max) {
          throw bad(
            "invalid_updates",
            `${where}: ${key} liegt zwischen ${min} und ${max}.`,
          );
        }
        result[key] = number;
      }
    }
    if (update.link !== undefined) {
      if (
        update.link !== null &&
        (typeof update.link !== "string" || update.link.length > 2000)
      ) {
        throw bad("invalid_updates", `${where}: link ungültig.`);
      }
      result.link = update.link;
    }
    return result as unknown as ElementUpdate;
  });
};

export const idList = (value: unknown): string[] => {
  const ids =
    typeof value === "string"
      ? value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : value;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > MAX_ELEMENTS ||
    ids.some((id) => typeof id !== "string" || id.length > 64)
  ) {
    throw bad("invalid_ids", "ids: eine Liste von Element-IDs erwartet.");
  }
  return ids;
};

export const diagramSpec = (value: unknown): DiagramSpec => {
  const spec = (value || {}) as Record<string, unknown>;
  if (!isSaneJson(spec)) {
    throw bad("invalid_diagram", "Ungültiges Diagramm.");
  }
  const nodes = spec.nodes;
  const edges = spec.edges ?? [];
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 500) {
    throw bad("invalid_diagram", "nodes: 1 bis 500 Knoten erwartet.");
  }
  if (!Array.isArray(edges) || edges.length > 2000) {
    throw bad("invalid_diagram", "edges: eine Liste erwartet.");
  }
  const ids = new Set<string>();
  const shapes = ["rectangle", "ellipse", "diamond"];
  nodes.forEach((node: any, index) => {
    if (
      !node ||
      typeof node.id !== "string" ||
      !/^[\w-]{1,64}$/.test(node.id) ||
      ids.has(node.id)
    ) {
      throw bad("invalid_diagram", `nodes[${index}]: eindeutige id erwartet.`);
    }
    if (typeof node.label !== "string" || node.label.length > 2000) {
      throw bad("invalid_diagram", `nodes[${index}]: label erwartet.`);
    }
    if (node.shape !== undefined && !shapes.includes(node.shape)) {
      throw bad(
        "invalid_diagram",
        `nodes[${index}]: shape ist rectangle, ellipse oder diamond.`,
      );
    }
    for (const key of ["backgroundColor", "strokeColor"]) {
      if (node[key] !== undefined && !COLOR_RE.test(String(node[key]))) {
        throw bad(
          "invalid_diagram",
          `nodes[${index}]: ${key} ist keine Farbe.`,
        );
      }
    }
    ids.add(node.id);
  });
  edges.forEach((edge: any, index) => {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) {
      throw bad(
        "invalid_diagram",
        `edges[${index}]: from und to müssen Knoten-ids sein.`,
      );
    }
    if (
      edge.label !== undefined &&
      (typeof edge.label !== "string" || edge.label.length > 500)
    ) {
      throw bad("invalid_diagram", `edges[${index}]: label ungültig.`);
    }
    if (
      edge.strokeStyle !== undefined &&
      !STYLE_ENUMS.strokeStyle.includes(edge.strokeStyle)
    ) {
      throw bad("invalid_diagram", `edges[${index}]: strokeStyle ungültig.`);
    }
  });
  const direction = spec.direction ?? "TB";
  if (direction !== "TB" && direction !== "LR") {
    throw bad("invalid_diagram", "direction ist TB oder LR.");
  }
  return {
    nodes: nodes.map((node: any) => ({
      id: node.id,
      label: node.label,
      shape: node.shape,
      backgroundColor: node.backgroundColor,
      strokeColor: node.strokeColor,
    })),
    edges: edges.map((edge: any) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      strokeStyle: edge.strokeStyle,
    })),
    direction,
  };
};
