/**
 * Intranet fork: presentation mode (P1). Fullscreen, one frame per slide,
 * arrow keys or the controls to move on, L for the laser pointer, Esc to
 * stop. In a live session the presenter can put everyone in the spotlight
 * (Z4): they follow the slides on their own screens.
 */
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { atom, useAtom, useAtomValue } from "../../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../../collab/Collab";
import { spotlightAtom } from "../../collab/spotlight";

import { getSlides, slideTitle } from "./slides";

import type { Slide } from "./slides";

/** null: not presenting */
export const presentationAtom = atom<{ start: number } | null>(null);

type SavedState = Pick<
  AppState,
  "viewModeEnabled" | "zenModeEnabled" | "frameRendering" | "openSidebar"
>;

const HIDE_CONTROLS_MS = 2500;

export const PresentationMode = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const [presentation, setPresentation] = useAtom(presentationAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const spotlight = useAtomValue(spotlightAtom);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [index, setIndex] = useState(0);
  const [laser, setLaser] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const saved = useRef<SavedState | null>(null);
  const startedSpotlight = useRef(false);
  const hideTimer = useRef<number | null>(null);

  const show = useCallback(
    (slide: Slide | undefined) => {
      if (slide) {
        excalidrawAPI.setViewport({
          target: slide,
          fit: "contain",
          animation: { duration: 300 },
          offsets: { top: 8, right: 8, bottom: 8, left: 8 },
        });
      }
    },
    [excalidrawAPI],
  );

  const stop = useCallback(() => {
    setPresentation(null);
  }, [setPresentation]);

  // start and end
  useEffect(() => {
    if (!presentation) {
      return;
    }
    const all = getSlides(excalidrawAPI.getSceneElements());
    if (!all.length) {
      setPresentation(null);
      excalidrawAPI.setToast({
        message:
          "Noch keine Folien: Jeder Frame ist eine Folie. Lege einen mit dem Frame-Werkzeug (Taste F) an.",
        closable: true,
        duration: 6000,
      });
      return;
    }
    const state = excalidrawAPI.getAppState();
    saved.current = {
      viewModeEnabled: state.viewModeEnabled,
      zenModeEnabled: state.zenModeEnabled,
      frameRendering: state.frameRendering,
      openSidebar: state.openSidebar,
    };
    excalidrawAPI.updateScene({
      appState: {
        viewModeEnabled: true,
        zenModeEnabled: true,
        openSidebar: null,
        frameRendering: {
          ...state.frameRendering,
          enabled: true,
          name: false,
          outline: false,
          clip: true,
        },
      },
    });
    document.body.classList.add("ws-presenting");
    document.documentElement.requestFullscreen?.().catch(() => {});
    const start = Math.min(Math.max(presentation.start, 0), all.length - 1);
    setSlides(all);
    setIndex(start);
    // after the UI is gone, so the slide fills the screen
    window.setTimeout(() => show(all[start]), 60);

    return () => {
      document.body.classList.remove("ws-presenting");
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      if (saved.current) {
        excalidrawAPI.updateScene({ appState: saved.current });
        saved.current = null;
      }
      excalidrawAPI.setActiveTool({ type: "selection" });
      setLaser(false);
      if (startedSpotlight.current) {
        collabAPI?.stopSpotlight();
        startedSpotlight.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation, excalidrawAPI]);

  const go = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(next, 0), slides.length - 1);
      setIndex(target);
      show(slides[target]);
    },
    [slides, show],
  );

  const toggleLaser = useCallback(() => {
    setLaser((on) => {
      excalidrawAPI.setActiveTool({ type: on ? "selection" : "laser" });
      return !on;
    });
  }, [excalidrawAPI]);

  // keys, leaving fullscreen, resizing
  useEffect(() => {
    if (!presentation) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const handled = (() => {
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown":
          case "PageDown":
          case " ":
          case "Enter":
            go(index + 1);
            return true;
          case "ArrowLeft":
          case "ArrowUp":
          case "PageUp":
          case "Backspace":
            go(index - 1);
            return true;
          case "Home":
            go(0);
            return true;
          case "End":
            go(slides.length - 1);
            return true;
          case "Escape":
            stop();
            return true;
          case "l":
          case "L":
            toggleLaser();
            return true;
          default:
            return false;
        }
      })();
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onFullscreen = () => {
      if (!document.fullscreenElement) {
        stop();
      }
    };
    const onResize = () => show(slides[index]);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("resize", onResize);
    };
  }, [presentation, index, slides, go, stop, show, toggleLaser]);

  // the controls fade out while nobody moves the mouse
  useEffect(() => {
    if (!presentation) {
      return;
    }
    const wake = () => {
      setControlsVisible(true);
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
      }
      hideTimer.current = window.setTimeout(
        () => setControlsVisible(false),
        HIDE_CONTROLS_MS,
      );
    };
    wake();
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
      }
    };
  }, [presentation]);

  if (!presentation || !slides.length) {
    return null;
  }

  const spotlightOn = spotlight.presenting;

  return (
    <div
      className={clsx("ws-theme ws-present", !controlsVisible && "is-idle")}
      role="toolbar"
      aria-label="Präsentation"
    >
      <button
        type="button"
        className="ws-present__button"
        aria-label="Vorherige Folie"
        disabled={index === 0}
        onClick={() => go(index - 1)}
      >
        ‹
      </button>
      <span className="ws-present__counter" aria-live="polite">
        {index + 1} / {slides.length}
        <span className="ws-present__title">
          {slideTitle(slides[index], index)}
        </span>
      </span>
      <button
        type="button"
        className="ws-present__button"
        aria-label="Nächste Folie"
        disabled={index === slides.length - 1}
        onClick={() => go(index + 1)}
      >
        ›
      </button>
      <button
        type="button"
        className={clsx("ws-present__button", laser && "is-active")}
        aria-pressed={laser}
        title="Laserpointer (L)"
        onClick={toggleLaser}
      >
        Laser
      </button>
      {isCollaborating && collabAPI && (
        <button
          type="button"
          className={clsx("ws-present__button", spotlightOn && "is-active")}
          aria-pressed={spotlightOn}
          title="Alle in der Sitzung folgen deinen Folien"
          onClick={() => {
            if (spotlightOn) {
              collabAPI.stopSpotlight();
              startedSpotlight.current = false;
            } else {
              collabAPI.startSpotlight();
              startedSpotlight.current = true;
            }
          }}
        >
          {spotlightOn ? `Spotlight an · ${spotlight.followers}` : "Spotlight"}
        </button>
      )}
      <button type="button" className="ws-present__button" onClick={stop}>
        Beenden
      </button>
    </div>
  );
};
