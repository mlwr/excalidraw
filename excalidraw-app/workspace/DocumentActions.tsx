/**
 * Intranet fork: PDF and PowerPoint export (P7), PDF import (E4), started
 * from the main menu. Runs in the browser; shows progress and the outcome
 * as a toast of the editor.
 */
import { useEffect, useRef } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { atom, useAtom } from "../app-jotai";
import { getMaxImageDimension } from "../intranet/session";

export const slidesExportAtom = atom<"pdf" | "pptx" | null>(null);
export const pdfImportAtom = atom(false);

export const DocumentActions = ({
  excalidrawAPI,
  sceneName,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  sceneName: string;
}) => {
  const [exporting, setExporting] = useAtom(slidesExportAtom);
  const [importing, setImporting] = useAtom(pdfImportAtom);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!exporting) {
      return;
    }
    const kind = exporting;
    excalidrawAPI.setToast({
      message:
        kind === "pdf" ? "PDF wird erstellt …" : "PowerPoint wird erstellt …",
    });
    import("./presentation/exportSlides")
      .then(async ({ exportSlidesAsPdf, exportSlidesAsPptx }) => {
        const pages =
          kind === "pdf"
            ? await exportSlidesAsPdf(excalidrawAPI, sceneName)
            : await exportSlidesAsPptx(excalidrawAPI, sceneName);
        excalidrawAPI.setToast({
          message: `${pages} ${pages === 1 ? "Seite" : "Seiten"} exportiert.`,
          duration: 4000,
          closable: true,
        });
      })
      .catch((error: Error) =>
        excalidrawAPI.setToast({
          message: `Export fehlgeschlagen: ${error.message}`,
          closable: true,
        }),
      )
      .finally(() => setExporting(null));
  }, [exporting, excalidrawAPI, sceneName, setExporting]);

  useEffect(() => {
    if (importing) {
      setImporting(false);
      inputRef.current?.click();
    }
  }, [importing, setImporting]);

  return (
    <input
      ref={inputRef}
      type="file"
      accept="application/pdf,.pdf"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) {
          return;
        }
        excalidrawAPI.setToast({ message: `„${file.name}“ wird gelesen …` });
        import("./importPdf")
          .then(({ importPdf }) =>
            importPdf(excalidrawAPI, file, {
              maxImageDimension: getMaxImageDimension(),
              onProgress: (page, pages) =>
                pages > 1 &&
                excalidrawAPI.setToast({
                  message: `„${file.name}“: Seite ${page} von ${pages} …`,
                }),
            }),
          )
          .then(({ pages, total }) =>
            excalidrawAPI.setToast({
              message:
                pages < total
                  ? `Die ersten ${pages} von ${total} Seiten eingefügt.`
                  : `${pages} ${pages === 1 ? "Seite" : "Seiten"} eingefügt.`,
              duration: 4000,
              closable: true,
            }),
          )
          .catch((error: Error) =>
            excalidrawAPI.setToast({
              message: `PDF-Import fehlgeschlagen: ${error.message}`,
              closable: true,
            }),
          );
      }}
    />
  );
};
