/**
 * What the server uses of vendor/elements.mjs (built from elements/index.ts,
 * see scripts/build-elements.mjs). Elements are plain JSON objects in the
 * editor's format.
 */

export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index: string | null;
  boundElements: { id: string; type: string }[] | null;
  [key: string]: unknown;
}

/** a shape, text or arrow in the editor's skeleton format */
export type Skeleton = { type: string; [key: string]: unknown };

export interface Change {
  /** the whole scene afterwards, in z-order */
  elements: SceneElement[];
  /** new and changed elements (with new versions) */
  changed: SceneElement[];
}

export interface ElementUpdate {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
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
  direction?: "TB" | "LR";
  origin?: { x: number; y: number };
}

export declare class UnknownElementError extends Error {
  readonly ids: string[];
}

export declare const measureLine: (text: string, fontString: string) => number;
export declare const diagramSkeletons: (spec: DiagramSpec) => Skeleton[];
export declare const restore: (elements: readonly unknown[]) => SceneElement[];
/** replace the drawing; changed elements win over editors' copies */
export declare const replaceAll: (
  current: readonly SceneElement[],
  incoming: readonly unknown[],
) => Change;
export declare const addSkeletons: (
  current: readonly SceneElement[],
  skeletons: readonly Skeleton[],
) => Change;
export declare const updateElements: (
  current: readonly SceneElement[],
  updates: readonly ElementUpdate[],
) => Change;
export declare const deleteElements: (
  current: readonly SceneElement[],
  ids: readonly string[],
) => Change;

// --- element bounds -------------------------------------------------------------

export interface GeometryLimits {
  coordinate: number;
  size: number;
  points: number;
}

/** whole scenes (imports, the server's renderer) */
export declare const SCENE_LIMITS: GeometryLimits;
/** library items */
export declare const LIBRARY_LIMITS: GeometryLimits;

/** what is wrong with an element's geometry (German), or null */
export function geometryProblem(
  element: Record<string, unknown>,
  limits: GeometryLimits,
): string | null;

// --- company fonts (E3) ----------------------------------------------------------

export interface FontMetrics {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineHeight: number;
}

export class FontFileError extends Error {}

/** an uploaded TrueType / OpenType / WOFF2 file as WOFF2 with its metrics */
export function prepareCompanyFont(
  file: Uint8Array,
): Promise<{ woff2: Uint8Array; metrics: FontMetrics }>;
