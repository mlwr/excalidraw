/**
 * Intranet fork: the editor's element logic on the server, for the REST API
 * and the MCP server: shapes, labels and arrows created exactly like the
 * editor creates them (text measurement, arrow bindings, z-order indices),
 * imported scenes normalized like the editor normalizes them.
 *
 * Bundled into vendor/elements.mjs by scripts/build-elements.mjs; the server
 * sees the declarations in vendor/elements.d.mts. Type-checked against the
 * editor packages by the repository's root tsconfig.
 */
import {
  arrayToMap,
  cloneJSON,
  randomId,
  randomInteger,
} from "@excalidraw/common";
import {
  fixBindingsAfterDeletion,
  updateBoundElements,
} from "@excalidraw/element/binding";
import {
  syncInvalidIndices,
  syncMovedIndices,
} from "@excalidraw/element/fractionalIndex";
import { mutateElement } from "@excalidraw/element/mutateElement";
import { Scene } from "@excalidraw/element/Scene";
import {
  getBoundTextElement,
  getContainerElement,
  redrawTextBoundingBox,
} from "@excalidraw/element/textElement";
import { normalizeText } from "@excalidraw/element/textMeasurements";
import { convertToExcalidrawElements } from "@excalidraw/element/transform";
import { isTextElement } from "@excalidraw/element/typeChecks";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import { layoutDiagram } from "./layout";
import { measureLine } from "./textMetrics";

import type { DiagramSpec } from "./layout";

export type { DiagramEdge, DiagramNode, DiagramSpec } from "./layout";

// rendering (I3) runs in a thread of its own: see renderWorker.ts
export { FontFileError, prepareCompanyFont } from "./fonts";
export type { FontMetrics } from "./fonts";
export { geometryProblem, LIBRARY_LIMITS, SCENE_LIMITS } from "./geometry";
export type { GeometryLimits } from "./geometry";

// --- text measurement (no canvas on the server): see textMetrics.ts ----------

export { measureLine };

/** skeletons of a laid out diagram (nodes and edges) */
export const diagramSkeletons = (spec: DiagramSpec) =>
  layoutDiagram(spec, measureLine);

// --- helpers -------------------------------------------------------------------

export type Element = ExcalidrawElement;
export type Skeleton = ExcalidrawElementSkeleton;

export interface Change {
  /** the whole scene afterwards, in z-order */
  elements: OrderedExcalidrawElement[];
  /** what changed (new versions), for saving and live updates */
  changed: ExcalidrawElement[];
}

/** whether an element is still part of the drawing */
const isLive = (element: ExcalidrawElement) => !element.isDeleted;

const versionsOf = (elements: readonly ExcalidrawElement[]) =>
  new Map(elements.map((element) => [element.id, element.version]));

/** elements whose version differs from before */
const changedSince = (
  before: Map<string, number>,
  after: readonly ExcalidrawElement[],
) => after.filter((element) => before.get(element.id) !== element.version);

/**
 * Normalize elements from outside (an imported .excalidraw file, an API
 * client) the way the editor does when it opens a file.
 */
export const restore = (elements: readonly unknown[]) =>
  restoreElements(elements as ExcalidrawElement[], null, {
    refreshDimensions: false,
    repairBindings: true,
  }).map((element) =>
    // versions are counters: whole numbers (they end up in a bigint sum)
    Number.isSafeInteger(element.version) &&
    element.version > 0 &&
    Number.isSafeInteger(element.versionNonce)
      ? element
      : {
          ...element,
          version: Math.max(1, Math.trunc(Number(element.version)) || 1),
          versionNonce: Math.trunc(Number(element.versionNonce)) || 0,
        },
  );

// --- replacing -----------------------------------------------------------------

const withoutVersion = (element: ExcalidrawElement) =>
  JSON.stringify({ ...element, version: 0, versionNonce: 0, updated: 0 });

/**
 * Replace the whole drawing (an import): what changed gets versions above
 * the editors' copies, so it wins when they merge; what is missing is
 * deleted.
 */
