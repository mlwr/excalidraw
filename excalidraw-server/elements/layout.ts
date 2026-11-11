/**
 * Layered layout for diagrams described as nodes and edges (what language
 * models produce well): ranks along the flow, few crossings, sizes from the
 * measured labels. The result are element skeletons; the editor's own
 * conversion then binds the arrows to the shapes.
 */
import { getFontString } from "@excalidraw/common";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

export interface DiagramNode {
  id: string;
  label: string;
  shape?: "rectangle" | "ellipse" | "diamond";
  backgroundColor?: string;
  strokeColor?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
}

export interface DiagramSpec {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** TB: top to bottom (default), LR: left to right */
  direction?: "TB" | "LR";
  /** top left corner of the diagram in the scene */
  origin?: { x: number; y: number };
}

const FONT_SIZE = 20;
const FONT_FAMILY = 5; // Excalifont, the editor's default
const PADDING_X = 32;
const MIN_WIDTH = 140;
const MAX_WIDTH = 320;
const HEIGHT = 80;
const GAP_IN_RANK = 80;
const GAP_BETWEEN_RANKS = 120;
// diamonds and ellipses need more room for the same label
const SHAPE_FACTOR = { rectangle: 1, ellipse: 1.25, diamond: 1.5 };

type Measure = (text: string, fontString: string) => number;

const nodeSize = (node: DiagramNode, measure: Measure) => {
  const font = getFontString({ fontSize: FONT_SIZE, fontFamily: FONT_FAMILY });
  const textWidth = Math.max(
    ...node.label.split("\n").map((line) => measure(line, font)),
  );
  const factor = SHAPE_FACTOR[node.shape || "rectangle"];
  const width = Math.min(
    MAX_WIDTH * factor,
    Math.max(MIN_WIDTH, textWidth + 2 * PADDING_X) * factor,
  );
  // long labels wrap; the editor's conversion grows the height as needed
  return { width: Math.round(width), height: Math.round(HEIGHT * factor) };
};

/** reverse edges that close a cycle, so the rest can be ranked */
const acyclic = (ids: string[], edges: DiagramEdge[]) => {
  const out = new Map(ids.map((id) => [id, [] as string[]]));
  edges.forEach((edge) => out.get(edge.from)!.push(edge.to));
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id)!) {
      if (state.get(next) === 1) {
        back.add(`${id}\u0000${next}`);
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    state.set(id, 2);
  };
  ids.forEach((id) => !state.has(id) && visit(id));
  return edges.map((edge) =>
    back.has(`${edge.from}\u0000${edge.to}`)
      ? { from: edge.to, to: edge.from }
      : { from: edge.from, to: edge.to },
  );
};

