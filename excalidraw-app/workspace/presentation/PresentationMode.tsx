/**
 * Intranet fork: presentation mode (P1). Fullscreen, one frame per slide,
 * arrow keys or the controls to move on, L for the laser pointer, Esc to
 * stop. In a live session the presenter can put everyone in the spotlight
 * (Z4): they follow the slides on their own screens.
 *
 * Phase 6: slides reveal their elements click by click (P5, hidden on this
 * screen only); a presenter window shows notes, the next slide and a timer
 * (P3); a phone becomes the remote control via QR code (P4); an audience
 * follows in their own browsers, with reactions and raised hands (P6).
 */
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getSceneVersion } from "@excalidraw/excalidraw";
import { setLocallyHiddenElements } from "@excalidraw/excalidraw/scene/Renderer";
import qrcode from "qrcode-generator";

import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { atom, useAtom, useAtomValue } from "../../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../../collab/Collab";
import { spotlightAtom } from "../../collab/spotlight";

import {
  askServer,
  closePresentingSocket,
  openPresentingSocket,
  randomKey,
} from "./presentingSocket";
import { presenterChannelName } from "./presenting";
import { slideImage } from "./slideImage";
import {
  addSlide,
  getSlides,
  hiddenAtStep,
  slideNotes,
  slideStepCount,
  slideTitle,
} from "./slides";

import type {
  PresenterWindowState,
  PresentingCommand,
  PresentingState,
} from "./presenting";
import type { Slide } from "./slides";
import type { Socket } from "socket.io-client";

/** null: not presenting */
export const presentationAtom = atom<{ start: number } | null>(null);

type SavedState = Pick<
  AppState,
  "viewModeEnabled" | "zenModeEnabled" | "frameRendering" | "openSidebar"
>;

const HIDE_CONTROLS_MS = 2500;
const LIVE_COUNT_MS = 5000;

