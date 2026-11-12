/**
 * Intranet fork: the presenter window (P3, /presenter#<channel>). Opened by
 * the presentation in the same browser; shows the current and the next
 * slide, the speaker notes (links clickable), the time, and moves the
 * presentation on. Talks to it through a BroadcastChannel only.
 */
import { useEffect, useRef, useState } from "react";

import "../workspace.scss";

import { formatDuration, linkParts, presenterChannelName } from "./presenting";

import type { PresenterWindowState, PresentingCommand } from "./presenting";

export const NotesText = ({ notes }: { notes: string }) => (
  <>
    {linkParts(notes).map((part, index) =>
      part.url ? (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {part.text}
        </a>
      ) : (
        <span key={index}>{part.text}</span>
      ),
    )}
  </>
);

export const PresenterView = ({ channelId }: { channelId: string }) => {
  const [state, setState] = useState<PresenterWindowState | null>(null);
  const [ended, setEnded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [timerStart, setTimerStart] = useState<number | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    document.title = "Referentenansicht";
    const opened = new BroadcastChannel(presenterChannelName(channelId));
    opened.onmessage = (event) => {
      if (event.data?.type === "state") {
        setState(event.data.state);
        setEnded(false);
      } else if (event.data?.type === "ended") {
        setEnded(true);
      }
    };
    channel.current = opened;
    const hello: PresentingCommand = { type: "hello" };
    opened.postMessage(hello);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
      opened.close();
    };
  }, [channelId]);

  const send = (command: PresentingCommand) =>
    channel.current?.postMessage(command);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        send({ type: "next" });
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        send({ type: "prev" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const started = timerStart ?? state?.startedAt ?? now;

  return (
    <div className="ws-theme ws-presenter">
      <header className="ws-presenter__bar">
        <strong>
          {state
            ? `Folie ${state.index + 1} von ${state.count}${
                state.steps ? ` · Einblendung ${state.step}/${state.steps}` : ""
              }`
            : "Referentenansicht"}
        </strong>
        <span className="ws-presenter__time" aria-label="Vergangene Zeit">
          {formatDuration(now - started)}
        </span>
        <button
          type="button"
          className="ws-present__button"
          onClick={() => setTimerStart(Date.now())}
        >
          Zeit neu starten
        </button>
        <span className="ws-muted">
          {new Date(now).toLocaleTimeString("de-DE", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </header>
      {ended ? (
        <p className="ws-presenter__empty">
          Die Präsentation ist beendet. Dieses Fenster kann zu.
        </p>
      ) : !state ? (
        <p className="ws-presenter__empty">
          Warte auf die Präsentation … (im Fenster der Präsentation auf
          „Referentenansicht“ klicken)
        </p>
      ) : (
        <main className="ws-presenter__main">
          <section
            className="ws-presenter__current"
            aria-label="Aktuelle Folie"
          >
            {state.current ? (
              <img src={state.current} alt={state.title} />
            ) : (
              <p>{state.title}</p>
            )}
          </section>
          <aside className="ws-presenter__side">
            <section aria-label="Als Nächstes">
              <h2>Als Nächstes</h2>
              {state.next ? (
                <img src={state.next} alt={state.nextTitle || ""} />
              ) : (
                <p className="ws-muted">Ende der Präsentation</p>
              )}
              {state.nextTitle && <p className="ws-muted">{state.nextTitle}</p>}
            </section>
            <section className="ws-presenter__notes" aria-label="Notizen">
              <h2>Notizen</h2>
              {state.notes ? (
                <p>
                  <NotesText notes={state.notes} />
                </p>
              ) : (
                <p className="ws-muted">Keine Notizen zu dieser Folie.</p>
              )}
            </section>
            <div className="ws-presenter__controls">
              <button
                type="button"
                className="ws-present__button"
                onClick={() => send({ type: "prev" })}
              >
                ‹ Zurück
              </button>
              <button
                type="button"
                className="ws-present__button"
                onClick={() => send({ type: "next" })}
              >
                Weiter ›
              </button>
              <button
                type="button"
                className="ws-present__button"
                onClick={() => send({ type: "stop" })}
              >
                Beenden
              </button>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
};
