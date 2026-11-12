/**
 * Intranet fork: notifications (Z3). A bell with the number of unread
 * notifications; the list opens below it, with the e-mail settings.
 * Used in the dashboard and in the editor.
 */
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";

import { BackendError, backendFetch } from "../intranet/api";
import { onNotificationsChanged } from "../intranet/sceneRoom";
import { scenePath } from "../intranet/routes";

import { Button, Notice, formatRelative } from "./ui";

interface NotificationItem {
  id: string;
  type: "mention" | "reply" | "share";
  at: string;
  read: boolean;
  text: string;
  sceneId: string | null;
  collectionId: string | null;
  threadId: string | null;
  available: boolean;
}

interface Preferences {
  emailAvailable: boolean;
  email: { mention: boolean; reply: boolean; share: boolean };
}

const POLL_MS = 60 * 1000;

const json = async <T,>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `Fehler ${response.status}`;
    try {
      message = (await response.json()).message || message;
    } catch {
      // keep the generic message
    }
    throw new BackendError(response.status, message);
  }
  return response.json() as Promise<T>;
};

const post = (path: string, method: string, body: unknown) =>
  backendFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const bellIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path
      d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20a2 2 0 0 0 4 0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

const EMAIL_LABELS: [keyof Preferences["email"], string][] = [
  ["mention", "wenn mich jemand erwähnt"],
  ["reply", "bei Antworten in meinen Kommentaren"],
  ["share", "wenn jemand etwas mit mir teilt"],
];

const targetOf = (item: NotificationItem) =>
  item.sceneId
    ? `${scenePath(item.sceneId)}${
        item.threadId ? `?thread=${item.threadId}` : ""
      }`
    : item.collectionId
    ? `/?c=${encodeURIComponent(item.collectionId)}`
    : "/";

export const NotificationBell = ({
  className,
  openSettings = false,
}: {
  className?: string;
  /** open with the e-mail settings (link from an e-mail) */
  openSettings?: boolean;
}) => {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(openSettings);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [showSettings, setShowSettings] = useState(openSettings);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    try {
      const result = await json<{ unread: number }>(
        await backendFetch("/api/notifications/unread"),
      );
      setUnread(result.unread);
    } catch {
      // the badge is a convenience
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const result = await json<{
        unread: number;
        notifications: NotificationItem[];
      }>(await backendFetch("/api/notifications"));
      setItems(result.notifications);
      setUnread(result.unread);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refreshCount();
    const poll = () => {
      if (document.visibilityState === "visible") {
        refreshCount();
      }
    };
    const timer = window.setInterval(poll, POLL_MS);
    const unsubscribe = onNotificationsChanged(() => {
      refreshCount();
      if (open) {
        loadList();
      }
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [refreshCount, loadList, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    loadList();
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, loadList]);

  useEffect(() => {
    if (!open || preferences) {
      return;
    }
    backendFetch("/api/notifications/preferences")
      .then((response) => json<Preferences>(response))
      .then(setPreferences)
      .catch(() => {});
  }, [open, preferences]);

  const markRead = async (ids: string[] | "all") => {
    try {
      const result = await json<{ unread: number }>(
        await post(
          "/api/notifications/read",
          "POST",
          ids === "all" ? { all: true } : { ids },
        ),
      );
      setUnread(result.unread);
      setItems(
        (current) =>
          current?.map((item) =>
            ids === "all" || ids.includes(item.id)
              ? { ...item, read: true }
              : item,
          ) || null,
      );
    } catch (err: any) {
      setError(err.message);
    }
  };

  const setEmail = async (key: keyof Preferences["email"], value: boolean) => {
    if (!preferences) {
      return;
    }
    try {
      setPreferences(
        await json<Preferences>(
          await post("/api/notifications/preferences", "PUT", {
            email: { [key]: value },
          }),
        ),
      );
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className={clsx("ws-theme ws-bell", className)} ref={rootRef}>
      <button
        type="button"
        className={clsx("ws-bell__button", open && "is-active")}
        aria-label={`Benachrichtigungen${
          unread ? ` (${unread} ungelesen)` : ""
        }`}
        aria-expanded={open}
        title="Benachrichtigungen"
        onClick={() => setOpen(!open)}
      >
        {bellIcon}
        {unread > 0 && (
          <span className="ws-bell__count">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {open && (
        <div
          className="ws-bell__panel"
          role="dialog"
          aria-label="Benachrichtigungen"
        >
          <div className="ws-bell__head">
            <strong>Benachrichtigungen</strong>
            {unread > 0 && (
              <button
                type="button"
                className="ws-link-button"
                onClick={() => markRead("all")}
              >
                Alle gelesen
              </button>
            )}
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          {items === null ? (
            <p className="ws-muted">Lade …</p>
          ) : items.length === 0 ? (
            <p className="ws-muted ws-bell__empty">
              Noch nichts. Hier erscheint, wenn dich jemand erwähnt, dir
              antwortet oder etwas mit dir teilt.
            </p>
          ) : (
            <ul className="ws-bell__list">
              {items.map((item) => (
                <li key={item.id}>
                  <a
                    className={clsx("ws-bell__item", !item.read && "is-unread")}
                    href={item.available ? targetOf(item) : undefined}
                    onClick={() => {
                      if (!item.read) {
                        markRead([item.id]);
                      }
                    }}
                  >
                    <span className="ws-bell__text">{item.text}</span>
                    <span className="ws-bell__time">
                      {formatRelative(item.at)}
                      {!item.available && " · nicht mehr verfügbar"}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="ws-bell__foot">
            <button
              type="button"
              className="ws-link-button"
              aria-expanded={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            >
              E-Mail-Benachrichtigungen
            </button>
            {showSettings &&
              (preferences === null ? (
                <p className="ws-muted">Lade …</p>
              ) : !preferences.emailAvailable ? (
                <p className="ws-muted">
                  E-Mails sind hier nicht eingerichtet oder dein Konto hat keine
                  E-Mail-Adresse.
                </p>
              ) : (
                <div className="ws-bell__settings">
                  <span className="ws-muted">Per E-Mail, wenn ungelesen:</span>
                  {EMAIL_LABELS.map(([key, label]) => (
                    <label key={key} className="ws-toggle">
                      <input
                        type="checkbox"
                        checked={preferences.email[key]}
                        onChange={(event) =>
                          setEmail(key, event.target.checked)
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              ))}
          </div>
          <div className="ws-bell__close">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Schließen
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
