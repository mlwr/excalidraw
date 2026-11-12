/**
 * Intranet fork: comments on workspace scenes (Z2). Pins on the canvas that
 * follow scrolling, zooming and the element they belong to; a popover per
 * thread; a list of all threads. Rendered as a child of <Excalidraw>, so it
 * lies above the canvas and below the editor's toolbars.
 */
import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { useAtom } from "../../app-jotai";
import { onCommentsChanged } from "../../intranet/sceneRoom";
import { workspaceApi } from "../../intranet/workspaceApi";
import { Avatar, Button, Notice, formatRelative } from "../ui";

import {
  commentPlacingAtom,
  commentThreadsAtom,
  commentsPanelOpenAtom,
  openThreadIdAtom,
} from "./commentsState";

import "./comments.scss";

import type {
  CommentInfo,
  CommentThread,
  OpenedScene,
} from "../../intranet/workspaceApi";

const REFRESH_INTERVAL_MS = 60 * 1000;
const POPOVER_WIDTH = 320;
const POPOVER_MARGIN = 12;

/** what can carry a comment pin (lines and arrows are too thin to aim at) */
const ANCHOR_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "image",
  "frame",
  "magicframe",
  "stickynote",
  "embeddable",
  "iframe",
]);

interface ElementBox {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  containerId?: string | null;
}

interface Point {
  x: number;
  y: number;
}

interface Draft extends Point {
  /** pinned to this element; x/y then relative to its top left corner */
  elementId: string | null;
  offsetX: number;
  offsetY: number;
}

/** the topmost element under a point of the scene */
const elementAt = (elements: readonly ElementBox[], point: Point) => {
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i];
    if (
      ANCHOR_TYPES.has(element.type) &&
      point.x >= element.x &&
      point.x <= element.x + element.width &&
      point.y >= element.y &&
      point.y <= element.y + element.height
    ) {
      return element.type === "text" && element.containerId
        ? elements.find((other) => other.id === element.containerId) || element
        : element;
    }
  }
  return null;
};

const Composer = ({
  placeholder,
  submitLabel,
  initial = "",
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  initial?: string;
  autoFocus?: boolean;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
}) => {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim() || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ws-comment-composer">
      <textarea
        className="ws-input"
        rows={3}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        maxLength={5000}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape" && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="ws-comment-composer__actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
        <Button
          variant="primary"
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};

const CommentEntry = ({
  comment,
  onChanged,
}: {
  comment: CommentInfo;
  onChanged: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="ws-comment">
      <div className="ws-comment__head">
        {comment.author && (
          <Avatar id={comment.author.id} name={comment.author.name} />
        )}
        <span className="ws-comment__author">
          {comment.author?.name || "Unbekannt"}
        </span>
        <span
          className="ws-muted"
          title={new Date(comment.createdAt).toLocaleString("de-DE")}
        >
          {formatRelative(comment.createdAt)}
          {comment.editedAt && " · bearbeitet"}
        </span>
      </div>
      {editing ? (
        <Composer
          placeholder="Kommentar"
          submitLabel="Speichern"
          initial={comment.text}
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={async (text) => {
            await workspaceApi.editComment(comment.id, text);
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <p className="ws-comment__text">{comment.text}</p>
      )}
      {!editing && (comment.canEdit || comment.canDelete) && (
        <div className="ws-comment__actions">
          {comment.canEdit && (
            <button
              type="button"
              className="ws-link"
              onClick={() => setEditing(true)}
            >
              Bearbeiten
            </button>
          )}
          {comment.canDelete && (
            <button
              type="button"
              className="ws-link"
              onClick={async () => {
                try {
                  await workspaceApi.deleteComment(comment.id);
                  onChanged();
                } catch (err: any) {
                  setError(err.message);
                }
              }}
            >
              Löschen
            </button>
          )}
        </div>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </li>
  );
};

const ThreadView = ({
  thread,
  onChanged,
  onClose,
}: {
  thread: CommentThread;
  onChanged: () => void;
  onClose: () => void;
}) => {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="ws-thread">
      <div className="ws-thread__head">
        <span className="ws-thread__title">
          {thread.resolved ? "Erledigt" : "Kommentar"}
        </span>
        {thread.canResolve && (
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                await workspaceApi.resolveThread(thread.id, !thread.resolved);
                onChanged();
              } catch (err: any) {
                setError(err.message);
              }
            }}
          >
            {thread.resolved ? "Wieder öffnen" : "Erledigt"}
          </Button>
        )}
        <button
          type="button"
          className="ws-dialog__close"
          aria-label="Schließen"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <ul className="ws-thread__comments">
        {thread.comments.map((comment) => (
          <CommentEntry
            key={comment.id}
            comment={comment}
            onChanged={onChanged}
          />
        ))}
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      <Composer
        placeholder="Antworten …"
        submitLabel="Antworten"
        onSubmit={async (text) => {
          await workspaceApi.replyToThread(thread.id, { text });
          onChanged();
        }}
      />
    </div>
  );
};

