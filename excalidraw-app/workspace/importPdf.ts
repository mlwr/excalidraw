/**
 * Intranet fork: PDF import (E4). The pages are rendered in the browser
 * (pdf.js, served by the app itself) and come into the scene as images,
 * each in a frame, ready to annotate or to present as slides. The PDF
 * itself never leaves the browser; only the page images are saved with
 * the scene like any other image.
 */
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";
import { getCommonBounds } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

const MAX_PAGES = 50;
const PAGE_GAP = 80;
/** bigger files are no documents to annotate but print data */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** longest side of a page image: sharp enough to read and to present */
const MAX_PAGE_PX = 2000;
/** all page images together, so that big documents stay workable */
const MAX_TOTAL_PIXELS = 100_000_000;
const JPEG_QUALITY = 0.9;

const sha1 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const importPdf = async (
  api: ExcalidrawImperativeAPI,
  file: File,
  options: {
    maxImageDimension: number;
    onProgress?: (page: number, pages: number) => void;
  },
) => {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(
      `Die Datei ist zu groß (höchstens ${MAX_PDF_BYTES / 1024 / 1024} MB).`,
    );
  }
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const document = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // no code from the PDF: fonts and functions without eval
    isEvalSupported: false,
    disableAutoFetch: true,
  }).promise;
  const pages = Math.min(document.numPages, MAX_PAGES);
  const baseName = file.name.replace(/\.pdf$/i, "") || "PDF";
  const pixelsPerPage = MAX_TOTAL_PIXELS / pages;

  // below what is already there, left-aligned with it
  const existing = api.getSceneElements();
  const [minX, , , maxY] = existing.length
    ? getCommonBounds(existing)
    : [0, 0, 0, -PAGE_GAP];
  let y = maxY + PAGE_GAP;

  const files: BinaryFileData[] = [];
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
  for (let number = 1; number <= pages; number++) {
    options.onProgress?.(number, pages);
    const page = await document.getPage(number);
    const unscaled = page.getViewport({ scale: 1 });
    // sharp enough to read, within the image size the app accepts and the
    // share of all pages together
    const longest = Math.max(unscaled.width, unscaled.height);
    const scale = Math.min(
      2,
      Math.min(MAX_PAGE_PX, options.maxImageDimension) / longest,
      Math.sqrt(pixelsPerPage / (unscaled.width * unscaled.height)),
    );
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    // pages are paper: JPEG keeps them a fraction of the size of PNG
    const dataURL = canvas.toDataURL("image/jpeg", JPEG_QUALITY) as DataURL;
    // give the canvas memory back before the next page
    canvas.width = 0;
    canvas.height = 0;
    const bytes = new TextEncoder().encode(dataURL);
    const fileId = (await sha1(bytes)) as FileId;
    files.push({
      id: fileId,
      dataURL,
      mimeType: "image/jpeg",
      created: Date.now(),
    });
    // the page at its size in PDF points (1 pt = 1 scene px)
    const imageId = `pdf-${fileId.slice(0, 12)}-${number}`;
    skeletons.push(
      {
        type: "image",
        id: imageId,
        fileId,
        x: minX,
        y,
        width: unscaled.width,
        height: unscaled.height,
      },
      {
        type: "frame",
        children: [imageId],
        name: pages > 1 ? `${baseName} – Seite ${number}` : baseName,
      },
    );
    y += unscaled.height + PAGE_GAP;
    page.cleanup();
  }
  await document.destroy();

  api.addFiles(files);
  const created = convertToExcalidrawElements(skeletons, {
    regenerateIds: true,
  });
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...created],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  api.setViewport({
    target: created,
    fit: "scale-down",
    animation: true,
    offsets: { ui: true },
  });
  return { pages, total: document.numPages };
};
