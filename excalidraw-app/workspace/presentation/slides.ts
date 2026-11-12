/**
 * Intranet fork: frames are slides (P1). Their order is the order in which
 * they were drawn, unless someone reordered them in the slide overview
 * (stored on the frames as `customData.slideIndex`, so it travels with the
 * scene to everyone).
 */
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { newElementWith } from "@excalidraw/element";

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
