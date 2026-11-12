/**
 * Intranet fork: frames are slides (P1). Their order is the order in which
 * they were drawn, unless someone reordered them in the slide overview
 * (stored on the frames as `customData.slideIndex`, so it travels with the
 * scene to everyone).
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { FONT_FAMILY, randomId } from "@excalidraw/common";
import { getCommonBounds, newElementWith } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type Slide = NonDeleted<ExcalidrawFrameElement>;

const slideIndexOf = (frame: ExcalidrawFrameElement) => {
  const value = frame.customData?.slideIndex;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const getSlides = (elements: readonly ExcalidrawElement[]): Slide[] => {
  const frames = elements.filter(
    (element): element is Slide =>
      element.type === "frame" && !element.isDeleted,
  );
  return frames
    .map((frame, position) => ({ frame, position }))
    .sort((a, b) => {
      const ia = slideIndexOf(a.frame);
      const ib = slideIndexOf(b.frame);
      if (ia !== null && ib !== null && ia !== ib) {
        return ia - ib;
      }
      if (ia !== null && ib === null) {
        return -1;
      }
      if (ia === null && ib !== null) {
        return 1;
      }
      return a.position - b.position;
    })
    .map((entry) => entry.frame);
};

export const slideTitle = (slide: Slide, index: number) =>
  slide.name?.trim() || `Folie ${index + 1}`;

/** move a slide to another place; everybody in the scene gets the order */
export const moveSlide = (
  api: ExcalidrawImperativeAPI,
  from: number,
  to: number,
) => {
  const slides = getSlides(api.getSceneElements());
  if (to < 0 || to >= slides.length || from === to) {
    return;
  }
  const order = slides.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const indexOf = new Map(order.map((slide, index) => [slide.id, index]));
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((element) =>
      indexOf.has(element.id) &&
      element.customData?.slideIndex !== indexOf.get(element.id)
        ? newElementWith(element, {
            customData: {
              ...element.customData,
              slideIndex: indexOf.get(element.id),
            },
          })
        : element,
    ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

// --- P2: new slides with layouts --------------------------------------------------

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
const SLIDE_GAP = 100;

export type SlideLayout =
  | "titleContent"
  | "title"
  | "twoColumns"
  | "section"
  | "blank";

export const SLIDE_LAYOUTS: { id: SlideLayout; label: string }[] = [
  { id: "titleContent", label: "Titel und Inhalt" },
  { id: "title", label: "Titelfolie" },
  { id: "twoColumns", label: "Zwei Spalten" },
  { id: "section", label: "Abschnitt" },
  { id: "blank", label: "Leer" },
];

type Skeleton = NonNullable<
  Parameters<typeof convertToExcalidrawElements>[0]
>[number];

const placeholder = (
  x: number,
  y: number,
  text: string,
  fontSize: number,
  extra: Record<string, unknown> = {},
): Skeleton =>
  ({
    type: "text",
    id: randomId(),
    x,
    y,
    text,
    fontSize,
    fontFamily: FONT_FAMILY.Nunito,
    strokeColor: "#1e1e1e",
    ...extra,
  } as Skeleton);

/** the texts a layout starts with, relative to the slide's corner */
const layoutTexts = (layout: SlideLayout): Skeleton[] => {
  switch (layout) {
    case "title":
      return [
        placeholder(120, 260, "Titel der Präsentation", 72),
        placeholder(120, 380, "Untertitel, Name, Datum", 36, {
          strokeColor: "#5c5c5c",
        }),
      ];
    case "twoColumns":
      return [
        placeholder(80, 60, "Titel", 56),
        placeholder(80, 200, "• Punkt links\n• noch ein Punkt", 32),
        placeholder(680, 200, "• Punkt rechts\n• noch ein Punkt", 32),
      ];
    case "section":
      return [placeholder(120, 300, "Abschnitt", 80)];
    case "blank":
      return [];
    default:
      return [
        placeholder(80, 60, "Titel", 56),
        placeholder(
          80,
          200,
          "• Erster Punkt\n• Zweiter Punkt\n• Dritter Punkt",
          36,
        ),
      ];
  }
};

/**
 * A new 16:9 slide after the last one, with the texts of a layout. Returns
 * the new frame (the editor shows it).
 */
export const addSlide = (api: ExcalidrawImperativeAPI, layout: SlideLayout) => {
  const elements = api.getSceneElements();
  const slides = getSlides(elements);
  const last = slides[slides.length - 1];
  let x = 0;
  let y = 0;
  if (last) {
    x = last.x + last.width + SLIDE_GAP;
    y = last.y;
  } else if (elements.length) {
    const [minX, , , maxY] = getCommonBounds(elements);
    x = minX;
    y = maxY + SLIDE_GAP;
  }
  const texts = layoutTexts(layout).map((text) => ({
    ...text,
    x: (text.x as number) + x,
    y: (text.y as number) + y,
  })) as Skeleton[];
  const ordered = slides.some((slide) => slideIndexOf(slide) !== null);
  const created = convertToExcalidrawElements(
    [
      ...texts,
      {
        type: "frame",
        x,
        y,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        name: `Folie ${slides.length + 1}`,
        children: texts.map((text) => (text as { id: string }).id),
        ...(ordered ? { customData: { slideIndex: slides.length } } : {}),
      } as Skeleton,
    ],
    { regenerateIds: true },
  );
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  const frame = created.find((element) => element.type === "frame");
  if (frame) {
    api.setViewport({
      target: frame,
      fit: "contain",
      animation: true,
      offsets: { ui: true },
    });
  }
  return frame;
};

// --- P3: speaker notes ------------------------------------------------------------

export const slideNotes = (slide: Slide) =>
  typeof slide.customData?.notes === "string" ? slide.customData.notes : "";

export const setSlideNotes = (
  api: ExcalidrawImperativeAPI,
  slideId: string,
  notes: string,
) => {
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((element) =>
      element.id === slideId && (element.customData?.notes || "") !== notes
        ? newElementWith(element, {
            customData: { ...element.customData, notes },
          })
        : element,
    ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

// --- P5: revealing a slide step by step ------------------------------------------

/** 0: with the slide; 1, 2, ...: on the 1st, 2nd ... click */
export const revealStepOf = (element: ExcalidrawElement) => {
  const step = element.customData?.revealStep;
  return typeof step === "number" && Number.isInteger(step) && step > 0
    ? step
    : 0;
};

/** what belongs to the slide: its children (and their labels) */
export const slideElements = (
  elements: readonly ExcalidrawElement[],
  slide: Slide,
) =>
  elements.filter(
    (element) => !element.isDeleted && element.frameId === slide.id,
  );

/** how many clicks a slide takes before the next one */
export const slideStepCount = (
  elements: readonly ExcalidrawElement[],
  slide: Slide,
) =>
  slideElements(elements, slide).reduce(
    (max, element) => Math.max(max, revealStepOf(element)),
    0,
  );

/** elements of a slide not shown yet at this step (labels follow their shape) */
export const hiddenAtStep = (
  elements: readonly ExcalidrawElement[],
  slide: Slide,
  step: number,
) => {
  const hidden = new Set(
    slideElements(elements, slide)
      .filter((element) => revealStepOf(element) > step)
      .map((element) => element.id),
  );
  for (const element of elements) {
    if (
      element.type === "text" &&
      element.containerId &&
      hidden.has(element.containerId)
    ) {
      hidden.add(element.id);
    }
  }
  return hidden;
};

/**
 * These elements appear on the given click (null: with the slide). Their
 * labels and the other members of their groups come along.
 */
export const setRevealStep = (
  api: ExcalidrawImperativeAPI,
  elementIds: readonly string[],
  step: number | null,
) => {
  const all = api.getSceneElementsIncludingDeleted();
  const chosen = new Set(elementIds);
  const groups = new Set(
    all
      .filter((element) => chosen.has(element.id))
      .flatMap((element) => element.groupIds),
  );
  for (const element of all) {
    if (element.groupIds.some((group) => groups.has(group))) {
      chosen.add(element.id);
    }
  }
  for (const element of all) {
    if (
      element.type === "text" &&
      element.containerId &&
      chosen.has(element.containerId)
    ) {
      chosen.add(element.id);
    }
  }
  api.updateScene({
    elements: all.map((element) => {
      if (!chosen.has(element.id)) {
        return element;
      }
      const { revealStep: _, ...rest } = element.customData || {};
      return newElementWith(element, {
        customData: step ? { ...rest, revealStep: step } : rest,
      });
    }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};