export const replaceAll = (
  current: readonly ExcalidrawElement[],
  incoming: readonly unknown[],
): Change => {
  const before = versionsOf(current);
  const previous = arrayToMap(current);
  const next = restore(incoming).map((element) => {
    const old = previous.get(element.id);
    if (!old) {
      return element;
    }
    if (withoutVersion(old) === withoutVersion(element)) {
      return old;
    }
    return {
      ...element,
      version: Math.max(old.version, element.version) + 1,
      versionNonce: randomInteger(),
      updated: Date.now(),
    };
  });
  const kept = new Set(next.map((element) => element.id));
  const removed = current
    .filter((element) => !kept.has(element.id))
    .map((element) =>
      element.isDeleted
        ? element
        : {
            ...element,
            isDeleted: true,
            version: element.version + 1,
            versionNonce: randomInteger(),
            updated: Date.now(),
          },
    );
  const all = syncInvalidIndices(
    cloneJSON([...next, ...removed]) as ExcalidrawElement[],
  );
  return { elements: all, changed: changedSince(before, all) };
};

// --- adding --------------------------------------------------------------------

const ARROW_TYPES = new Set(["arrow", "line"]);

type Arrow = ExcalidrawElementSkeleton & {
  start?: { id?: string };
  end?: { id?: string };
};

/** element fields only the server sets on new elements */
const SERVER_FIELDS = [
  "version",
  "versionNonce",
  "updated",
  "index",
  "isDeleted",
  "seed",
  "boundElements",
  "containerId",
  "startBinding",
  "endBinding",
];

const isBoundArrow = (skeleton: ExcalidrawElementSkeleton): skeleton is Arrow =>
  ARROW_TYPES.has(skeleton.type) &&
  !!((skeleton as Arrow).start?.id || (skeleton as Arrow).end?.id);

/**
 * Add elements described as skeletons (the editor's
 * `convertToExcalidrawElements` format: shapes with `label`, arrows with
 * `start`/`end`). Arrows may bind to elements already in the scene by id.
 */
export const addSkeletons = (
  current: readonly ExcalidrawElement[],
  skeletons: readonly ExcalidrawElementSkeleton[],
): Change => {
  const before = versionsOf(current);
  const taken = new Set(current.map((element) => element.id));
  const batch = cloneJSON(skeletons) as ExcalidrawElementSkeleton[];
  // what the server keeps track of itself
  for (const skeleton of batch) {
    for (const key of SERVER_FIELDS) {
      delete (skeleton as Record<string, unknown>)[key];
    }
  }

  // ids of the new elements must be new to the scene (deleted ones included)
  const renamed = new Map<string, string>();
  for (const skeleton of batch) {
    if (skeleton.id && taken.has(skeleton.id)) {
      const id = randomId();
      renamed.set(skeleton.id, id);
      Object.assign(skeleton, { id });
    }
  }
  if (renamed.size) {
    for (const skeleton of batch) {
      if (skeleton.type === "frame") {
        Object.assign(skeleton, {
          children: skeleton.children.map((id) => renamed.get(id) || id),
        });
      }
      for (const end of ["start", "end"] as const) {
        const target = (skeleton as Arrow)[end];
        if (target?.id && renamed.has(target.id)) {
          target.id = renamed.get(target.id);
        }
      }
    }
  }

  // shapes first, then the arrows between them: the conversion binds an arrow
  // end only where it touches the shape, so arrows start out from centre to
  // centre of what they connect
  const shapes = merge(
    cloneJSON(current) as ExcalidrawElement[],
    batch.filter((skeleton) => !isBoundArrow(skeleton)),
  );
  const arrows = batch.filter(isBoundArrow);
  const result = arrows.length
    ? merge(
        shapes,
        arrows.map((arrow) => placeArrow(arrow, shapes)),
      )
    : shapes;
  return { elements: result, changed: changedSince(before, result) };
};

const centerOf = (element: ExcalidrawElement) => ({
  x: element.x + element.width / 2,
  y: element.y + element.height / 2,
});

