/**
 * Intranet fork: a slide as an image, as far as it is revealed (P5), for
 * the presenter window (P3) and the audience (P6). A PNG drawn with the
 * fonts this page already has, so it looks the same anywhere (and no font
 * tools run that the Content-Security-Policy would stop).
 */
import { exportScene } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { hiddenAtStep } from "./slides";

import type { Slide } from "./slides";

const cache = new Map<string, Promise<string>>();
const MAX_CACHED = 40;

/** Full HD at most: sharp on projectors, small enough to send around */
const MAX_SIDE = 1920;

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** a PNG data URL of the slide at this step (cached per scene version) */
export const slideImage = (
  api: ExcalidrawImperativeAPI,
  slide: Slide,
  step: number,
  sceneVersion: number,
): Promise<string> => {
  const key = `${slide.id}:${step}:${sceneVersion}`;
  let image = cache.get(key);
  if (!image) {
    const all = getNonDeletedElements(api.getSceneElements());
    const hidden = hiddenAtStep(all, slide, step);
    image = exportScene({
      type: "png",
      data: {
        elements: all.filter((element) => !hidden.has(element.id)),
        appState: {
          viewBackgroundColor: api.getAppState().viewBackgroundColor,
        },
        files: api.getFiles(),
      },
      config: {
        exportingFrame: slide,
        padding: 0,
        maxWidthOrHeight: MAX_SIDE,
      },
    }).then((blob) => asDataUrl(blob as Blob));
    cache.set(key, image);
    image.catch(() => cache.delete(key));
    while (cache.size > MAX_CACHED) {
      cache.delete(cache.keys().next().value!);
    }
  }
  return image;
};