export const layoutDiagram = (
  spec: DiagramSpec,
  measure: Measure,
): ExcalidrawElementSkeleton[] => {
  const ids = spec.nodes.map((node) => node.id);
  const edges = spec.edges.filter((edge) => edge.from !== edge.to);
  const dag = acyclic(ids, edges);

  // rank: longest path from the sources
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  dag.forEach((edge) => incoming.get(edge.to)!.push(edge.from));
  const rank = new Map<string, number>();
  const rankOf = (id: string, seen = new Set<string>()): number => {
    if (rank.has(id)) {
      return rank.get(id)!;
    }
    seen.add(id);
    const preds = incoming.get(id)!.filter((pred) => !seen.has(pred));
    const value = preds.length
      ? Math.max(...preds.map((pred) => rankOf(pred, seen) + 1))
      : 0;
    rank.set(id, value);
    return value;
  };
  ids.forEach((id) => rankOf(id));

  const ranks: string[][] = [];
  ids.forEach((id) => (ranks[rank.get(id)!] ||= []).push(id));
  for (let i = 0; i < ranks.length; i++) {
    ranks[i] ||= [];
  }

  // order within ranks: barycenters of the neighbours, a few sweeps
  const neighbours = new Map(ids.map((id) => [id, [] as string[]]));
  dag.forEach((edge) => {
    neighbours.get(edge.from)!.push(edge.to);
    neighbours.get(edge.to)!.push(edge.from);
  });
  const position = new Map<string, number>();
  const remember = () =>
    ranks.forEach((rankIds) =>
      rankIds.forEach((id, index) => position.set(id, index)),
    );
  remember();
  for (let sweep = 0; sweep < 8; sweep++) {
    const order =
      sweep % 2 === 0
        ? ranks.keys()
        : [...ranks.keys()].reverse()[Symbol.iterator]();
    for (const r of order) {
      const adjacent = sweep % 2 === 0 ? r - 1 : r + 1;
      const center = (id: string) => {
        const linked = neighbours
          .get(id)!
          .filter((other) => rank.get(other) === adjacent);
        return linked.length
          ? linked.reduce((sum, other) => sum + position.get(other)!, 0) /
              linked.length
          : position.get(id)!;
      };
      ranks[r].sort((a, b) => center(a) - center(b));
      ranks[r].forEach((id, index) => position.set(id, index));
    }
  }

  // coordinates: ranks along the flow, centred across it
  const horizontal = spec.direction === "LR";
  const origin = spec.origin || { x: 0, y: 0 };
  const sizes = new Map(
    spec.nodes.map((node) => [node.id, nodeSize(node, measure)]),
  );
  const along = (id: string) =>
    horizontal ? sizes.get(id)!.width : sizes.get(id)!.height;
  const across = (id: string) =>
    horizontal ? sizes.get(id)!.height : sizes.get(id)!.width;
  const rankDepth = ranks.map((rankIds) => Math.max(0, ...rankIds.map(along)));
  const rankBreadth = ranks.map((rankIds) =>
    rankIds.reduce(
      (sum, id, index) => sum + across(id) + (index ? GAP_IN_RANK : 0),
      0,
    ),
  );
  const breadth = Math.max(0, ...rankBreadth);

  const placed = new Map<string, { x: number; y: number }>();
  let offsetAlong = 0;
  ranks.forEach((rankIds, r) => {
    let offsetAcross = (breadth - rankBreadth[r]) / 2;
    for (const id of rankIds) {
      const centeredAlong = offsetAlong + (rankDepth[r] - along(id)) / 2;
      placed.set(
        id,
        horizontal
          ? { x: origin.x + centeredAlong, y: origin.y + offsetAcross }
          : { x: origin.x + offsetAcross, y: origin.y + centeredAlong },
      );
      offsetAcross += across(id) + GAP_IN_RANK;
    }
    offsetAlong += rankDepth[r] + GAP_BETWEEN_RANKS;
  });

  const shapes: ExcalidrawElementSkeleton[] = spec.nodes.map((node) => {
    const { x, y } = placed.get(node.id)!;
    const { width, height } = sizes.get(node.id)!;
    return {
      type: node.shape || "rectangle",
      id: node.id,
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
      ...(node.backgroundColor
        ? { backgroundColor: node.backgroundColor, fillStyle: "solid" }
        : {}),
      ...(node.strokeColor ? { strokeColor: node.strokeColor } : {}),
      ...((node.shape || "rectangle") === "rectangle"
        ? { roundness: { type: 3 } }
        : {}),
      label: { text: node.label },
    } as ExcalidrawElementSkeleton;
  });

  const center = (id: string) => {
    const { x, y } = placed.get(id)!;
    const { width, height } = sizes.get(id)!;
    return { x: x + width / 2, y: y + height / 2 };
  };
  const arrows: ExcalidrawElementSkeleton[] = edges.map((edge) => {
    const from = center(edge.from);
    const to = center(edge.to);
    return {
      type: "arrow",
      x: Math.round(from.x),
      y: Math.round(from.y),
      width: Math.round(to.x - from.x) || 1,
      height: Math.round(to.y - from.y) || 1,
      start: { id: edge.from },
      end: { id: edge.to },
      ...(edge.strokeStyle ? { strokeStyle: edge.strokeStyle } : {}),
      ...(edge.label ? { label: { text: edge.label } } : {}),
    } as ExcalidrawElementSkeleton;
  });

  return [...shapes, ...arrows];
};
