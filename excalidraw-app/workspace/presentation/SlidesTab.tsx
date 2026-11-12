/**
 * Intranet fork: slide overview (P1) in the sidebar: every frame is a
 * slide; reorder them, start the presentation from any of them.
 */
import { useEffect, useRef, useState } from "react";

import { exportScene, getSceneVersion } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useSetAtom } from "../../app-jotai";

import { Button } from "../ui";

import { presentationAtom } from "./PresentationMode";
import { getSlides, moveSlide, slideTitle } from "./slides";

import type { Slide } from "./slides";

export const SLIDES_TAB = "slides";

const PREVIEW_DELAY_MS = 800;

const SlidePreview = ({
  api,
  slide,
  version,
}: {
  api: ExcalidrawImperativeAPI;
  slide: Slide;
  version: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      exportScene({
        type: "svg",
        data: {
          elements: getNonDeletedElements(api.getSceneElements()),
          appState: {
            viewBackgroundColor: api.getAppState().viewBackgroundColor,
          },
          files: api.getFiles(),
        },
        config: { exportingFrame: slide, skipInliningFonts: true },
      })
        .then((svg) => {
          if (!cancelled && ref.current) {
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            ref.current.replaceChildren(svg);
          }
        })
        .catch(() => {});
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, slide, version]);
  return <div ref={ref} className="ws-slides__preview" aria-hidden="true" />;
};

export const SlidesTab = ({
  excalidrawAPI,
  canEdit,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  canEdit: boolean;
}) => {
  const present = useSetAtom(presentationAtom);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    let last = -1;
    const update = () => {
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const current = getSceneVersion(elements);
      if (current !== last) {
        last = current;
        setSlides(getSlides(elements));
        setVersion(current);
      }
    };
    update();
    return excalidrawAPI.onChange(update);
  }, [excalidrawAPI]);

  if (!excalidrawAPI) {
    return null;
  }

  return (
    <div className="ws-theme ws-slides">
      <div className="ws-slides__head">
        <strong>Folien</strong>
        <Button
          variant="primary"
          disabled={!slides.length}
          onClick={() => present({ start: 0 })}
        >
          Präsentieren
        </Button>
      </div>
      {!slides.length ? (
        <p className="ws-muted">
          Jeder Frame ist eine Folie. Lege einen mit dem Frame-Werkzeug (Taste
          F) an und zeichne darin.
        </p>
      ) : (
        <ol className="ws-slides__list">
          {slides.map((slide, index) => (
            <li key={slide.id} className="ws-slides__item">
              <button
                type="button"
                className="ws-slides__open"
                title={`Ab „${slideTitle(slide, index)}“ präsentieren`}
                onClick={() => present({ start: index })}
              >
                <SlidePreview
                  api={excalidrawAPI}
                  slide={slide}
                  version={version}
                />
                <span className="ws-slides__name">
                  {index + 1}. {slideTitle(slide, index)}
                </span>
              </button>
              {canEdit && (
                <span className="ws-slides__move">
                  <button
                    type="button"
                    aria-label="Nach vorne"
                    disabled={index === 0}
                    onClick={() => moveSlide(excalidrawAPI, index, index - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Nach hinten"
                    disabled={index === slides.length - 1}
                    onClick={() => moveSlide(excalidrawAPI, index, index + 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="ws-muted ws-slides__keys">
        Beim Präsentieren: Pfeiltasten oder Leertaste blättern, L für den
        Laserpointer, Esc beendet.
      </p>
    </div>
  );
};
