/**
 * Intranet fork: the phone remote (P4, /remote#<key>). Opened from the QR
 * code a presentation shows; moves the slides on and shows the notes.
 * Signed in like any page of the app; talks to the presentation through
 * the server's realtime connection.
 */
import { useEffect, useRef, useState } from "react";

import "../workspace.scss";

import { NotesText } from "./PresenterView";
import {
  askServer,
  closePresentingSocket,
  openPresentingSocket,
} from "./presentingSocket";
import { formatDuration } from "./presenting";

import type { PresentingState } from "./presenting";
import type { Socket } from "socket.io-client";

export const RemotePage = ({ remoteKey }: { remoteKey: string }) => {
  const [state, setState] = useState<PresentingState | null>(null);
  const [status, setStatus] = useState<"connecting" | "ready" | "error">(
    "connecting",
  );
  const [now, setNow] = useState(Date.now());
  const socket = useRef<Socket | null>(null);

  useEffect(() => {
    document.title = "Fernbedienung";
    let cancelled = false;
    openPresentingSocket()
      .then(async (connection) => {
        if (cancelled) {
          return;
        }
        socket.current = connection;
        connection.on("remote-message", (message: any) => {
          if (message?.type === "state" && message.state) {
            setState(message.state);
          }
        });
        const join = async () => {
          const answer = await askServer<{ ok: boolean }>(
            connection,
            "remote-join",
            remoteKey,
          );
          setStatus(answer.ok ? "ready" : "error");
          connection.emit("remote-message", remoteKey, { type: "hello" });
        };
        // again after a lost connection (phones sleep)
        connection.on("connect", () => join().catch(() => setStatus("error")));
        if (connection.connected) {
          await join();
        }
      })
      .catch(() => setStatus("error"));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      socket.current?.off("remote-message");
      closePresentingSocket();
    };
  }, [remoteKey]);

  const send = (type: "next" | "prev") => {
    socket.current?.emit("remote-message", remoteKey, { type });
    navigator.vibrate?.(15);
  };

  return (
    <div className="ws-theme ws-remote">
      <header className="ws-remote__bar">
        <strong>Fernbedienung</strong>
        {state && (
          <span>
            {state.index + 1} / {state.count} ·{" "}
            {formatDuration(now - state.startedAt)}
          </span>
        )}
      </header>
      {status === "error" ? (
        <p className="ws-remote__message">
          Keine Verbindung zur Präsentation. Bitte den QR-Code noch einmal
          scannen.
        </p>
      ) : !state ? (
        <p className="ws-remote__message">Verbinde mit der Präsentation …</p>
      ) : (
        <>
          <p className="ws-remote__title">
            {state.title}
            {state.steps > 0 && (
              <span className="ws-muted">
                {" "}
                · Einblendung {state.step}/{state.steps}
              </span>
            )}
          </p>
          {state.nextTitle && (
            <p className="ws-muted">Als Nächstes: {state.nextTitle}</p>
          )}
          <div className="ws-remote__buttons">
            <button
              type="button"
              aria-label="Zurück"
              onClick={() => send("prev")}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Weiter"
              onClick={() => send("next")}
            >
              ›
            </button>
          </div>
          {state.notes && (
            <section className="ws-remote__notes" aria-label="Notizen">
              <NotesText notes={state.notes} />
            </section>
          )}
        </>
      )}
    </div>
  );
};
