/**
 * Intranet fork: watching a live presentation (P6, /live/<id>). The
 * presenter's slides in the own browser, as far as revealed; reactions
 * and a raised hand go back to the presenter, with the name from the login.
 * Before the start: a waiting room.
 */
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import "../workspace.scss";

import {
  askServer,
  closePresentingSocket,
  openPresentingSocket,
} from "./presentingSocket";

import type { Socket } from "socket.io-client";

const REACTIONS = ["👍", "👏", "❤️", "😂", "😮", "🎉", "🤔"];

interface LiveState {
  /** which presentation (stamped by the server) */
  liveId?: string;
  started?: boolean;
  ended?: boolean;
  index?: number;
  count?: number;
  title?: string;
  presenter?: string;
  image?: string | null;
}

export const LivePage = ({ liveId }: { liveId: string }) => {
  const [state, setState] = useState<LiveState | null>(null);
  const [status, setStatus] = useState<"connecting" | "ready" | "error">(
    "connecting",
  );
  const [hand, setHand] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const socket = useRef<Socket | null>(null);

  useEffect(() => {
    document.title = "Live-Präsentation";
    let cancelled = false;
    openPresentingSocket()
      .then(async (connection) => {
        if (cancelled) {
          return;
        }
        socket.current = connection;
        connection.on("live-state", (next: LiveState) => {
          // only this presentation's slides
          if (next?.liveId !== liveId) {
            return;
          }
          setState((current) => ({
            ...current,
            ...next,
            // a paused presentation keeps its last slide out of sight
            image: next.started ? next.image ?? current?.image : null,
          }));
        });
        connection.on(
          "live-hand-lowered",
          (event: { socketId?: string } | undefined) => {
            // sent to the whole audience: is it this hand?
            if (event?.socketId === connection.id) {
              setHand(false);
            }
          },
        );
        const join = async () => {
          const answer = await askServer<{ ok: boolean }>(
            connection,
            "live-join",
            liveId,
          );
          setStatus(answer.ok ? "ready" : "error");
        };
        connection.on("connect", () => join().catch(() => setStatus("error")));
        if (connection.connected) {
          await join();
        }
      })
      .catch(() => setStatus("error"));
    return () => {
      cancelled = true;
      socket.current?.off("live-state");
      socket.current?.off("live-hand-lowered");
      closePresentingSocket();
    };
  }, [liveId]);

  const react = (emoji: string) => {
    socket.current?.emit("live-feedback", liveId, { type: "reaction", emoji });
    setSent(emoji);
    window.setTimeout(() => setSent(null), 800);
  };

  const toggleHand = () => {
    socket.current?.emit("live-feedback", liveId, {
      type: "hand",
      raised: !hand,
    });
    setHand(!hand);
  };

  const waiting = !state?.started && !state?.ended;

  return (
    <div className="ws-theme ws-live">
      <header className="ws-live__bar">
        <strong>{state?.title || "Live-Präsentation"}</strong>
        {state?.presenter && (
          <span className="ws-muted">mit {state.presenter}</span>
        )}
        {state?.started && state.count ? (
          <span className="ws-muted">
            Folie {(state.index ?? 0) + 1} von {state.count}
          </span>
        ) : null}
      </header>
      <main className="ws-live__stage">
        {status === "error" ? (
          <p className="ws-live__message">
            Diese Live-Präsentation gibt es nicht (mehr).
          </p>
        ) : state?.ended ? (
          <p className="ws-live__message">Die Präsentation ist beendet.</p>
        ) : waiting ? (
          <p className="ws-live__message">
            Die Präsentation beginnt gleich. Bitte warten …
          </p>
        ) : state?.image ? (
          <img src={state.image} alt={state.title || "Aktuelle Folie"} />
        ) : (
          <p className="ws-live__message">Lade Folie …</p>
        )}
      </main>
      {!state?.ended && status !== "error" && (
        <footer className="ws-live__actions" aria-label="Reaktionen">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={clsx(sent === emoji && "is-sent")}
              aria-label={`Reaktion ${emoji}`}
              onClick={() => react(emoji)}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            className={clsx("ws-live__hand", hand && "is-active")}
            aria-pressed={hand}
            onClick={toggleHand}
          >
            ✋ {hand ? "Hand senken" : "Melden"}
          </button>
        </footer>
      )}
    </div>
  );
};