const placeArrow = (
  arrow: Arrow,
  elements: readonly ExcalidrawElement[],
): ExcalidrawElementSkeleton => {
  const live = (id: string | undefined) => {
    const element = id ? elements.find((el) => el.id === id) : undefined;
    return element && isLive(element) ? element : undefined;
  };
  const start = live(arrow.start?.id);
  const end = live(arrow.end?.id);
  const given = arrow as {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  const dx = given.width ?? 100;
  const dy = given.height ?? 0;
  const to = end
    ? centerOf(end)
    : start
    ? { x: centerOf(start).x + dx, y: centerOf(start).y + dy }
    : { x: (given.x ?? 0) + dx, y: (given.y ?? 0) + dy };
  const from = start
    ? centerOf(start)
    : { x: given.x ?? to.x - dx, y: given.y ?? to.y - dy };
  const placed = {
    ...arrow,
    x: from.x,
    y: from.y,
    width: to.x - from.x || 1,
    height: to.y - from.y || 1,
  } as Record<string, unknown>;
  delete placed.points;
  return placed as ExcalidrawElementSkeleton;
};

/** convert skeletons and add them to the elements (copies, mutated) */
const merge = (
  elements: ExcalidrawElement[],
  skeletons: readonly ExcalidrawElementSkeleton[],
): OrderedExcalidrawElement[] => {
  if (!skeletons.length) {
    return elements as OrderedExcalidrawElement[];
  }
  const map = arrayToMap(elements);
  const defined = new Set(skeletons.map((skeleton) => skeleton.id));

  // elements already there that arrows bind to take part in the conversion
  const referenced = new Set<string>();
  for (const skeleton of skeletons.filter(isBoundArrow)) {
    for (const id of [skeleton.start?.id, skeleton.end?.id]) {
      const element = id ? map.get(id) : undefined;
      if (element && isLive(element) && !defined.has(id)) {
        referenced.add(element.id);
      }
    }
  }

  const converted = convertToExcalidrawElements(
    [
      ...[...referenced].map(
        (id) => cloneJSON(map.get(id)!) as ExcalidrawElementSkeleton,
      ),
      ...skeletons,
    ],
    { regenerateIds: false },
  );

  const created: ExcalidrawElement[] = [];
  for (const element of converted) {
    const mine = referenced.has(element.id) ? map.get(element.id) : undefined;
    if (!mine) {
      created.push(element);
      continue;
    }
    // of the elements already there, take only the new arrow bindings
    mutateElement(mine, map, { boundElements: element.boundElements });
  }
  return syncMovedIndices([...elements, ...created], arrayToMap(created));
};

// --- changing ------------------------------------------------------------------

export interface ElementUpdate {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** text of a text element, or the label of a shape or arrow */
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "hachure" | "cross-hatch" | "solid" | "zigzag";
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  roughness?: number;
  opacity?: number;
  fontSize?: number;
  link?: string | null;
}

const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "link",
] as const;

export class UnknownElementError extends Error {
  constructor(readonly ids: string[]) {
    super(`unknown element: ${ids.join(", ")}`);
  }
}

/**
 * Change elements: position and size (bound labels and arrows follow), text
 * and labels (re-measured and re-wrapped), style.
 */
