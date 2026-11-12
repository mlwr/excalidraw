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

const sha1 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-1", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const importPdf = async (
  api: ExcalidrawImperativeAPI,
  file: File,
  options: { maxImageDimension: number },
) => {
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

  // below what is already there, left-aligned with it
  const existing = api.getSceneElements();
  const [minX, , , maxY] = existing.length
    ? getCommonBounds(existing)
    : [0, 0, 0, -PAGE_GAP];
  let y = maxY + PAGE_GAP;

  const files: BinaryFileData[] = [];
  const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
  for (let number = 1; number <= pages; number++) {
    const page = await document.getPage(number);
    const unscaled = page.getViewport({ scale: 1 });
    // sharp enough to read, within the image size the app accepts
    const scale = Math.min(
      2,
      options.maxImageDimension / Math.max(unscaled.width, unscaled.height),
    );
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const dataURL = canvas.toDataURL("image/png") as DataURL;
    const bytes = new TextEncoder().encode(dataURL);
    const fileId = (await sha1(bytes)) as FileId;
    files.push({
      id: fileId,
      dataURL,
      mimeType: "image/png",
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
