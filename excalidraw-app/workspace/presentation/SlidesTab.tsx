/**
 * Intranet fork: slide overview in the sidebar. Every frame is a slide
 * (P1); new slides with layouts, also with Alt+A (P2), reordering by drag
 * and drop, speaker notes (P3) and step-by-step reveals (P5).
 */
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { exportScene, getSceneVersion } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useSetAtom } from "../../app-jotai";

import { Button } from "../ui";

import { presentationAtom } from "./PresentationMode";
import {
  addSlide,
  getSlides,
  moveSlide,
  setRevealStep,
  setSlideNotes,
  SLIDE_LAYOUTS,
  slideElements,
  slideNotes,
  slideStepCount,
  slideTitle,
} from "./slides";

import type { Slide, SlideLayout } from "./slides";

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

/** P3: notes for the speaker, saved when the field is left */
const NotesField = ({
  api,
  slide,
  canEdit,
}: {
  api: ExcalidrawImperativeAPI;
  slide: Slide;
  canEdit: boolean;
}) => {
  const stored = slideNotes(slide);
  const [value, setValue] = useState(stored);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) {
      setValue(stored);
    }
  }, [stored]);
  if (!canEdit) {
    return stored ? <p className="ws-slides__notes-text">{stored}</p> : null;
  }
  return (
    <textarea
      className="ws-input ws-slides__notes"
      rows={3}
      placeholder="Notizen für die Referentenansicht (Links werden klickbar)"
      aria-label={`Notizen zu „${slideTitle(slide, 0)}“`}
      value={value}
      maxLength={5000}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        editing.current = false;
        if (value !== stored) {
          setSlideNotes(api, slide.id, value);
        }
      }}
      // the editor's shortcuts must not fire while typing here
      onKeyDown={(event) => event.stopPropagation()}
    />
  );
};

/** P5: which elements of the slide appear on which click */
const StepsControl = ({
  api,
  slide,
  steps,
}: {
  api: ExcalidrawImperativeAPI;
  slide: Slide;
  steps: number;
}) => {
  const assign = () => {
    const selected = api.getAppState().selectedElementIds;
    const ids = slideElements(api.getSceneElements(), slide)
      .filter((element) => selected[element.id])
      .map((element) => element.id);
    if (!ids.length) {
      api.setToast({
        message:
          "Erst Elemente dieser Folie auswählen, die später erscheinen sollen.",
        closable: true,
        duration: 4000,
      });
      return;
    }
    setRevealStep(api, ids, steps + 1);
    api.setToast({
      message: `Erscheint beim ${steps + 1}. Klick.`,
      duration: 2500,
    });
  };
  const reset = () =>
    setRevealStep(
      api,
      slideElements(api.getSceneElements(), slide).map((element) => element.id),
      null,
    );
  return (
    <div className="ws-slides__steps">
      <span className="ws-muted">
        {steps
          ? `${steps} ${steps === 1 ? "Einblendung" : "Einblendungen"}`
          : "Alles auf einmal"}
      </span>
      <button
        type="button"
        className="ws-link"
        title="Die ausgewählten Elemente erscheinen beim nächsten Klick"
        onClick={assign}
      >
        Auswahl später einblenden
      </button>
      {steps > 0 && (
        <button type="button" className="ws-link" onClick={reset}>
          zurücksetzen
        </button>
      )}
    </div>
  );
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
  const [steps, setSteps] = useState<Record<string, number>>({});
  const [version, setVersion] = useState(0);
  const [layout, setLayout] = useState<SlideLayout>("titleContent");
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [open, setOpen] = useState<string | null>(null);

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
        const next = getSlides(elements);
        setSlides(next);
        setSteps(
          Object.fromEntries(
            next.map((slide) => [slide.id, slideStepCount(elements, slide)]),
          ),
        );
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
      {canEdit && (
        <div className="ws-slides__new">
          <select
            className="ws-input"
            aria-label="Layout der neuen Folie"
            value={layout}
            onChange={(event) => setLayout(event.target.value as SlideLayout)}
          >
            {SLIDE_LAYOUTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <Button
            title="Neue Folie (Alt+A)"
            onClick={() => addSlide(excalidrawAPI, layout)}
          >
            Neue Folie
          </Button>
        </div>
      )}
      {!slides.length ? (
        <p className="ws-muted">
          Jeder Frame ist eine Folie. Lege eine mit „Neue Folie“ (Alt+A) oder
          dem Frame-Werkzeug (Taste F) an.
        </p>
      ) : (
        <ol className="ws-slides__list">
          {slides.map((slide, index) => (
            <li
              key={slide.id}
              className={clsx(
                "ws-slides__item",
                over === index && dragged !== null && "is-drop-target",
              )}
              draggable={canEdit}
              onDragStart={(event) => {
                setDragged(index);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", slide.id);
              }}
              onDragOver={(event) => {
                if (dragged !== null) {
                  event.preventDefault();
                  setOver(index);
                }
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null && dragged !== index) {
                  moveSlide(excalidrawAPI, dragged, index);
                }
                setDragged(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDragged(null);
                setOver(null);
              }}
            >
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
              <button
                type="button"
                className="ws-link ws-slides__more"
                aria-expanded={open === slide.id}
                onClick={() => setOpen(open === slide.id ? null : slide.id)}
              >
                {open === slide.id
                  ? "Weniger"
                  : `Notizen${canEdit ? " und Einblendungen" : ""}`}
                {slideNotes(slide) && open !== slide.id ? " ✎" : ""}
              </button>
              {open === slide.id && (
                <div className="ws-slides__details">
                  <NotesField
                    api={excalidrawAPI}
                    slide={slide}
                    canEdit={canEdit}
                  />
                  {canEdit && (
                    <StepsControl
                      api={excalidrawAPI}
                      slide={slide}
                      steps={steps[slide.id] || 0}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="ws-muted ws-slides__keys">
        Beim Präsentieren: Pfeiltasten oder Leertaste blättern (auch durch
        Einblendungen), L für den Laserpointer, Esc beendet.
      </p>
    </div>
  );
};