export const updateElements = (
  current: readonly ExcalidrawElement[],
  updates: readonly ElementUpdate[],
): Change => {
  const elements = cloneJSON(current) as ExcalidrawElement[];
  const before = versionsOf(current);
  const scene = new Scene(elements);
  const byId = (id: string) => {
    const element = scene.getElement(id);
    return element && isLive(element) ? element : null;
  };

  const missing = updates.map((update) => update.id).filter((id) => !byId(id));
  if (missing.length) {
    throw new UnknownElementError(missing);
  }

  for (const update of updates) {
    const element = byId(update.id)!;

    const style: Record<string, unknown> = {};
    for (const key of STYLE_KEYS) {
      if (update[key] !== undefined) {
        style[key] = update[key];
      }
    }
    if (Object.keys(style).length) {
      scene.mutateElement(element, style as any);
    }

    // geometry: shapes move with their label, arrows follow their ends
    const geometry: Record<string, number> = {};
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof update[key] === "number") {
        geometry[key] = update[key]!;
      }
    }
    if (Object.keys(geometry).length && !isTextElement(element)) {
      const dx = (geometry.x ?? element.x) - element.x;
      const dy = (geometry.y ?? element.y) - element.y;
      scene.mutateElement(element, geometry as any);
      const label = getBoundTextElement(
        element,
        scene.getNonDeletedElementsMap(),
      );
      if (label) {
        scene.mutateElement(label, { x: label.x + dx, y: label.y + dy });
        redrawTextBoundingBox(label, element, scene);
      }
      updateBoundElements(element as any, scene);
    } else if (Object.keys(geometry).length) {
      scene.mutateElement(element, {
        x: geometry.x ?? element.x,
        y: geometry.y ?? element.y,
      });
    }

    // text: of the text element itself or of the shape's label
    if (update.text !== undefined || update.fontSize !== undefined) {
      const text = isTextElement(element)
        ? element
        : getBoundTextElement(element, scene.getNonDeletedElementsMap());
      if (text) {
        setText(scene, text, update.text, update.fontSize);
      } else if (update.text) {
        addLabel(scene, element, update.text, update.fontSize);
      }
    }
  }

  return finish(scene, before);
};

const setText = (
  scene: Scene,
  text: ExcalidrawTextElement,
  value: string | undefined,
  fontSize: number | undefined,
) => {
  const normalized = value === undefined ? undefined : normalizeText(value);
  scene.mutateElement(text, {
    ...(normalized === undefined
      ? {}
      : { text: normalized, originalText: normalized }),
    ...(fontSize ? { fontSize } : {}),
  });
  const container = getContainerElement(text, scene.getNonDeletedElementsMap());
  redrawTextBoundingBox(text, container, scene);
};

/** a shape without label gets one, as if it was typed in the editor */
const addLabel = (
  scene: Scene,
  container: ExcalidrawElement,
  value: string,
  fontSize: number | undefined,
) => {
  const converted = convertToExcalidrawElements(
    [
      {
        ...(cloneJSON(container) as ExcalidrawElementSkeleton),
        label: { text: value, ...(fontSize ? { fontSize } : {}) },
      } as ExcalidrawElementSkeleton,
    ],
    { regenerateIds: false },
  );
  const withLabel = converted.find((element) => element.id === container.id)!;
  const label = converted.find((element) => isTextElement(element))!;
  scene.mutateElement(container, {
    boundElements: withLabel.boundElements,
    width: withLabel.width,
    height: withLabel.height,
  });
  const elements = [...scene.getElementsIncludingDeleted(), label];
  scene.replaceAllElements(syncMovedIndices(elements, arrayToMap([label])));
};

// --- deleting ------------------------------------------------------------------

/** delete elements with their labels; arrows let go of what is deleted */
export const deleteElements = (
  current: readonly ExcalidrawElement[],
  ids: readonly string[],
): Change => {
  const elements = cloneJSON(current) as ExcalidrawElement[];
  const before = versionsOf(current);
  const scene = new Scene(elements);
  const map = scene.getNonDeletedElementsMap();

  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) {
    throw new UnknownElementError(missing);
  }

  const doomed = new Set<string>();
  for (const id of ids) {
    const element = map.get(id)!;
    doomed.add(id);
    const label = getBoundTextElement(element, map);
    if (label) {
      doomed.add(label.id);
    }
    // deleting a label alone leaves the shape
  }
  const deleted: ExcalidrawElement[] = [...doomed].map((id) => map.get(id)!);
  for (const element of deleted) {
    scene.mutateElement(element, { isDeleted: true });
  }
  fixBindingsAfterDeletion(scene.getElementsIncludingDeleted(), deleted);
  return finish(scene, before);
};

const finish = (scene: Scene, before: Map<string, number>): Change => {
  const all = scene.getElementsIncludingDeleted() as OrderedExcalidrawElement[];
  return { elements: [...all], changed: changedSince(before, all) };
};
