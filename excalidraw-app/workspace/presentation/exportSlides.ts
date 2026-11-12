/**
 * Intranet fork: slides as PDF and PowerPoint (P7). Every frame becomes a
 * page or slide, rendered in high resolution in the browser; without frames
 * the whole drawing is one page. The libraries load only when needed and
 * come from the app itself, not from the internet.
 */
import { exportScene } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getSlides, slideTitle } from "./slides";

import type { Slide } from "./slides";

/** longest side of a rendered slide in pixels */
const RENDER_SIZE = 2400;

interface RenderedSlide {
  title: string;
  png: Uint8Array;
  width: number;
  height: number;
}

const renderSlides = async (
  api: ExcalidrawImperativeAPI,
): Promise<RenderedSlide[]> => {
  const elements = getNonDeletedElements(api.getSceneElements());
  if (!elements.length) {
    throw new Error("Die Zeichnung ist leer.");
  }
  const appState = api.getAppState();
  const files = api.getFiles();
  const slides: (Slide | null)[] = getSlides(elements);
  const targets = slides.length ? slides : [null];
  const rendered: RenderedSlide[] = [];
  for (const [index, slide] of targets.entries()) {
    const blob = await exportScene({
      type: "png",
      data: {
        elements,
        appState: { viewBackgroundColor: appState.viewBackgroundColor },
        files,
      },
      config: {
        exportingFrame: slide,
        maxWidthOrHeight: RENDER_SIZE,
        padding: slide ? 0 : 24,
      },
    });
    const bitmap = await createImageBitmap(blob);
    rendered.push({
      title: slide ? slideTitle(slide, index) : appState.name || "Zeichnung",
      png: new Uint8Array(await blob.arrayBuffer()),
      width: bitmap.width,
      height: bitmap.height,
    });
    bitmap.close();
  }
  return rendered;
};

const download = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const safeFileName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\u0000-\u001f/\\:*?"<>|]+/g, "_").trim() || "Excalidraw";

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const exportSlidesAsPdf = async (
  api: ExcalidrawImperativeAPI,
  name: string,
) => {
  const slides = await renderSlides(api);
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(name);
  pdf.setCreator("Excalidraw");
  for (const slide of slides) {
    const image = await pdf.embedPng(slide.png);
    // 96 dpi screen pixels at their rendered size, scaled to a page whose
    // long side is A4 landscape-ish (842 pt)
    const scale = 842 / Math.max(slide.width, slide.height);
    const width = slide.width * scale;
    const height = slide.height * scale;
    const page = pdf.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  const bytes = await pdf.save();
  download(
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    `${safeFileName(name)}.pdf`,
  );
  return slides.length;
};

export const exportSlidesAsPptx = async (
  api: ExcalidrawImperativeAPI,
  name: string,
) => {
  const slides = await renderSlides(api);
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  // 16:9 slides (13.33 x 7.5 in), each image fitted in
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = name;
  const slideWidth = 13.333;
  const slideHeight = 7.5;
  for (const slide of slides) {
    const page = pptx.addSlide();
    const scale = Math.min(
      slideWidth / slide.width,
      slideHeight / slide.height,
    );
    const w = slide.width * scale;
    const h = slide.height * scale;
    page.addImage({
      data: `data:image/png;base64,${toBase64(slide.png)}`,
      x: (slideWidth - w) / 2,
      y: (slideHeight - h) / 2,
      w,
      h,
    });
    page.addNotes(slide.title);
  }
  const blob = (await pptx.write({ outputType: "blob" })) as Blob;
  download(blob, `${safeFileName(name)}.pptx`);
  return slides.length;
};