export const CommentsLayer = ({ scene }: { scene: OpenedScene }) => {
  const api = useExcalidrawAPI();
  const layerRef = useRef<HTMLDivElement>(null);
  const [threads, setThreads] = useAtom(commentThreadsAtom);
  const [panelOpen, setPanelOpen] = useAtom(commentsPanelOpenAtom);
  const [placing, setPlacing] = useAtom(commentPlacingAtom);
  const [openId, setOpenId] = useAtom(openThreadIdAtom);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [error, setError] = useState<string | null>(null);
  // re-render when the canvas scrolls, zooms or changes
  const [, setFrame] = useState(0);

  const load = useCallback(
    () =>
      workspaceApi
        .comments(scene.id)
        .then((result) => {
          setThreads(result.threads);
          setError(null);
        })
        .catch((err) => setError(err.message)),
    [scene.id, setThreads],
  );

  // a link from a notification: /s/<id>?thread=<threadId>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const thread = params.get("thread");
    if (thread && /^[0-9a-f-]{36}$/i.test(thread)) {
      setPanelOpen(true);
      setOpenId(thread);
      params.delete("thread");
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${
          window.location.hash
        }`,
      );
    }
  }, [setPanelOpen, setOpenId]);

  useEffect(() => {
    load();
    const unsubscribe = onCommentsChanged(load);
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!api) {
      return;
    }
    let pending = 0;
    const schedule = () => {
      if (!pending) {
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          setFrame((frame) => frame + 1);
        });
      }
    };
    const offScroll = api.onScrollChange(schedule);
    const offChange = api.onChange(schedule);
    return () => {
      offScroll();
      offChange();
      window.cancelAnimationFrame(pending);
    };
  }, [api]);

  useEffect(() => {
    if (!placing) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPlacing(false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [placing, setPlacing]);

  if (!api) {
    return null;
  }

  const appState = api.getAppState();
  const zoom = appState.zoom.value;
  const elements = api.getSceneElements() as unknown as readonly ElementBox[];
  const byId = new Map(elements.map((element) => [element.id, element]));

  const toScreen = (point: Point) => ({
    left: (point.x + appState.scrollX) * zoom,
    top: (point.y + appState.scrollY) * zoom,
  });

  /** where a thread is in the scene; null if its element is gone */
  const positionOf = (thread: CommentThread): Point | null => {
    if (!thread.elementId) {
      return { x: thread.x, y: thread.y };
    }
    const element = byId.get(thread.elementId);
    return element
      ? { x: element.x + thread.x, y: element.y + thread.y }
      : null;
  };

  const popoverStyle = (point: Point | null) => {
    if (!point) {
      return { right: 340, top: 72 };
    }
    const { left, top } = toScreen(point);
    const maxLeft = appState.width - POPOVER_WIDTH - POPOVER_MARGIN;
    return {
      left: Math.max(
        POPOVER_MARGIN,
        left + 24 > maxLeft ? left - POPOVER_WIDTH - 12 : left + 24,
      ),
      top: Math.min(Math.max(POPOVER_MARGIN, top - 16), appState.height - 260),
    };
  };

  const focusThread = (thread: CommentThread) => {
    const point = positionOf(thread);
    if (point) {
      api.updateScene({
        appState: {
          scrollX: appState.width / 2 / zoom - point.x,
          scrollY: appState.height / 2 / zoom - point.y,
        },
      });
    }
    setDraft(null);
    setOpenId(thread.id);
  };

  const place = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = layerRef.current!.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / zoom - appState.scrollX,
      y: (event.clientY - rect.top) / zoom - appState.scrollY,
    };
    const element = elementAt(elements, point);
    setPlacing(false);
    setOpenId(null);
    setDraft({
      ...point,
      elementId: element?.id || null,
      offsetX: element ? point.x - element.x : point.x,
      offsetY: element ? point.y - element.y : point.y,
    });
  };

  const visible = (threads || []).filter((thread) =>
    filter === "open" ? !thread.resolved : thread.resolved,
  );
  const openThread = threads?.find((thread) => thread.id === openId) || null;

  return (
    <div
      ref={layerRef}
      className={clsx("ws-theme ws-comments-layer", placing && "is-placing")}
      onPointerDown={placing ? place : undefined}
    >
      {placing && (
        <div className="ws-comments-hint" role="status">
          Klicke auf die Stelle, die du kommentieren möchtest · Esc bricht ab
        </div>
      )}

      {(threads || [])
        .filter((thread) => !thread.resolved || thread.id === openId)
        .map((thread) => {
          const point = positionOf(thread);
          if (!point) {
            return null;
          }
          const { left, top } = toScreen(point);
          const author = thread.comments[0]?.author;
          return (
            <button
              key={thread.id}
              type="button"
              className={clsx(
                "ws-comment-pin",
                thread.id === openId && "is-open",
                thread.resolved && "is-resolved",
              )}
              style={{ left, top }}
              title={thread.comments[0]?.text.slice(0, 120)}
              aria-label={`Kommentar von ${author?.name || "Unbekannt"}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => {
                setDraft(null);
                setOpenId(thread.id === openId ? null : thread.id);
              }}
            >
              {author ? <Avatar id={author.id} name={author.name} /> : "?"}
              {thread.comments.length > 1 && (
                <span className="ws-comment-pin__count">
                  {thread.comments.length}
                </span>
              )}
            </button>
          );
        })}

      {draft && (
        <div
          className="ws-comment-popover"
          style={popoverStyle(draft)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Composer
            placeholder="Kommentar schreiben …"
            submitLabel="Kommentieren"
            autoFocus
            onCancel={() => setDraft(null)}
            onSubmit={async (text) => {
              const { thread } = await workspaceApi.createThread(scene.id, {
                x: draft.offsetX,
                y: draft.offsetY,
                elementId: draft.elementId,
                text,
              });
              setDraft(null);
              await load();
              setOpenId(thread.id);
            }}
          />
          <p className="ws-muted ws-comment-popover__hint">
            Strg+Enter sendet
            {draft.elementId && " · hängt am Element darunter"}
          </p>
        </div>
      )}

      {openThread && !draft && (
        <div
          className="ws-comment-popover"
          style={popoverStyle(positionOf(openThread))}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ThreadView
            thread={openThread}
            onChanged={load}
            onClose={() => setOpenId(null)}
          />
        </div>
      )}

      {panelOpen && (
        <aside
          className="ws-comments-panel"
          aria-label="Kommentare"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="ws-comments-panel__head">
            <h2>Kommentare</h2>
            <button
              type="button"
              className="ws-dialog__close"
              aria-label="Kommentare schließen"
              onClick={() => setPanelOpen(false)}
            >
              ×
            </button>
          </div>
          <Button
            variant="primary"
            className="ws-comments-panel__new"
            onClick={() => {
              setOpenId(null);
              setDraft(null);
              setPlacing(true);
            }}
          >
            Kommentar hinzufügen
          </Button>
          <div className="ws-tabs" role="tablist">
            {(["open", "resolved"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={clsx("ws-tab", filter === value && "is-active")}
                onClick={() => setFilter(value)}
              >
                {value === "open" ? "Offen" : "Erledigt"} (
                {
                  (threads || []).filter((thread) =>
                    value === "open" ? !thread.resolved : thread.resolved,
                  ).length
                }
                )
              </button>
            ))}
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {threads && !visible.length && (
            <p className="ws-muted">
              {filter === "open"
                ? "Keine offenen Kommentare."
                : "Noch nichts erledigt."}
            </p>
          )}
          <ul className="ws-comments-panel__list">
            {visible.map((thread) => {
              const first = thread.comments[0];
              return (
                <li key={thread.id}>
                  <button
                    type="button"
                    className={clsx(
                      "ws-comments-panel__item",
                      thread.id === openId && "is-active",
                    )}
                    onClick={() => focusThread(thread)}
                  >
                    <span className="ws-comments-panel__meta">
                      {first?.author?.name || "Unbekannt"} ·{" "}
                      {formatRelative(thread.updatedAt)}
                      {thread.comments.length > 1 &&
                        ` · ${thread.comments.length - 1} Antwort${
                          thread.comments.length > 2 ? "en" : ""
                        }`}
                    </span>
                    <span className="ws-comments-panel__text">
                      {first?.text}
                    </span>
                    {!positionOf(thread) && (
                      <span className="ws-muted">Element gelöscht</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}
    </div>
  );
};