/** a QR code as an image (no network, no script) */
const qrImage = (text: string) => {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true }),
  )}`;
};

interface Reaction {
  id: number;
  emoji: string;
  left: number;
}

export const PresentationMode = ({
  excalidrawAPI,
  canEdit = false,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  canEdit?: boolean;
}) => {
  const [presentation, setPresentation] = useAtom(presentationAtom);
  const collabAPI = useAtomValue(collabAPIAtom);
  const isCollaborating = useAtomValue(isCollaboratingAtom);
  const spotlight = useAtomValue(spotlightAtom);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [position, setPosition] = useState({ index: 0, step: 0 });
  const [laser, setLaser] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [startedAt, setStartedAt] = useState(0);
  // P4
  const [remote, setRemote] = useState<{
    key: string;
    /** a phone (same login) is connected */
    connected: boolean;
  } | null>(null);
  const [showQr, setShowQr] = useState(false);
  // P6
  const [live, setLive] = useState<{
    hostKey: string;
    id: string;
    started: boolean;
  } | null>(null);
  const [audience, setAudience] = useState(0);
  const [hands, setHands] = useState<{ socketId: string; name: string }[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [liveOpen, setLiveOpen] = useState(false);
  const socket = useRef<Socket | null>(null);
  // for joining again after a lost connection
  const remoteKey = useRef<string | null>(null);
  const liveHostKey = useRef<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const saved = useRef<SavedState | null>(null);
  const startedSpotlight = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const reactionId = useRef(0);

  const { index, step } = position;
  const slide = slides[index] as Slide | undefined;
  const stepsOf = useCallback(
    (target: Slide | undefined) =>
      target ? slideStepCount(excalidrawAPI.getSceneElements(), target) : 0,
    [excalidrawAPI],
  );

  const show = useCallback(
    (target: Slide | undefined) => {
      if (target) {
        excalidrawAPI.setViewport({
          target,
          fit: "contain",
          animation: { duration: 300 },
          offsets: { top: 8, right: 8, bottom: 8, left: 8 },
        });
      }
    },
    [excalidrawAPI],
  );

  /** the static canvas draws again (hidden elements changed) */
  const redraw = useCallback(() => {
    excalidrawAPI.updateScene({
      appState: {
        frameRendering: { ...excalidrawAPI.getAppState().frameRendering },
      },
    });
  }, [excalidrawAPI]);

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
          "Noch keine Folien: Jeder Frame ist eine Folie. Lege eine mit „Neue Folie“ (Alt+A) oder dem Frame-Werkzeug (Taste F) an.",
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
    setPosition({ index: start, step: 0 });
    setStartedAt(Date.now());
    // after the UI is gone, so the slide fills the screen
    window.setTimeout(() => show(all[start]), 60);

    return () => {
      document.body.classList.remove("ws-presenting");
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      setLocallyHiddenElements([]);
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

  // P5: only what this click shows (on this screen)
  useEffect(() => {
    if (!presentation || !slide) {
      return;
    }
    setLocallyHiddenElements(
      hiddenAtStep(excalidrawAPI.getSceneElements(), slide, step),
    );
    redraw();
  }, [presentation, slide, step, excalidrawAPI, redraw]);

  const go = useCallback(
    (nextIndex: number, nextStep = 0) => {
      const target = Math.min(Math.max(nextIndex, 0), slides.length - 1);
      setPosition((current) => {
        if (current.index !== target) {
          show(slides[target]);
        }
        return { index: target, step: nextStep };
      });
    },
    [slides, show],
  );

  /** the next click: the next element group, or the next slide */
  const forward = useCallback(() => {
    if (step < stepsOf(slide)) {
      go(index, step + 1);
    } else if (index < slides.length - 1) {
      go(index + 1, 0);
    }
  }, [go, index, step, slide, slides.length, stepsOf]);

  const backward = useCallback(() => {
    if (step > 0) {
      go(index, step - 1);
    } else if (index > 0) {
      go(index - 1, stepsOf(slides[index - 1]));
    }
  }, [go, index, step, slides, stepsOf]);

  const toggleLaser = useCallback(() => {
    setLaser((on) => {
      excalidrawAPI.setActiveTool({ type: on ? "selection" : "laser" });
      return !on;
    });
  }, [excalidrawAPI]);

  // what the helpers see
  const state = useMemo<PresentingState | null>(() => {
    if (!presentation || !slide) {
      return null;
    }
    const steps = stepsOf(slide);
    const next =
      step < steps
        ? slide
        : index < slides.length - 1
        ? slides[index + 1]
        : null;
    return {
      index,
      count: slides.length,
      step,
      steps,
      title: slideTitle(slide, index),
      notes: slideNotes(slide),
      nextTitle:
        next === slide
          ? `${slideTitle(slide, index)} (nächste Einblendung)`
          : next
          ? slideTitle(next, index + 1)
          : null,
      startedAt,
    };
  }, [presentation, slide, step, index, slides, stepsOf, startedAt]);

  const commands = useRef<(command: PresentingCommand) => void>(() => {});
  commands.current = (command) => {
    if (command.type === "next") {
      forward();
    } else if (command.type === "prev") {
      backward();
    } else if (command.type === "stop") {
      stop();
    } else if (command.type === "hello") {
      sendState.current();
    }
  };

  // P3: the presenter window (same browser, own window)
  const sendWindowState = useCallback(async () => {
    if (!channel.current || !state || !slide) {
      return;
    }
    const version = getSceneVersion(excalidrawAPI.getSceneElements());
    const nextSlide =
      state.step < state.steps
        ? { slide, step: state.step + 1 }
        : state.index < slides.length - 1
        ? { slide: slides[state.index + 1], step: 0 }
        : null;
    const [current, next] = await Promise.all([
      slideImage(excalidrawAPI, slide, state.step, version).catch(() => null),
      nextSlide
        ? slideImage(
            excalidrawAPI,
            nextSlide.slide,
            nextSlide.step,
            version,
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    const message: PresenterWindowState = { ...state, current, next };
    channel.current?.postMessage({ type: "state", state: message });
  }, [excalidrawAPI, slide, slides, state]);

  const openPresenterWindow = () => {
    if (!channel.current) {
      const id = randomKey();
      const opened = new BroadcastChannel(presenterChannelName(id));
      opened.onmessage = (event) => commands.current(event.data);
      channel.current = opened;
      window.open(
        `/presenter#${id}`,
        "excalidraw-presenter",
        "popup=yes,width=1100,height=720",
      );
    } else {
      sendWindowState();
    }
  };

  // P4 and P6: the realtime connection
  /** P6: the current slide for the audience, or for one newcomer */
  const sendLiveState = useRef<(to?: string) => void>(() => {});
  sendLiveState.current = (to) => {
    if (!live || !socket.current || !state || !slide) {
      return;
    }
    const version = getSceneVersion(excalidrawAPI.getSceneElements());
    const hostKey = live.hostKey;
    const started = live.started;
    (started
      ? slideImage(excalidrawAPI, slide, state.step, version).catch(() => null)
      : Promise.resolve(null)
    ).then((image) => {
      // (the server adds who presents)
      const message = {
        started,
        ended: false,
        index: state.index,
        count: state.count,
        title: state.title,
        image,
      };
      if (to) {
        socket.current?.emit("live-state", hostKey, message, to);
      } else {
        socket.current?.emit("live-state", hostKey, message);
      }
    });
  };

  const sendState = useRef<() => void>(() => {});
  sendState.current = () => {
    sendWindowState();
    if (!state) {
      return;
    }
    if (remote && socket.current) {
      socket.current.emit("remote-message", remote.key, {
        type: "state",
        state,
      });
    }
    sendLiveState.current();
  };

  useEffect(() => {
    sendState.current();
  }, [state, live?.started, remote]);

  /** after a lost connection the server knows nothing of us: join again */
  const rejoin = useRef(() => {});
  rejoin.current = () => {
    const connection = socket.current;
    if (!connection) {
      return;
    }
    if (remoteKey.current) {
      connection.emit("remote-join", remoteKey.current);
    }
    if (liveHostKey.current) {
      connection.emit("live-host", liveHostKey.current);
    }
    sendState.current();
  };

  const connect = async () => {
    if (!socket.current) {
      const opened = await openPresentingSocket();
      // the server's own notice: the phone (same login) is there
      opened.on("remote-peer", (notice: { type?: string }) => {
        if (notice?.type === "joined") {
          setRemote((current) =>
            current ? { ...current, connected: true } : current,
          );
          setShowQr(false);
          sendState.current();
        }
      });
      opened.on("remote-message", (message: { type?: string }) => {
        if (
          message?.type === "next" ||
          message?.type === "prev" ||
          message?.type === "hello"
        ) {
          commands.current(message as PresentingCommand);
        }
      });
      opened.on(
        "live-audience",
        (event: {
          type: string;
          socketId?: string;
          name?: string;
          emoji?: string;
          raised?: boolean;
        }) => {
          if (event.type === "joined" && event.socketId) {
            // the newcomer alone, not everyone again
            sendLiveState.current(event.socketId);
          } else if (event.type === "reaction" && event.emoji) {
            const id = ++reactionId.current;
            setReactions((current) => [
              ...current.slice(-30),
              { id, emoji: event.emoji!, left: 10 + Math.random() * 80 },
            ]);
            window.setTimeout(
              () =>
                setReactions((current) =>
                  current.filter((reaction) => reaction.id !== id),
                ),
              3000,
            );
          } else if (event.type === "hand" && event.socketId) {
            setHands((current) =>
              event.raised
                ? [
                    ...current.filter(
                      (hand) => hand.socketId !== event.socketId,
                    ),
                    { socketId: event.socketId!, name: event.name || "" },
                  ]
                : current.filter((hand) => hand.socketId !== event.socketId),
            );
          } else if (event.type === "left" && event.socketId) {
            setHands((current) =>
              current.filter((hand) => hand.socketId !== event.socketId),
            );
          }
        },
      );
      opened.on("connect", () => rejoin.current());
      socket.current = opened;
    }
    return socket.current;
  };

  const startRemote = async () => {
    if (remote) {
      setShowQr(true);
      return;
    }
    try {
      const connection = await connect();
      const key = randomKey();
      const answer = await askServer<{ ok: boolean }>(
        connection,
        "remote-join",
        key,
      );
      if (!answer.ok) {
        throw new Error("Die Fernbedienung ließ sich nicht einrichten.");
      }
      remoteKey.current = key;
      setRemote({ key, connected: false });
      setShowQr(true);
    } catch (error: any) {
      excalidrawAPI.setToast({ message: error.message, closable: true });
    }
  };

  const startLive = async () => {
    setLiveOpen(true);
    if (live) {
      return;
    }
    try {
      const connection = await connect();
      const hostKey = randomKey();
      const answer = await askServer<{ ok: boolean; id?: string }>(
        connection,
        "live-host",
        hostKey,
      );
      if (!answer.ok || !answer.id) {
        throw new Error("Die Live-Präsentation ließ sich nicht starten.");
      }
      liveHostKey.current = hostKey;
      setLive({ hostKey, id: answer.id, started: false });
    } catch (error: any) {
      excalidrawAPI.setToast({ message: error.message, closable: true });
    }
  };

  // P6: how many watch
  useEffect(() => {
    if (!live || !socket.current) {
      return;
    }
    const connection = socket.current;
    const count = () =>
      askServer<{ count: number }>(connection, "live-count", live.hostKey)
        .then((answer) => setAudience(answer.count))
        .catch(() => {});
    count();
    const timer = window.setInterval(count, LIVE_COUNT_MS);
    return () => window.clearInterval(timer);
  }, [live]);

  // everything ends with the presentation
  useEffect(() => {
    if (presentation) {
      return;
    }
    if (live && socket.current) {
      socket.current.emit("live-state", live.hostKey, { ended: true });
    }
    if (socket.current) {
      socket.current.off("remote-peer");
      socket.current.off("remote-message");
      socket.current.off("live-audience");
      socket.current.off("connect");
      socket.current = null;
      closePresentingSocket();
    }
    remoteKey.current = null;
    liveHostKey.current = null;
    if (channel.current) {
      channel.current.postMessage({ type: "ended" });
      channel.current.close();
      channel.current = null;
    }
    setRemote(null);
    setShowQr(false);
    setLive(null);
    setLiveOpen(false);
    setHands([]);
    setReactions([]);
    setAudience(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation]);

  // keys, leaving fullscreen, resizing
  useEffect(() => {
    if (!presentation) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) {
        return;
      }
      const handled = (() => {
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown":
          case "PageDown":
          case " ":
          case "Enter":
            forward();
            return true;
          case "ArrowLeft":
          case "ArrowUp":
          case "PageUp":
          case "Backspace":
            backward();
            return true;
          case "Home":
            go(0, 0);
            return true;
          case "End":
            go(slides.length - 1, 0);
            return true;
          case "Escape":
            if (showQr || liveOpen) {
              setShowQr(false);
              setLiveOpen(false);
            } else {
              stop();
            }
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
  }, [
    presentation,
    index,
    slides,
    go,
    forward,
    backward,
    stop,
    show,
    toggleLaser,
    showQr,
    liveOpen,
  ]);

  // P2: Alt+A adds a slide (not while presenting or typing)
  useEffect(() => {
    if (presentation || !canEdit) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.code !== "KeyA"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable]") ||
        excalidrawAPI.getAppState().editingTextElement ||
        excalidrawAPI.getAppState().viewModeEnabled
      ) {
        return;
      }
      event.preventDefault();
      addSlide(excalidrawAPI, "titleContent");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presentation, canEdit, excalidrawAPI]);

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

  if (!presentation || !slides.length || !slide) {
    return null;
  }

  const spotlightOn = spotlight.presenting;
  const steps = stepsOf(slide);
  const atEnd = index === slides.length - 1 && step >= steps;
  const remoteUrl = remote
    ? `${window.location.origin}/remote#${remote.key}`
    : null;
  const liveUrl = live ? `${window.location.origin}/live/${live.id}` : null;

  return (
    <>
      <div
        className={clsx(
          "ws-theme ws-present",
          !controlsVisible && !showQr && !liveOpen && "is-idle",
        )}
        role="toolbar"
        aria-label="Präsentation"
      >
        <button
          type="button"
          className="ws-present__button"
          aria-label="Zurück"
          disabled={index === 0 && step === 0}
          onClick={backward}
        >
          ‹
        </button>
        <span className="ws-present__counter" aria-live="polite">
          {index + 1} / {slides.length}
          {steps > 0 && (
            <span className="ws-present__steps">
              {" "}
              · {step}/{steps}
            </span>
          )}
          <span className="ws-present__title">{slideTitle(slide, index)}</span>
        </span>
        <button
          type="button"
          className="ws-present__button"
          aria-label="Weiter"
          disabled={atEnd}
          onClick={forward}
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
        <button
          type="button"
          className="ws-present__button"
          title="Notizen, nächste Folie und Zeit in einem zweiten Fenster"
          onClick={openPresenterWindow}
        >
          Referentenansicht
        </button>
        <button
          type="button"
          className={clsx(
            "ws-present__button",
            remote?.connected && "is-active",
          )}
          title="Mit dem Smartphone weiterschalten"
          onClick={startRemote}
        >
          {remote?.connected ? "Fernbedienung an" : "Fernbedienung"}
        </button>
        <button
          type="button"
          className={clsx("ws-present__button", live?.started && "is-active")}
          title="Zuschauende folgen im eigenen Browser"
          onClick={startLive}
        >
          {live ? `Live · ${audience}` : "Live"}
          {hands.length > 0 && ` · ✋ ${hands.length}`}
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
            {spotlightOn
              ? `Spotlight an · ${spotlight.followers}`
              : "Spotlight"}
          </button>
        )}
        <button type="button" className="ws-present__button" onClick={stop}>
          Beenden
        </button>
      </div>

      {showQr && remoteUrl && (
        <div
          className="ws-theme ws-present-panel"
          role="dialog"
          aria-label="Fernbedienung"
        >
          <h2>Mit dem Smartphone weiterschalten</h2>
          <img
            className="ws-present-panel__qr"
            src={qrImage(remoteUrl)}
            alt="QR-Code der Fernbedienung"
          />
          <p className="ws-muted">
            Code mit der Kamera scannen. Das Smartphone muss im Firmennetz oder
            im VPN sein und mit demselben Konto angemeldet wie dieser Rechner;
            andere Konten erreichen die Präsentation nicht.
          </p>
          <input
            className="ws-input"
            readOnly
            value={remoteUrl}
            aria-label="Adresse der Fernbedienung"
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="ws-present__button"
            onClick={() => setShowQr(false)}
          >
            Schließen
          </button>
        </div>
      )}

      {liveOpen && (
        <div
          className="ws-theme ws-present-panel"
          role="dialog"
          aria-label="Live-Präsentation"
        >
          <h2>Live-Präsentation</h2>
          {!live || !liveUrl ? (
            <p className="ws-muted">Wird eingerichtet …</p>
          ) : (
            <>
              <p className="ws-muted">
                Wer diesen Link öffnet (mit Anmeldung), sieht deine Folien im
                eigenen Browser, reagiert mit Emojis und meldet sich per
                Handzeichen. Vor dem Start wartet das Publikum.
              </p>
              <input
                className="ws-input"
                readOnly
                value={liveUrl}
                aria-label="Link für das Publikum"
                onFocus={(event) => event.target.select()}
              />
              <p>
                {audience}{" "}
                {audience === 1 ? "Person schaut" : "Personen schauen"} zu.
              </p>
              {hands.length > 0 && (
                <ul className="ws-present-panel__hands">
                  {hands.map((hand) => (
                    <li key={hand.socketId}>
                      ✋ {hand.name}
                      <button
                        type="button"
                        className="ws-link"
                        onClick={() => {
                          socket.current?.emit(
                            "live-lower-hand",
                            live.hostKey,
                            hand.socketId,
                          );
                          setHands((current) =>
                            current.filter(
                              (item) => item.socketId !== hand.socketId,
                            ),
                          );
                        }}
                      >
                        senken
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="ws-present-panel__actions">
                <button
                  type="button"
                  className={clsx(
                    "ws-present__button",
                    live.started && "is-active",
                  )}
                  onClick={() =>
                    setLive((current) =>
                      current
                        ? { ...current, started: !current.started }
                        : null,
                    )
                  }
                >
                  {live.started
                    ? "Pausieren (Warteraum)"
                    : "Start fürs Publikum"}
                </button>
                <button
                  type="button"
                  className="ws-present__button"
                  onClick={() => setLiveOpen(false)}
                >
                  Schließen
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="ws-present-reactions" aria-hidden="true">
        {reactions.map((reaction) => (
          <span key={reaction.id} style={{ left: `${reaction.left}%` }}>
            {reaction.emoji}
          </span>
        ))}
      </div>
    </>
  );
};
